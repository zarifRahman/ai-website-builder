# AI Website Builder

> Describe a website in plain language — the AI generates the code, shows a **live sandboxed preview**, lets you iterate through chat with full **undo / version history**, and pushes the result to GitHub.

A "Lovable-style" AI app builder, built from scratch as a TypeScript monorepo. A user types what they want, an LLM codegen engine plans and writes a real **Vite + React + Tailwind** project, each turn runs through type-check / lint / self-heal, and the output renders instantly in a sandboxed preview.

![AI Website Builder — chat, file tree, version history, and live preview](docs/screenshot.svg)

> The image above is a UI mockup of the three-pane builder. Replace `docs/screenshot.svg` with a real capture of your running instance once it's up.

---

## ✨ Features

- **Prompt-to-app codegen** — describe an app, get a working Vite + React + Tailwind project.
- **Pluggable codegen engines** — Claude **Opus**, **Gemini**, **OpenAI (GPT)**, and the **Qoder** CLI agent, behind one `CodegenEngine` interface. Switch with `DEFAULT_ENGINE`.
- **Live sandboxed preview** — each project runs a real dev server; the client embeds it in an iframe with hot updates after every edit.
- **Chat-driven iteration** — keep refining in natural language; the agent edits the right files, not the whole repo.
- **Version history & undo** — every successful turn is a snapshot (git commit + DB row). Restore to any point with one click.
- **Transactional self-heal** — edits are staged, then `tsc --noEmit` + `eslint` run; failures are fed back to the model (bounded retry) before a commit.
- **Streaming UX** — agent tokens, activity log, and file diffs stream to the UI over **SSE**.
- **GitHub export** — push the generated project to a repo.

---

## 🏗️ Architecture

A **pnpm + TypeScript monorepo** with a Next.js web client, a Hono API, and a shared types package.

```
┌─────────────────────────────────────────────────────────────┐
│  Web client — Next.js (App Router) + React 19 + Tailwind 4   │
│   chat pane │ file tree │ preview iframe │ version timeline   │
└───────────────┬─────────────────────────────┬────────────────┘
                │ HTTPS + SSE                   │ iframe (proxied)
                ▼                               ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│  Builder API — Hono / Node    │   │  Sandbox provider         │
│   projects · chat · engine ·  │   │   files + git + dev       │
│   snapshots · sandbox routes  │   │   server per project      │
└──────────┬─────────────┬──────┘   └──────────────────────────┘
           │             │
           ▼             ▼
   ┌──────────────┐  ┌──────────────────────────────┐
   │ Postgres     │  │  Codegen engine router        │
   │ (Drizzle ORM)│  │   Opus · Gemini · OpenAI ·    │
   │ users,       │  │   Qoder (CLI) — streams edits │
   │ projects,    │  │   + runs build/lint/self-heal │
   │ snapshots    │  └──────────────────────────────┘
   └──────────────┘
```

### Tech stack

| Layer | Choice |
|---|---|
| Web client | Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript |
| Builder API | Hono on Node (`@hono/node-server`), TypeScript, ESM |
| Database | Postgres (Supabase/Neon compatible) via **Drizzle ORM** + drizzle-kit migrations |
| Codegen | Anthropic (Opus), Google Gemini, OpenAI, Qoder CLI — unified engine interface |
| Realtime | Server-Sent Events (SSE) for agent streams and sandbox logs |
| Generated app | Vite + React + Tailwind template (`apps/api/templates/vite-react`) |
| Tooling | pnpm workspaces, ESLint 9, Prettier, tsc |

---

## 📂 Repository layout

```
.
├── apps/
│   ├── api/                 # Hono API — codegen, projects, sandbox, snapshots
│   │   ├── src/
│   │   │   ├── engine/      # engine router: opus, gemini, openai, qoder, selfheal, sse
│   │   │   ├── projects/    # project CRUD, workspace, snapshots/timeline
│   │   │   ├── sandbox/     # local sandbox provider, ports, logs (SSE)
│   │   │   ├── db/          # Drizzle client + schema
│   │   │   ├── storage/     # project file persistence
│   │   │   └── index.ts     # app entry + routes
│   │   ├── drizzle/         # SQL migrations + meta
│   │   └── templates/       # vite-react starter used for new projects
│   └── web/                 # Next.js client
│       └── src/
│           ├── app/         # routes: home (projects), projects/[id] (builder)
│           ├── components/  # builder shell, chat, files, history, preview, ui
│           └── lib/         # API client + utils
├── packages/
│   └── shared/              # shared TypeScript types (@aab/shared)
├── plan.md                  # full architecture & phased build plan
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## 🔌 API surface

Base: `http://localhost:4000`

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/me` | Current session user |
| `GET` | `/projects` | List projects |
| `POST` | `/projects` | Create a project (scaffolds from the Vite template) |
| `GET` | `/projects/:id` | Project detail |
| `GET` | `/projects/:id/files` | File tree |
| `GET` | `/projects/:id/files/content` | Read a file's content |
| `POST` | `/projects/:id/messages` | Send a chat turn → streams agent edits (SSE) |
| `GET` | `/projects/:id/messages` | Conversation history |
| `POST` | `/projects/:id/snapshot` | Create a version snapshot |
| `GET` | `/projects/:id/snapshots` | List snapshots |
| `GET` | `/projects/:id/timeline` | Version timeline |
| `POST` | `/projects/:id/restore` | Restore to a snapshot |
| `POST` | `/projects/:id/sandbox/start` | Start the preview dev server |
| `POST` | `/projects/:id/sandbox/stop` | Stop the sandbox |
| `GET` | `/projects/:id/sandbox` | Sandbox status |
| `GET` | `/projects/:id/sandbox/logs` | Stream sandbox logs (SSE) |

---

## 🚀 Getting started

### Prerequisites

- **Node.js ≥ 20** (see `.nvmrc`)
- **pnpm 9** (`corepack enable`)
- A **Postgres** database (Supabase, Neon, or local)
- At least one codegen API key (Anthropic / Gemini / OpenAI) — or the Qoder CLI

### 1. Install

```bash
pnpm install
```

### 2. Configure the API

```bash
cp apps/api/.env.example apps/api/.env
```

Then fill in `apps/api/.env`:

```ini
DATABASE_URL=postgres://user:pass@host:5432/db   # Supabase/Neon connection string
PORT=4000

# Pick at least one engine
ANTHROPIC_API_KEY=            # Claude (Opus) — default engine
GEMINI_API_KEY=              # Google Gemini
OPENAI_API_KEY=              # OpenAI (GPT)

# DEFAULT_ENGINE=opus        # opus | gemini | openai | qoder
```

### 3. Run migrations

```bash
pnpm --filter @aab/api db:migrate
```

### 4. Start dev servers

```bash
pnpm dev
```

- Web → http://localhost:3000
- API → http://localhost:4000

Create a project, describe your website in chat, and watch it build with a live preview.

---

## 🛠️ Scripts

Run from the repo root:

| Command | Description |
|---|---|
| `pnpm dev` | Run web + API in parallel |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint everything |
| `pnpm typecheck` | Type-check all packages |
| `pnpm format` | Prettier write |

API-specific (`pnpm --filter @aab/api <script>`):

| Command | Description |
|---|---|
| `db:generate` | Generate a Drizzle migration from the schema |
| `db:migrate` | Apply migrations |

---

## 🗺️ Roadmap

See [`plan.md`](plan.md) for the full phased build plan and the reverse-engineering notes that shaped the architecture. Highlights of what's planned beyond the MVP:

- Firecracker **microVM sandboxes** (E2B / Fly.io) for stronger per-tenant isolation
- **GitHub App** export with PR creation
- **CLI worker** engines (opencode / kiro) for cheap bulk edits
- Fast-apply merge model for lazy `// ... existing code ...` diffs
- Auth: GitHub OAuth + email sessions

---

## 📝 License

Personal project — all rights reserved unless a license file is added.
