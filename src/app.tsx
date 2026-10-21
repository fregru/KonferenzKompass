import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";
import { uploadRoutes } from "./uploads";

export function createApp(db: Database, clock: () => number = Date.now) {
  const app = new Hono();
  app.get("/static/vendor/sortable.js", serveStatic({ path: "./node_modules/sortablejs/Sortable.min.js" }));
  app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, "") }));
  app.route("/", uploadRoutes());
  app.get("/admin/", (c) => c.redirect("/admin"));
  app.route("/admin", adminRoutes(db));
  app.route("/", publicRoutes(db, clock));
  return app;
}
