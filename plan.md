# plan.md — AI App-Builder ("Lovable-style") — Reverse-Engineering Findings + From-Scratch Architecture + Phased Build

> Hand this to an implementer (human or agent) and it builds the whole system phase by phase.

---

## Context — why this plan exists

Goal: build an AI app-builder like Lovable.dev. A user describes an app in plain language,
the system generates the code, shows a live sandboxed preview, lets the user iterate through
chat with undo/version history, and pushes the result to GitHub.

Two inputs shaped this plan:

1. **Reverse-engineering of `/Applications/Lovable.app`** (v1.10.2) — to learn what Lovable
   actually does and, more importantly, what it does *not* do client-side. See Part A.
2. **Fresh 2025–2026 research** on sandboxes, LLM edit-application, version history, the
   three orchestration CLIs, and current Claude models. Folded into Part B/C.

Four load-bearing decisions were made up front (locked with the requester):

- **Preview sandbox:** server-side Firecracker microVMs (what Lovable/v0/Replit use), not
  browser WebContainers.
- **Generated-app stack:** React + Vite + Tailwind + shadcn/ui + Supabase (Lovable's output
  shape — fastest to preview, best LLM coverage).
- **Codegen engine:** Claude **Opus 4.8** (`claude-opus-4-8`) via the Anthropic API as the
  planner + hard-reasoning + diff engine; **opencode / kiro-cli / qoder** run headless as
  cheaper parallel workers for routine/bulk edits.
- **Plan depth:** phased MVP → full, implementation-ready.

---

# PART A — Reverse-engineering of Lovable.app

Method: extracted `Contents/Resources/app.asar` (31 MB, Electron), read `dist/main.js`,
`dist/preload.js`, `package.json`, strings, and the `connected-computer/` native helpers.

## A.1 Top-level finding — the desktop app is a thin shell

Lovable desktop is **not** where codegen, preview, or GitHub export happen. It is an Electron
wrapper around a **remote web SPA served from `https://lovable.dev`** (dev override:
`http://localhost:3000` via `LOVABLE_DESKTOP_START_URL`). All the product logic lives in the
web app + backend. The desktop shell only adds OS-native capabilities.

**Security posture of the shell:** `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. Renderer talks to main only through a `contextBridge` preload
(`window.lovableDesktop`). Origin allow-list enforced on trust boundaries (`lovable.dev`,
`api.lovable.dev`, `lovableproject.com`, `sandcastle.lovable.net`, etc.).

## A.2 Process architecture (what each layer does)

- **Main process** (`dist/main.js`): window lifecycle, auto-update (`electron-updater` ←
  `https://downloads.lovable.dev/desktop`), Sentry crash reporting, OAuth, a WebSocket proxy
  (`appWS`), and a local-MCP subsystem.
- **Preload** (`dist/preload.js`): exposes `window.lovableDesktop` with namespaces:
  `auth` (`start`/`cancel`/`onResult`), `appWS` (`setAuthToken`/`send`/`onMessage`/
  `onStatusChange`), `localMcp` (`addServer`/`connectCatalog`/`getSnapshot`/…),
  `connectedComputer` (macOS), `previewPermissions`, `quickChat`, `dictation`, `annotate`,
  `openExternal`, `runConnectorOAuth`.
- **Renderer**: the remote SPA. Does the chat UI, file tree, preview iframe.

## A.3 Auth flow (observed)

Browser-based OAuth → **deep-link callback** → Bearer token:
1. `lovableDesktop.auth.start()` opens the system browser to the OAuth page.
2. Callback returns via custom URL scheme; main process emits `desktop-auth:result`.
3. Token handed to the WebSocket bridge: `appWS.setAuthToken(token)`.
4. All API/WS calls carry `Authorization: Bearer <token>` + an `x-lov-platform` header
   (JSON: bundleId `dev.lovable.desktop`, version, os, arch, deviceModel).
5. Connector OAuth (GitHub etc.) runs through `runConnectorOAuth(config)` — backend-driven.

## A.4 Network / backend surface

- `api.lovable.dev` — primary backend. File ops via signed-S3 upload URLs
  (`/files/generate-upload-url`, `/projects/{id}/files/generate-upload-url`), `/app/config`
  (version/upgrade gating), and **MCP endpoints** (`POST/GET/DELETE /mcp`, SSE stream).
- S3 for file storage; Sentry for telemetry; `downloads.lovable.dev` for updates.
- **Codegen is backend-side.** No Claude API keys in the client; OpenTelemetry enums for
  `GEN_AI_PROVIDER … ANTHROPIC` present. Prompts go to the backend, which calls the LLM.
- **Preview is backend-side.** No `webcontainer`/`stackblitz`/`e2b`/`docker` strings in the
  client. (External research: Lovable runs generated apps on **Fly.io Firecracker microVMs**,
  with **Supabase** as the generated app's backend.)
- **GitHub export is backend-side**, via connector OAuth + server push.

## A.5 Notable extras (not core to our builder)

- **`connected-computer/`**: native Mach-O arm64 daemon pair (`cua-driver` 38 MB,
  `lovable-computer-helper`) — a **computer-use automation** agent, driven over a binary
  **protobuf WebSocket** (`@bufbuild/protobuf`, `@lovable/applocal-mcp`, protocol v2, 25 s
  heartbeat). This is Lovable's desktop differentiator, not something our MVP needs.
- **local-MCP**: lets the desktop connect local MCP servers (Node/Python tools) into the
  agent. A later-phase extensibility idea, not MVP.

## A.6 What we copy vs. skip

| Copy | Skip (for MVP) |
|---|---|
| Web SPA + backend split; codegen/preview/export all server-side | Electron desktop shell |
| OAuth → bearer token; connector OAuth for GitHub | connected-computer / computer-use daemon |
| Per-project server sandbox (microVM) running the real dev server | binary protobuf WS (use JSON/SSE) |
| Signed-URL file storage; Supabase as the generated app's backend | local-MCP catalog (later phase) |
| Snapshot-per-chat-turn version history | native dictation/annotation |

---

# PART B — Target architecture (from scratch)

## B.1 System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web client (Next.js SPA)                                              │
│   chat pane │ file tree │ preview iframe │ version timeline            │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ HTTPS + SSE/WS                  │ iframe src (proxied)
                ▼                                 ▼
┌───────────────────────────────┐     ┌──────────────────────────────────┐
│  Builder API (Node/TS)        │     │  Preview proxy / gateway          │
│   auth, projects, chat,       │     │   routes *.preview.ourhost →       │
│   snapshots, GitHub export    │     │   per-project sandbox dev server  │
└───────┬───────────────┬───────┘     └──────────────┬───────────────────┘
        │               │                            │
        ▼               ▼                            ▼
┌───────────────┐  ┌──────────────────────┐   ┌───────────────────────────┐
│ Postgres      │  │  Codegen Orchestrator │   │  Sandbox fleet            │
│ (Supabase/Neon)│ │   (engine router)     │   │   E2B/Fly Firecracker     │
│ users,projects,│ │   ├ Opus 4.8 (API)    │   │   microVM per project:    │
│ messages,      │ │   ├ opencode (CLI)    │   │   files + git + Vite dev  │
│ snapshots,     │ │   ├ kiro-cli (CLI)    │   │   server + Supabase link  │
│ repo links     │ │   └ qoder  (CLI)      │   │                           │
└───────────────┘  └──────────┬────────────┘   └───────────────────────────┘
                              │ reads/writes files, runs build/lint/test
                              └──────────────▶ (into the project sandbox)
```

## B.2 Tech stack (the builder platform itself)

| Layer | Choice | Why / tradeoff |
|---|---|---|
| Web client | **Next.js (App Router) + TS + Tailwind + shadcn/ui** | One framework for UI; SSR for marketing/app pages. Tradeoff: SPA-heavy app sections — fine. |
| Realtime | **SSE for agent token/stream events; WS only if bidirectional steering needed** | SSE is simpler, proxy-friendly (matches Lovable's `/mcp` SSE). WS adds ops cost. |
| Builder API | **Node/TS** — Next route handlers for CRUD + a **separate long-running worker service** for codegen/sandbox orchestration | Codegen turns run minutes (Opus 4.8 long turns) — must not live in request handlers. |
| DB | **Postgres (Supabase or Neon)** | Relational fits projects/messages/snapshots. Supabase also gives us auth + storage if we want one vendor. |
| Object storage | **S3-compatible** (Supabase Storage / R2) | Signed-URL uploads like Lovable. |
| Sandbox | **E2B (primary) or Fly.io Machines** — Firecracker microVMs | Full Node fidelity, real dev server, per-tenant isolation. E2B: fast create (~150–700 ms) + **pause/resume with memory** → cheap idle. Fly: strong persistent state. Tradeoff: pay per runtime-second + cold-start. |
| Generated-app stack | **Vite + React + Tailwind + shadcn/ui + Supabase** | Fastest HMR preview; LLMs write it reliably; no server runtime for the generated app (Supabase is its backend). Tradeoff: SPA-only, weaker SEO. |
| LLM | **Claude Opus 4.8** (`claude-opus-4-8`) core; **Sonnet 4.6** (`claude-sonnet-4-6`) + CLI workers for cheap/bulk | Opus 4.8: 1M context, 128K output, best coding. Sonnet/CLIs cut cost at scale. |
| Auth | **OAuth (GitHub) + email**, cookie/JWT sessions | GitHub login doubles as the export-token source. |

## B.3 Subsystem designs + tradeoffs

### B.3.1 LLM codegen loop (prompt → diff → file tree)

Flow per user turn:

1. **Assemble context (prompt-cached).** System prompt + project conventions + **file tree**
   + the handful of files relevant to the request, placed at the cache prefix. Volatile user
   message goes last. (Prefix-match caching: any byte change upstream invalidates downstream —
   keep the tree/system frozen at the front. Reads ≈ 0.1× input price.)
2. **Plan + edit with Opus 4.8** using the **native text-editor tool**
   (`type: "text_editor_20250728"`, `name: "str_replace_based_edit_tool"` — both fields must
   match or the API 400s; `undo_edit` removed on Claude 4+). Config: `thinking:{type:"adaptive"}`,
   `output_config:{effort:"xhigh"}`, **stream** (max_tokens up to 128K requires streaming).
   Do **not** send `budget_tokens`/`temperature`/`top_p`/`top_k` → 400 on Opus 4.8.
3. **Edit-format strategy** (research-backed):
   - New file or file < ~400 lines → **whole-file write**.
   - Larger file → **search/replace** via `str_replace` (text-match, not line numbers — avoids
     the unified-diff line-arithmetic failure mode that cut aider's score from 59%→26%).
   - Bulk scaffold / many-file boilerplate → **delegate to a CLI worker** (Phase 7).
   - Optional later: a **fast-apply model** (Morph/Relace, ~10k tok/s) as the merge layer when
     the frontier model emits lazy `// ... existing code ...` edits.
4. **Transactional apply + self-heal.** Apply the edit batch to the sandbox FS, then run
   `build` / `tsc --noEmit` / `eslint`. Use git as the transaction layer: `git add -A` the
   turn → run checks → **commit on success**, `git reset --hard` on failure. On failure, feed
   the error output back to Opus (bounded retry, e.g. ≤3) before surfacing to the user.
5. **Parse tool inputs with `JSON.parse`, never raw string-match** (4.x may escape
   Unicode/slashes differently).

Tradeoffs: whole-file is simplest/most reliable but token-heavy (~3,200 vs ~150 tok for a
5-line change); search/replace is cheap but needs a fuzzy-match cascade for near-misses; git
transactions cost a commit per turn but give free rollback and history (B.3.3).

### B.3.2 Sandboxed live preview

- **One microVM per project.** On project open: create (or resume) the sandbox, sync files,
  `npm install` (cached in the VM image / resumed memory), `npm run dev` (Vite).
- **Preview delivery:** expose the Vite port; a **preview gateway** maps
  `https://<project>.preview.ourhost` → the sandbox dev server; the client embeds that in an
  iframe. Vite **HMR** gives near-instant updates after each edit — no full redeploy per turn.
- **Lifecycle/cost:** pause the VM on idle (E2B pause keeps memory; resume is sub-second),
  hard-stop after N minutes idle. Cap per-user concurrent sandboxes.
- **Isolation:** Firecracker microVM per tenant; no shared kernel; locked-down egress.

Tradeoffs vs browser WebContainers: microVMs cost per-second and have cold-start, but run any
backend, give a real terminal/DB, and avoid WebContainers' commercial license + no-Safari
limits. (Browser runtime remains a future option for an instant, zero-compute preview tier.)

### B.3.3 Chat-driven iteration + undo / version history

- **Snapshot per chat turn** (Lovable/bolt pattern). Each successful turn = one git commit in
  the project repo **plus** a `snapshots` row (`message_id`, `commit_sha`, summary). The DB row
  is the fast-undo index; git holds the content.
- **Undo/restore:** "restore to version N" = `git reset --hard <sha>` in the sandbox + sync
  the FS + resync preview. Keep forward history (don't destroy later snapshots — allow redo /
  branch-on-edit).
- **No CRDT.** CRDTs only matter for real-time multi-user co-editing — out of scope for
  single-user AI-edit undo.

Tradeoff: per-turn commits grow history; prune/squash policy later if needed.

### B.3.4 Auth, project storage, GitHub export

- **Auth:** GitHub OAuth + email; sessions via secure cookie/JWT. (If a desktop shell is ever
  added, reuse Lovable's deep-link pattern; web MVP uses standard redirect.)
- **Storage:** Postgres for metadata; project file content lives in the sandbox + git; a
  canonical tar/snapshot is persisted to object storage so a project survives sandbox GC and
  can be rehydrated into a fresh VM.
- **GitHub export:** a **GitHub App** (preferred) or OAuth token (encrypted at rest per user)
  → create repo → push the project git → optionally open a PR. Token obtained via the same
  connector-OAuth flow Lovable uses.

### B.3.5 Orchestration engine (Opus 4.8 core + opencode/kiro/qoder workers)

Define one interface and route by task class:

```ts
interface CodegenEngine {
  name: "opus" | "opencode" | "kiro" | "qoder";
  run(task: CodegenTask): AsyncIterable<EngineEvent>; // streams edits + logs
}
```

- **OpusEngine** — Anthropic API, text-editor tool-use loop, planning + hard edits + self-heal.
  The default and the only engine for architecture/ambiguous/risky changes.
- **OpencodeEngine** — `opencode run "<prompt>" --model <provider/model> --format json`
  (one JSON object per line → easy to parse). Best-documented headless contract of the three.
- **KiroEngine** — `kiro-cli chat --no-interactive "<prompt>"`, auth via `KIRO_API_KEY`,
  `--trust-tools` to pre-approve, `--require-mcp-startup` fail-fast.
- **QoderEngine** — qoder headless mode (CI/daemon). Confirm its machine-readable output
  format against current docs before wiring the parser.

**Router policy:** Opus 4.8 produces the **plan** (task list). Each task is tagged
`hard` (reasoning/cross-file/risky) → Opus, or `routine/bulk` (scaffold, repetitive edits,
independent files) → fan out across opencode/kiro/qoder in parallel. All engines write into
the same project sandbox; every engine's batch goes through the **same git transaction +
self-heal gate** (B.3.1) so quality is uniform regardless of who wrote the code.

Tradeoff: a multi-engine adapter + normalized event schema is extra work, but it cuts cost at
scale and enables parallel fan-out. Engines whose headless JSON contract is unstable get
wrapped defensively (treat stdout as best-effort, rely on the git gate for correctness).

---

# PART C — Phased build plan (implementation-ready)

Each phase: **Goal · Deliverables/files · Data & APIs · Acceptance criteria.** Phases are
ordered so each is demoable. Target the MVP at Phases 0–6; 7–8 scale it up.

## Phase 0 — Foundations & scaffold
- **Goal:** running monorepo, builder web app shell, DB, auth skeleton, CI.
- **Deliverables:** monorepo (`apps/web` Next.js, `apps/api` worker service, `packages/shared`
  types). Tailwind + shadcn/ui. Postgres via Supabase/Neon with migrations. Lint/format/CI.
- **UI (foundations, applies to all later phases):** design tokens (color/type/spacing scale,
  light+dark) in the Tailwind theme; base shadcn component set; app shell + landing page; a
  **shared state convention every screen implements** — `loading` / `streaming` / `empty` /
  `error` / `success`; toast + inline-error patterns; **a11y baseline** (keyboard nav, focus
  rings, labelled controls, respects `prefers-reduced-motion`); mobile-first responsive.
- **Data & APIs:** `users` table; health endpoint; session middleware stub.
- **Acceptance:** `dev` runs web + api; landing page renders in light+dark and on mobile;
  tokens + base components documented; CI green.

## Phase 1 — Projects, file store, git snapshots
- **Goal:** create/list projects; persist a file tree; per-turn git snapshots (no AI yet).
- **Deliverables:** project CRUD UI + file-tree viewer; a seed template (Vite+React+Tailwind+
  shadcn) committed as the project's initial git state; object-storage tar snapshot on save.
- **UI:** dashboard/project-list (grid of cards; empty state = "create first project" CTA;
  loading skeletons); create-project dialog (name + template picker); **the 3-pane builder
  shell** (left: chat; center: preview; right: file tree) with resizable/collapsible panels;
  file-tree component with folder expand/collapse + read-only code viewer; mobile = tabbed
  single-pane. States: empty tree, large-tree virtualization, file-load error.
- **Data & APIs:** `projects(id,user_id,name,sandbox_id,repo_url,created_at)`,
  `snapshots(id,project_id,message_id,commit_sha,summary,created_at)`. `POST /projects`,
  `GET /projects/:id`, `POST /projects/:id/snapshot`.
- **Acceptance:** create a project from the template; see its files; a snapshot row + git
  commit are produced; project rehydrates from object storage into a clean checkout.

## Phase 2 — Codegen loop v1 (Opus 4.8, single engine)
- **Goal:** prompt → file edits → committed snapshot, with self-heal. No live preview yet
  (verify by reading files + build logs).
- **Deliverables:** OpusEngine (API client, `claude-opus-4-8`, adaptive thinking, `effort:
  xhigh`, streaming, text-editor tool loop). Context assembler with **prompt caching** of
  system prompt + file tree. Edit-format selector (whole-file < ~400 lines, else `str_replace`).
  Git transaction + build/tsc/eslint self-heal (≤3 retries).
- **UI:** chat pane — message list (user/assistant bubbles), composer with submit + stop;
  **live streaming render** of agent tokens/thinking-summary; per-turn activity log (files
  touched, build/lint result) as collapsible steps; **diff view** for each edited file
  (before/after); build-error panel when self-heal runs. States: streaming (stoppable),
  retry-in-progress, turn-failed (show error + "retry"), empty chat (prompt suggestions).
- **Data & APIs:** `messages(id,project_id,role,content,engine,created_at)`;
  `POST /projects/:id/messages` → streams `EngineEvent`s over SSE.
- **Acceptance:** "add a pricing section" edits the right files, build passes, a snapshot is
  committed; a deliberately-breaking request triggers the self-heal retry and either fixes or
  reports cleanly; `cache_read_input_tokens` > 0 on the second turn (caching works).

## Phase 3 — Sandbox + live preview
- **Goal:** real microVM per project running Vite; preview in an iframe with HMR.
- **Deliverables:** sandbox provider adapter (E2B primary; Fly alt behind the same interface);
  file-sync (builder FS ⇄ sandbox); `npm install` + `npm run dev`; **preview gateway**
  (`<project>.preview.host` → sandbox port); pause-on-idle + resume.
- **UI:** center preview pane = iframe with toolbar (reload, open-in-new-tab, responsive
  width presets: mobile/tablet/desktop); build-log/console drawer; overlay states —
  booting/installing (spinner + log), building, **runtime-error overlay** (parsed from the
  dev server), paused ("resume" button), crashed ("restart"). Preview updates in place via
  HMR with a subtle "updated" pulse.
- **Data & APIs:** `projects.sandbox_id`; `POST /projects/:id/sandbox/{start,stop}`;
  gateway route. EngineEvents also stream sandbox/build logs.
- **Acceptance:** after a codegen turn, the iframe updates within seconds via HMR; closing the
  project pauses the VM; reopening resumes < ~1 s; two projects are isolated.

## Phase 4 — Chat iteration + version history + undo
- **Goal:** full chat loop with a version timeline and one-click restore.
- **Deliverables:** chat pane bound to `messages`; version timeline bound to `snapshots`;
  "Restore" = `git reset --hard <sha>` + FS sync + preview resync; redo/branch-on-edit kept.
- **UI:** version timeline (list of snapshots w/ summary + timestamp, current marked); each
  entry has preview-at-version + "Restore" with a confirm dialog; branch indicator when a new
  edit forks from an old version; diff-vs-current on hover/click. States: restoring (disable
  input + progress), restore-failed, single-version (nothing to restore).
- **Data & APIs:** `POST /projects/:id/restore {commit_sha}`; timeline read endpoint.
- **Acceptance:** iterate 3+ turns, restore to turn 1, preview reflects turn 1; make a new
  edit from there → a new branch/snapshot (no lost history).

## Phase 5 — Auth, storage & persistence hardening
- **Goal:** production auth + durable projects.
- **Deliverables:** GitHub OAuth + email login; per-user project scoping/authorization;
  signed-URL uploads for user assets; project rehydration from object storage verified.
- **UI:** login/signup screens (GitHub button + email form); session-aware header (avatar,
  menu, logout); auth-gated routes with redirect; asset-upload control (drag-drop + progress +
  thumbnail); "connect GitHub" prompt. States: signing-in, auth-error, upload-progress/failed,
  unauthorized redirect.
- **Data & APIs:** sessions; `files/generate-upload-url`; RLS/authorization checks.
- **Acceptance:** two users can't see each other's projects; a project survives sandbox GC and
  reopens correctly; uploaded images appear in the generated app.

## Phase 6 — GitHub export
- **Goal:** push a project to the user's GitHub.
- **Deliverables:** GitHub App (or OAuth) connector; encrypted token storage; create-repo +
  push project git; optional open-PR; "Export to GitHub" UI.
- **UI:** export dialog (repo name, public/private, first-push vs update); connect-GitHub
  step if no token; progress (creating repo → pushing) + success w/ repo link; "already
  linked" badge on the project. States: not-connected, exporting, export-failed, success.
- **Data & APIs:** `repo_links(project_id,provider,repo_url,installation_id)`;
  `POST /projects/:id/export/github`.
- **Acceptance:** click export → a new GitHub repo contains the project history; a second
  export pushes an update (or PR) without duplicating.

## Phase 7 — Orchestration engine (CLI workers + router)
- **Goal:** Opus plans; routine/bulk tasks fan out to opencode/kiro/qoder in parallel.
- **Deliverables:** `CodegenEngine` interface; OpencodeEngine (`--format json`), KiroEngine
  (`--no-interactive`), QoderEngine (headless); a planner step (Opus emits tagged task list);
  a router (`hard`→Opus, `routine/bulk`→CLI pool); normalized `EngineEvent` schema; every
  engine routed through the shared git+self-heal gate.
- **UI:** engine-attribution badge on each activity step (which engine wrote it); planner task
  list rendered as live checklist (queued → running → done/failed per task); parallel workers
  shown as concurrent rows. States: planning, workers-running (per-task progress), worker-failed
  (fell back to Opus — shown, not hidden).
- **Data & APIs:** `messages.engine` records who did each task; per-engine config/secrets.
- **Acceptance:** a multi-file scaffold request runs several CLI workers concurrently, all
  edits pass the same build gate and land in one snapshot; disabling a CLI falls back to Opus
  with no correctness change; measured cost per multi-file turn drops vs Opus-only.

## Phase 8 — Hardening (security, cost, scale, observability)
- **Goal:** safe + affordable at load.
- **Deliverables:** sandbox egress lock-down + resource quotas; per-user concurrency + rate
  limits; token/compute budget caps per turn (consider `output_config.task_budget`, beta, min
  20k); prompt-cache hit monitoring; Sentry + OpenTelemetry (mirror Lovable's telemetry);
  abuse/prompt-injection guards on generated code; snapshot pruning policy.
- **UI:** usage/cost meter (tokens + sandbox minutes) per project; rate-limit + budget-cap
  states ("limit reached — upgrade/wait"); global error boundary + friendly fatal screen;
  sandbox-quota-exceeded and session-expired handling. Final a11y + responsive audit pass
  across all screens.
- **Acceptance:** load test N concurrent projects within budget; a runaway codegen loop is
  capped; dashboards show cache-hit rate, cost/turn, sandbox utilization; a red-team prompt
  can't exfiltrate secrets from a sandbox.

---

## Verification (end-to-end, per milestone)

- **Codegen loop:** scripted prompts (`add X`, `change Y`, `break then fix`) asserting edited
  files, passing build, committed snapshot, and non-zero cache reads on repeat turns.
- **Preview:** drive a browser, submit a prompt, assert the iframe DOM updates and console has
  no errors.
- **Undo:** multi-turn restore test (Phase 4 acceptance) automated.
- **Export:** integration test against a throwaway GitHub org repo.
- **Orchestration:** golden-task set run through each engine; diff outputs; confirm the git
  gate rejects bad batches regardless of engine.
- **Cost/perf:** track tokens, cache-read ratio, and sandbox seconds per turn against budgets.

## Key risks / watch-items

- **Opus 4.8 API specifics** (locked): `claude-opus-4-8`, adaptive thinking, `effort:xhigh`,
  streaming for large output, `str_replace_based_edit_tool` (name+type must match), **no**
  `budget_tokens`/sampling params (400). Parse tool inputs with `JSON.parse`.
- **Sandbox cost** is the main variable cost — pause-on-idle + concurrency caps are not
  optional. Vendor cold-start/latency numbers are claims; benchmark on real workloads.
- **CLI headless contracts:** opencode's JSON-per-line is solid; **verify kiro-cli and qoder
  machine-readable output against current docs** before trusting a parser — fall back to the
  git gate for correctness.
- **WebContainers** remains a viable *future* instant/zero-compute preview tier if desired;
  note its commercial license + no-Safari constraints before adopting.

> Begin implementation at Phase 0.
