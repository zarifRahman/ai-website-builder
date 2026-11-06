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

### ⚠️ If your Vercel build fails with `templates/vite-react/...`, `@vitejs/plugin-react`, or `openai.ts ... not constructable`

All of these mean the same thing: Vercel is **building the API / the whole repo**
instead of just the web app, and is compiling the `apps/api/templates/vite-react`
seed project (a nested sub-project whose deps are intentionally not installed).
The API and the templates must **never** be built on Vercel.

The repo ships two configs that force a web-only build — a root `vercel.json` and
`apps/web/vercel.json`, both running `pnpm --filter web build`. Make sure your
Vercel **Project Settings** aren't overriding them:

| Setting | Correct value |
|---|---|
| **Root Directory** | `apps/web` (recommended) — or leave at repo root; the root `vercel.json` handles it |
| **Build Command** | **Override OFF**, or `pnpm --filter web build`. **Not** `pnpm build` / `pnpm -r build` / `tsc` |
| **Install Command** | **Override OFF**, or `pnpm install --frozen-lockfile` |
| **Framework Preset** | Next.js |

Most often this error comes from a leftover **custom Build Command** (e.g.
`pnpm build` or `tsc`) in the Vercel dashboard — clear it, redeploy, and the
template/openai errors disappear. `pnpm --filter web build` compiles only the
Next.js app and never touches `apps/api` or `templates/`.

The code also now (a) excludes `templates`/`.data` from the API's own tsconfig and
(b) constructs the OpenAI client interop-safely, so even a correct API build on
Docker/EC2/CI stays clean.

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

## 5. Alternative: run the whole stack on one host (Docker)

If you'd rather skip Vercel and run **everything together** (Postgres + API + Web), use the included Docker setup.

### Local / single-VM with docker compose

```bash
cp .env.docker.example .env      # fill in at least one *_API_KEY
docker compose up --build
```

- Web → http://localhost:3000
- API → http://localhost:4000
- Postgres runs in-stack; migrations run automatically on API start.
- Project workspaces + snapshots persist in the `api-data` volume.

This works on any Docker host (a VPS/droplet, EC2, etc.). Put a reverse proxy
(Caddy/Nginx) in front for TLS, and change the `web` build arg
`NEXT_PUBLIC_API_URL` + the API's `WEB_ORIGIN` to your real domains.

Files: `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`.

### API on Fly.io (persistent VM + volume)

Fly is a good fit for the API because it gives a real VM with a persistent disk
for the preview sandboxes. Config: `apps/api/fly.toml`.

```bash
# from the repo root
fly launch --no-deploy --copy-config --dockerfile apps/api/Dockerfile
fly volumes create aab_data --size 3 --region sjc
fly secrets set \
  DATABASE_URL="postgres://..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  WEB_ORIGIN="https://your-app.vercel.app"
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile .
```

Then point the web app's `NEXT_PUBLIC_API_URL` at your Fly URL (whether web is
on Vercel or in the same Docker stack).

> You can mix and match: **web on Vercel + API on Fly** is the recommended
> production split; **all-in-one docker compose** is simplest for a personal/VPS setup.

---

## 5b. Deploy on an AWS EC2 instance

EC2 is a plain VM, so the **all-in-one Docker stack** runs there directly — this
is the recommended way to get the full product (including live previews) on one box.

### Step 1 — Launch the instance (AWS Console, one-time)

1. **EC2 → Launch instance.**
2. **AMI:** Ubuntu Server 24.04 LTS.
3. **Type:** `t3.small` minimum (2 GB RAM); `t3.medium` (4 GB) recommended — `npm install` for generated apps is memory-hungry.
4. **Key pair:** select/create one and download the `.pem` (you'll SSH with it).
5. **Storage:** 20–30 GB gp3 (project workspaces + node_modules add up).
6. **Security group — inbound rules:**
   | Type | Port | Source |
   |---|---|---|
   | SSH | 22 | My IP |
   | Custom TCP | 3000 | 0.0.0.0/0 (web) |
   | Custom TCP | 4000 | 0.0.0.0/0 (API) |
7. Launch, then note the **Public IPv4 / DNS**.

### Step 2 — Bootstrap (one command on the instance)

SSH in and run the bundled setup script (installs Docker, clones the repo, starts the stack):

```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>

curl -fsSL https://raw.githubusercontent.com/zarifRahman/ai-website-builder/main/deploy/ec2-setup.sh | bash
```

First run creates `.env` from the template and stops. Add your codegen key(s):

```bash
nano ~/ai-website-builder/.env        # set ANTHROPIC_API_KEY (and/or GEMINI/OPENAI)
cd ~/ai-website-builder && sudo docker compose up -d --build
```

- Web → `http://<EC2_PUBLIC_IP>:3000`
- API → `http://<EC2_PUBLIC_IP>:4000`

### Step 3 — Point the web app at the public IP

The web image bakes `NEXT_PUBLIC_API_URL` at build time (default `localhost:4000`),
so the browser must reach the API at the **public** address. Edit
`docker-compose.yml` on the instance:

```yaml
  web:
    build:
      args:
        NEXT_PUBLIC_API_URL: http://<EC2_PUBLIC_IP>:4000   # or https://api.yourdomain.com
  api:
    environment:
      WEB_ORIGIN: http://<EC2_PUBLIC_IP>:3000               # CORS
```

Then rebuild: `sudo docker compose up -d --build`.

### Step 4 (optional) — domain + HTTPS

Put **Caddy** or **Nginx** in front as a reverse proxy to terminate TLS and map
`yourdomain.com` → web:3000 and `api.yourdomain.com` → api:4000. Then set
`NEXT_PUBLIC_API_URL`/`WEB_ORIGIN` to the `https://` domains and rebuild. Caddy
gives automatic Let's Encrypt certs with a 3-line Caddyfile.

### Managing the stack

```bash
sudo docker compose ps          # status
sudo docker compose logs -f api # tail API logs
sudo docker compose restart     # restart
sudo docker compose down        # stop (volumes/data persist)
git pull && sudo docker compose up -d --build   # update to latest
```

> Script: `deploy/ec2-setup.sh`. For production, consider an external managed
> Postgres (RDS/Supabase/Neon) instead of the in-stack `db` container — point
> the API's `DATABASE_URL` at it and drop the `db` service.

---

## 6. Can I put everything on Vercel?

**No — not the API as written.** Vercel is serverless: no persistent filesystem, no long-lived child processes, and a short execution limit. The API:

- spawns persistent `npm run dev` (Vite) preview servers per project,
- writes git repos + tars to `apps/api/.data/`,
- runs multi-minute codegen turns.

All of that requires an always-on server. Keep the **web on Vercel** and the **API on a persistent host**. (The sandbox/preview piece specifically needs a real VM/volume — see `process.md` §6–7 for the containerization path to E2B/Fly microVMs.)
