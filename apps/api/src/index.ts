import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { User } from "@aab/shared";
import { sessionStub } from "./middleware/session.js";
import { projectsApp } from "./projects/routes.js";
import { engineApp } from "./engine/routes.js";
import { sandboxRoutes } from "./sandbox/routes.js";

const app = new Hono<{ Variables: { user: User | null } }>({
  strict: false,
});

// ponytail: reflect the web dev origin. Lock to an allow-list from env in Phase 5.
app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true }));

app.use("*", sessionStub);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/me", (c) => c.json({ user: c.get("user") }));

app.route("/projects", projectsApp);
app.route("/projects", engineApp);
app.route("/projects", sandboxRoutes);

const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

export { app };
