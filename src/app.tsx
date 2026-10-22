import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import { pwaRoutes } from "./pwa";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";
import { uploadRoutes } from "./uploads";

export function createApp(db: Database, clock: () => number = Date.now) {
  const app = new Hono();
  app.use(compress());
  // For Docker's HEALTHCHECK, proxies and monitoring: the process answers and the database is readable.
  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    try {
      db.query("SELECT 1").get();
      return c.text("ok");
    } catch (e) {
      console.error("Health-Check fehlgeschlagen:", e);
      return c.text("fehler", 503);
    }
  });
  // with ?v=<hash> (see assetUrl) a file never changes under its URL; without it browsers must ask again
  const onFound = (_path: string, c: Context) =>
    c.header("Cache-Control", c.req.query("v") ? "public, max-age=31536000, immutable" : "no-cache");
  app.get("/static/vendor/sortable.js", serveStatic({ path: "./node_modules/sortablejs/Sortable.min.js", onFound }));
  app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, ""), onFound }));
  app.route("/", uploadRoutes());
  app.route("/", pwaRoutes(db));
  app.get("/admin/", (c) => c.redirect("/admin"));
  app.route("/admin", adminRoutes(db));
  app.route("/", publicRoutes(db, clock));
  return app;
}
