# Task: Phase 0 — web app shell + UI foundations (apps/web ONLY)

You are a worker in an existing pnpm monorepo at the current working directory
(`ai-app-builder/`). The monorepo root already exists: `package.json` (pnpm workspaces
`apps/*`, `packages/*`), `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`. Do ONLY
what this task says, and ONLY inside `apps/web/`.

## Target
`apps/web/` — a new Next.js (App Router) + TypeScript application, workspace member of this monorepo.

## Change (Phase 0 UI foundations only)
1. Scaffold `apps/web` as Next.js App Router + TypeScript + Tailwind CSS. `package.json` name `web`, scripts `dev`, `build`, `start`, `lint`, `typecheck` (`tsc --noEmit`). `tsconfig.json` extends `../../tsconfig.base.json` where practical (keep Next.js required options).
2. **Tailwind + shadcn/ui**: install Tailwind, configure, and set up shadcn/ui (components dir). Add a base component set (button, card, dialog, input, skeleton, toast at minimum).
3. **Design tokens**: define color/type/spacing scale with **light and dark** themes via CSS variables in the Tailwind theme. Dark mode via `class` strategy + a theme toggle.
4. **App shell + landing page**: a header (logo/name, theme toggle, placeholder auth button) and a landing page describing the product ("AI App Builder"). Clean, responsive, mobile-first.
5. **Shared UI state components** — reusable, documented, used on the landing/demo page: `Loading`, `Streaming` (animated), `Empty` (icon + CTA), `ErrorState` (message + retry), `Success`. Put them under `apps/web/src/components/states/`.
6. **Accessibility baseline**: keyboard navigation, visible focus rings, labelled controls, and respect `prefers-reduced-motion` for the Streaming animation.
7. Responsive: verify mobile → desktop layout.

## Constraints
- **Work ONLY inside `apps/web/`.** Do NOT touch `apps/api/`, `packages/shared/`, the root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, or any `.github/` or root lint config.
- **Do NOT run `pnpm install`** at the repo root — the coordinator installs once after you finish. (If a scaffolder like `create-next-app` insists on installing inside `apps/web`, that is acceptable, but do not modify the root lockfile.)
- TypeScript strict. No `any`. No hard-coded secrets.
- Keep it MINIMAL and Phase 0 scoped: shell + landing + tokens + the 5 state components + a11y. **No** project/chat/preview/auth features yet — those are later phases.

## Ownership / boundaries
You own `apps/web/` and nothing else.

## Observable acceptance
- `apps/web` is a valid Next.js App Router TS app; after `pnpm install` at root, `pnpm --filter web build` would succeed.
- Landing page renders in **light and dark** and is responsive on mobile.
- shadcn/ui base components present; design tokens defined in the Tailwind theme.
- The 5 state components exist under `src/components/states/` and are shown on the landing/demo page.
- A11y: focus rings visible, controls labelled, `prefers-reduced-motion` respected.
When done, print a short summary of files created.
