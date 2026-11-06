# Deployment Guide

This is a split deployment: the **Next.js web app goes on Vercel**, the **Hono API goes on a persistent Node host** (it spawns long-running preview processes and uses the local filesystem + git, which serverless can't do). Postgres is hosted separately (Supabase/Neon).

```
apps/web  → Vercel
apps/api  → Railway / Render / Fly.io / VPS   (NOT Vercel)
Postgres  → Supabase / Neon
```

---

## 1. Database (Supabase or Neon)

1. Create a Postgres database on [Supabase](https://supabase.com) or [Neon](https://neon.tech).
2. Copy the connection string → this is your `DATABASE_URL`.
3. From your machine, run migrations against it:
   ```bash
   cd apps/api
   echo "DATABASE_URL=postgres://..." > .env
   pnpm --filter @aab/api db:migrate
   ```

---

## 2. API → Railway / Render / Fly.io (pick one)

The API must run as a **always-on Node process**, not serverless. Any of these work; Railway is the simplest.

### Build & run commands

- **Install:** `pnpm install --frozen-lockfile`
- **Build:** `pnpm --filter @aab/api build`
- **Start:** `pnpm --filter @aab/api start` (runs `node dist/index.js`)
- **Node:** ≥ 20

### Required environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your Supabase/Neon connection string |
| `PORT` | Provided by the host (the API reads `process.env.PORT`) |
| `WEB_ORIGIN` | Your Vercel URL, e.g. `https://your-app.vercel.app` (for CORS) |
| `ANTHROPIC_API_KEY` | Claude key (default engine) — and/or `GEMINI_API_KEY` / `OPENAI_API_KEY` |
| `DEFAULT_ENGINE` | optional: `opus` \| `gemini` \| `openai` \| `qoder` |

> The host needs `git` and `tar` available (standard on Railway/Render/Fly). The API writes projects to `apps/api/.data/` — **use a host with a persistent disk/volume** or that data (and live previews) won't survive restarts.

### Railway quick path

1. New Project → Deploy from GitHub → pick this repo.
2. Set **Root Directory** = repo root (it's a monorepo; the build command targets `@aab/api`).
3. Set the build/start commands and env vars above.
4. Attach a **Volume** mounted where `.data` lives (persistent workspaces).
5. Deploy → note the public URL, e.g. `https://ai-website-builder-api.up.railway.app`.

### Fly.io note

Fly gives persistent volumes and a real VM — a good fit for the preview sandboxes. You'd add a `fly.toml` + `Dockerfile` for the API. (This repo has no Dockerfile yet — see `process.md` §7.)

---

## 3. Web → Vercel

The web app is a standard Next.js app in a pnpm monorepo. A `apps/web/vercel.json` is already included.

### Steps

1. Go to [vercel.com/new](https://vercel.com/new) and import this GitHub repo.
2. **Root Directory:** set to **`apps/web`** (Vercel detects the pnpm workspace and installs from the repo root automatically).
3. **Framework Preset:** Next.js (auto-detected).
4. **Environment Variables:**

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | Your deployed API URL from step 2, e.g. `https://ai-website-builder-api.up.railway.app` |

5. Deploy.

> `NEXT_PUBLIC_API_URL` is baked in at build time (it's a `NEXT_PUBLIC_*` var). If you change the API URL later, **redeploy** the web app.

### Why `apps/web` as root works

The web app depends on the `@aab/shared` workspace package. Vercel's monorepo support reads `pnpm-workspace.yaml` at the repo root and installs the whole workspace, so `@aab/shared` resolves during the build. The included `apps/web/vercel.json` pins the install/build to run from the repo root with pnpm.

---

## 4. Wire it together

1. Deploy the **API** first → get its public URL.
2. Set `WEB_ORIGIN` on the API = your Vercel domain.
3. Set `NEXT_PUBLIC_API_URL` on Vercel = the API URL.
4. Redeploy whichever side changed.

Checklist:

- [ ] Postgres created, `DATABASE_URL` set, migrations applied
- [ ] API deployed on a persistent host with a volume, `git`/`tar` present
- [ ] API env: `DATABASE_URL`, `WEB_ORIGIN`, at least one `*_API_KEY`
- [ ] Web deployed on Vercel with `NEXT_PUBLIC_API_URL`
- [ ] CORS matches (`WEB_ORIGIN` === Vercel domain)

---

## 5. Can I put everything on Vercel?

**No — not the API as written.** Vercel is serverless: no persistent filesystem, no long-lived child processes, and a short execution limit. The API:

- spawns persistent `npm run dev` (Vite) preview servers per project,
- writes git repos + tars to `apps/api/.data/`,
- runs multi-minute codegen turns.

All of that requires an always-on server. Keep the **web on Vercel** and the **API on a persistent host**. (The sandbox/preview piece specifically needs a real VM/volume — see `process.md` §6–7 for the containerization path to E2B/Fly microVMs.)
