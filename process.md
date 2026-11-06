# How This Project Works — End-to-End Process

This document explains the full runtime process of the AI Website Builder: what happens from the moment a user types a prompt, how the database stores state, and how the preview "sandbox" runs. It reflects the **actual code** in this repo (not just the roadmap in `plan.md`).

> **TL;DR on Docker:** This project does **not** use Docker yet. The live preview runs each generated app as a **local Node child process** (`npm install` + `npm run dev`). Containerization (Firecracker microVMs via E2B/Fly) is the planned next step — see [§7](#7-docker--containerization).

---

## 1. The big picture

Three deployable pieces plus a database:

```
┌──────────────────────────────┐     SSE / HTTPS      ┌──────────────────────────────┐
│  Web client (apps/web)        │ ──────────────────▶ │  Builder API (apps/api)       │
│  Next.js 16 · React 19 · TW4  │ ◀────────────────── │  Hono on Node · TypeScript    │
│  chat · files · preview · log │                     │                               │
└──────────────┬────────────────┘                     └───────┬───────────────┬───────┘
               │ iframe src = http://localhost:<port>         │               │
               ▼                                              ▼               ▼
┌──────────────────────────────┐              ┌──────────────────┐  ┌──────────────────┐
│  Preview (generated app)      │              │  Postgres        │  │  Local workspace  │
│  Vite dev server, HMR         │◀─ spawns ──  │  (Drizzle ORM)   │  │  + git + .tar     │
│  child process per project    │              │  users/projects/ │  │  apps/api/.data   │
└──────────────────────────────┘              │  messages/snap   │  └──────────────────┘
                                               └──────────────────┘
```

- **`apps/web`** — the UI. Three panes: chat, file tree + version history, and the live preview iframe. Talks to the API over HTTP and consumes **Server-Sent Events (SSE)** for streaming agent output.
- **`apps/api`** — a [Hono](https://hono.dev) server (`apps/api/src/index.ts`) that owns everything: project CRUD, the codegen turn loop, self-heal checks, git snapshots, and the sandbox lifecycle.
- **`packages/shared`** — shared TypeScript types (`@aab/shared`) used by both sides (e.g. `EngineEvent`, `Sandbox`, `Project`).
- **Postgres** — metadata (users, projects, chat messages, snapshots). Actual file content lives on disk + git, not in the DB.

The API mounts three route groups, all under `/projects` (`apps/api/src/index.ts`):

| Router | File | Responsibility |
|---|---|---|
| `projectsApp` | `projects/routes.ts` | Create/list projects, read files, snapshots, timeline, restore |
| `engineApp` | `engine/routes.ts` | Chat turns → codegen → self-heal → snapshot (SSE) |
| `sandboxRoutes` | `sandbox/routes.ts` | Start/stop the preview, status, stream logs (SSE) |

---

## 2. Creating a project

`POST /projects` (handled in `projects/routes.ts` → `workspace.ts: createFromTemplate`):

1. A new UUID is generated for the project.
2. The seed template `apps/api/templates/vite-react` is copied into a fresh workspace at **`apps/api/.data/projects/<projectId>/`**.
3. `git init` + `git add -A` + an initial commit (`chore: seed vite-react`) run in that workspace, under a fixed git identity (`AI App Builder <builder@localhost>`). **git is the transaction + history layer** for everything that follows.
4. A `projects` row is inserted into Postgres (id, name, template).

So every project is: **a directory on disk, that is its own git repo, with a row in the DB pointing at it.**

---

## 3. The codegen turn — the heart of the system

When the user sends a chat message, the client calls `POST /projects/:id/messages` and opens an **SSE stream**. The server drives one full "turn" and streams events back (`engine/routes.ts`). The wire format is literally `data: <JSON EngineEvent>\n\n` (see `engine/sse.ts`).

### 3.1 Concurrency guard

A per-project **lock** (`withProjectLock`) ensures only one turn runs per project at a time — the workspace is a single git checkout, so concurrent turns would interleave edits. Different projects run in parallel.

### 3.2 Step-by-step

```
user message
   │
   ▼
[1] persist user message + placeholder assistant row  (DB)
   │   emit: turn_start
   ▼
[2] build context: system prompt + file tree + relevant files   (engine/context.ts)
   │
   ▼
[3] run the chosen engine  (engine/index.ts → opus | gemini | openai | qoder)
   │   streams: text_delta, thinking_delta, tool edits applied to the workspace
   │
   ▼
[4] self-heal checks  (engine/selfheal.ts)
   │   npm install (if needed) → npm run build (tsc) → tsc --noEmit → eslint
   │   emit: check_start, check_result ...
   │
   ├─ checks PASS ──▶ [5] git commit + snapshot row + .tar to storage
   │                        emit: snapshot, turn_done(ok:true)
   │
   └─ checks FAIL ──▶ feed the failure text back to the engine, retry
                            (up to MAX_RETRIES = 3)
                       exhausted ─▶ git reset --hard, emit error + turn_done(ok:false)
```

### 3.3 The engine router

`engine/index.ts` picks an engine per turn. All engines share one signature `runEngine({ projectId, messages, onEvent })` and stream edits the same way:

| Engine | File | Backing |
|---|---|---|
| `opus` (default) | `engine/opus.ts` | Anthropic Claude, native text-editor tool loop |
| `gemini` | `engine/gemini.ts` | Google Gemini |
| `openai` | `engine/openai.ts` | OpenAI GPT |
| `qoder` | `engine/qoder.ts` | Qoder CLI agent (headless, uses your `qoder login`) |

The engine is chosen from the request body, falling back to `DEFAULT_ENGINE` env, then `opus`. API keys come from env (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`) — see the README "where keys are stored" section.

**How edits are applied (Opus example, `opus.ts`):** Opus is given the `str_replace_based_edit_tool`. It runs a tool loop (up to `MAX_TOOL_ROUNDS`): the model emits `create`/`str_replace` tool calls, the server executes them directly against files in the workspace dir, returns tool results, and repeats until the model answers with plain text. Prompt caching keeps the system prompt + file tree at the cache prefix (`cache_read_input_tokens` is logged each round).

### 3.4 Self-heal (the quality gate)

After the engine finishes editing, `selfheal.ts: runChecks` runs **inside the workspace**:

1. `npm install` — only when `node_modules` is missing.
2. `npm run build` — which runs `tsc`.
3. `tsc --noEmit` — standalone type check.
4. `eslint` — only if the project has eslint.

Each emits a `check_result` event. If all pass, the turn commits. If a check fails, the **failure output is appended as a new user message and the engine is asked to fix it** — bounded retry (`MAX_RETRIES = 3`). If `npm install` itself fails, that's treated as non-fatal and the work is still committed (never lose edits).

### 3.5 Commit = snapshot

On success (`engine/routes.ts`):

- `git add -A` + commit in the workspace → a **commit SHA**.
- A `snapshots` row is inserted: `{ projectId, messageId, commitSha, summary }`.
- A **tar** of the whole workspace (including `.git`) is written to storage (`storage/index.ts`) at `apps/api/.data/snapshots/<projectId>/<sha>.tar`.
- `emit: snapshot` → the UI's version timeline gains an entry.

This is the **undo index**: the DB row is the fast lookup, git holds the content, the tar is the durable backup.

---

## 4. Version history & restore

- `GET /projects/:id/timeline` / `/snapshots` — list the snapshot rows.
- `POST /projects/:id/restore` — `git reset --hard <sha>` in the workspace (`workspace.ts: resetHardTo`). Because the restore targets a commit **by SHA**, later history isn't destroyed — you can move back and forward. Vite HMR picks up the restored files automatically if the preview is running.

---

## 5. How the database works

### 5.1 Stack

- **Postgres** (Supabase/Neon compatible or local).
- **[Drizzle ORM](https://orm.drizzle.team)** with the `postgres-js` driver.
- Schema lives in code: `apps/api/src/db/schema.ts`. Migrations in `apps/api/drizzle/`.

### 5.2 Connection (lazy)

`apps/api/src/db/client.ts` creates the DB handle **lazily** on first use:

```ts
export function getDb() {
  if (!_db) {
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const sql = postgres(connectionString);
    _db = drizzle(sql, { schema });
  }
  return _db;
}
```

This is deliberate: the API (and `/health`, and even the sandbox) can boot **without** a database. Only routes that actually read/write data require `DATABASE_URL`. Several places catch DB errors and continue (e.g. persisting a sandbox port is best-effort).

### 5.3 Tables (`schema.ts`)

| Table | Key columns | Purpose |
|---|---|---|
| `users` | `id` (uuid PK), `email` (unique), `created_at` | Baseline user record |
| `projects` | `id` (uuid PK), `user_id`, `name`, `template`, `repo_url`, `sandbox_id`, `created_at` | One row per project; `sandbox_id` stores the current preview port |
| `messages` | `id` (uuid PK), `project_id` → projects, `role`, `content`, `engine`, `created_at` | Chat history; drives the codegen loop |
| `snapshots` | `id` (uuid PK), `project_id` → projects, `message_id`, `commit_sha`, `summary`, `created_at` | Version-history index (points at a git commit + tar) |

`messages` and `snapshots` reference `projects` with `ON DELETE CASCADE`, so deleting a project cleans up its history.

**Important boundary:** the database stores **metadata only**. Generated source code is **not** in Postgres — it lives on disk in the git workspace (`.data/projects/...`) and in snapshot tars (`.data/snapshots/...`).

### 5.4 Migrations

Managed with `drizzle-kit` (`apps/api/drizzle.config.ts`):

```bash
pnpm --filter @aab/api db:generate   # diff schema.ts → new SQL migration
pnpm --filter @aab/api db:migrate    # apply migrations to DATABASE_URL
```

Migration SQL and snapshots are checked in under `apps/api/drizzle/` (e.g. `0000_*.sql`, `0001_*.sql`, plus `meta/`).

---

## 6. How the preview sandbox works

File: `apps/api/src/sandbox/local.ts` (`LocalSandboxProvider`). This is behind a `SandboxProvider` interface (`sandbox/provider.ts`) so it can be swapped for a remote provider later.

### 6.1 Lifecycle

`POST /projects/:id/sandbox/start` →

1. **Allocate a free port** in a range (`SANDBOX_PORT_MIN`–`SANDBOX_PORT_MAX`, default 4100–4299).
2. **`npm install`** in the project workspace (as a detached child process; streamed to logs) — status `installing`.
3. **`npm run dev`** (Vite) as a detached child process bound to the chosen port — status `starting`.
4. **Wait for the port to accept connections** (`SANDBOX_START_TIMEOUT_MS`, default 30s). Once Vite is listening → status `running`, `previewUrl = http://localhost:<port>`.
5. The port is persisted to `projects.sandbox_id` (best-effort; works without a DB).

The web client simply sets the preview **iframe `src`** to that URL. Because the workspace is already local, there's no file-sync step — Vite **HMR** reflects codegen edits instantly.

- `GET /projects/:id/sandbox` — current status snapshot.
- `GET /projects/:id/sandbox/logs` — **SSE** stream of stdout/stderr (kept in a ring buffer, `SANDBOX_LOG_LINES`, default 500).
- `POST /projects/:id/sandbox/stop` — kills the process group.

### 6.2 Process management details

- Children are spawned **detached** so the server can kill the **whole process group** (`process.kill(-pid)`) and reap Vite's workers instead of orphaning them.
- **Idle auto-stop:** a timer (`SANDBOX_IDLE_MS`, default 10 min) stops the sandbox after inactivity; the timer is `unref`'d so it never keeps the API alive on its own.
- **Graceful cleanup:** `exit` / `SIGTERM` / `SIGINT` handlers kill all running sandbox children before the API process dies.

### 6.3 Env knobs

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_PORT_MIN` / `SANDBOX_PORT_MAX` | 4100 / 4299 | Port range for preview servers |
| `SANDBOX_START_TIMEOUT_MS` | 30000 | Max wait for Vite to listen |
| `SANDBOX_IDLE_MS` | 600000 | Auto-stop after inactivity (0 = never) |
| `SANDBOX_LOG_LINES` | 500 | Per-project log ring-buffer size |

---

## 7. Docker / containerization

**Current state: there is no Docker in this repo.** There is no `Dockerfile`, no `docker-compose.yml`, and no container runtime calls in the code. The preview runs as a plain **local child process** (§6), which means:

- ✅ Simple, fast, full Node fidelity, instant HMR.
- ⚠️ **Weak isolation** — generated apps run on the host with the same user. Fine for local/single-user development; **not** safe for untrusted multi-tenant use.

### 7.1 The planned path (from `plan.md`)

The architecture is intentionally designed to drop in real isolation **without changing routes**, because the sandbox sits behind the `SandboxProvider` interface:

```ts
// apps/api/src/sandbox/provider.ts
interface SandboxProvider {
  start(projectId): Promise<Sandbox>;
  stop(projectId): Promise<void>;
  status(projectId): Sandbox;
  // logs via SSE
}
```

The roadmap replaces `LocalSandboxProvider` with a **remote microVM provider**:

- **Firecracker microVMs** via **E2B** (primary) or **Fly.io Machines** — one microVM per project, with a real dev server, git, and locked-down egress. (This is what Lovable/v0/Replit use.)
- A **preview gateway** maps `https://<project>.preview.ourhost` → the microVM's dev server (instead of `http://localhost:<port>`), so previews work remotely and per-tenant.
- The self-heal `npm install` + build/lint checks (currently run on the host in `selfheal.ts`) move **inside** the sandbox.

### 7.2 If you want Docker today

Docker is a reasonable **intermediate** isolation step before microVMs. You would:

1. Add a `Dockerfile` for the generated-app runtime (Node + the Vite template deps).
2. Implement a `DockerSandboxProvider implements SandboxProvider` that `docker run`s a container per project, mounts/sync the workspace, maps the Vite port, and streams `docker logs` into the existing SSE log channel.
3. Point the route wiring at the new provider — no changes needed in `engine/` or `projects/`.

You could also add a root `docker-compose.yml` to run **Postgres + API + web** together for local dev; that's orthogonal to the preview sandbox and would just standardize the dev environment.

---

## 8. Storage & durability

`apps/api/src/storage/index.ts` (`LocalStorageAdapter`, behind a `StorageAdapter` interface):

- `putTar(key, dir)` — tars a workspace (including `.git`) to `apps/api/.data/snapshots/<projectId>/<sha>.tar`.
- `getTar(key, destDir)` — extracts it back (used to **rehydrate** a project into a fresh workspace; see `scripts/rehydrate.ts`).

The interface is S3-ready: an S3/R2 adapter with signed-URL upload/download can replace the local one with no route changes.

---

## 9. Auth (current stub)

`apps/api/src/middleware/session.ts` is a **stub**. It reads a `Bearer` token and attaches an opaque `user` to the request context — **no verification, no DB lookup, no crypto yet**. Real auth (GitHub OAuth + email sessions) is a later phase. CORS currently reflects the single web origin (`WEB_ORIGIN`, default `http://localhost:3000`).

---

## 10. Data & directory map

```
apps/api/.data/
├── projects/<projectId>/        # live git workspace (the generated app)
│   ├── .git/                     # per-project history (every turn = a commit)
│   ├── src/ …                    # generated source
│   └── package.json …
└── snapshots/<projectId>/
    └── <sha>.tar                 # durable backup per snapshot (incl. .git)

Postgres
├── users
├── projects      (→ points at .data/projects/<id>, stores preview port)
├── messages      (chat history, drives codegen)
└── snapshots     (→ points at a commit sha + tar)
```

- **DB** = fast, queryable index of *what exists* and *what happened*.
- **git workspace** = the *current* content + full local history.
- **tar snapshots** = durable, rehydratable backups.
- **preview** = a live Vite process rendering the current content.

---

## 11. End-to-end example

1. User creates a project → template copied, `git init`, DB row inserted.
2. User clicks "Start preview" → `npm install` + `npm run dev`, iframe points at `http://localhost:4123`.
3. User: *"Add a pricing section."* → `POST /messages` opens SSE.
4. Server locks the project, saves the message, builds context, streams **Opus** editing `Pricing.tsx` + `App.tsx` live into the workspace.
5. Self-heal runs `tsc` + `eslint` → pass.
6. Server commits, inserts a `snapshots` row, tars the workspace, emits `snapshot` + `turn_done`.
7. Vite HMR instantly re-renders the new pricing section in the preview iframe.
8. User doesn't like it → `POST /restore` to the previous SHA → `git reset --hard` → preview updates.
