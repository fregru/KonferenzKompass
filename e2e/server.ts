// Server for the browser tests (playwright.config.ts): the example event in an in-memory database and uploads in a
// temporary folder, so the real data/ is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "kk-e2e-"));
const { createApp } = await import("../src/app");
const { openDb } = await import("../src/db");
const { seedExample } = await import("../src/example");

const db = openDb(":memory:");
await seedExample(db);
const app = createApp(db);
Bun.serve({
  port: Number(process.env.PORT ?? 3999),
  idleTimeout: 60,
  // cookies play a bad network for one browser context (Playwright's setOffline does not reach Firefox's service
  // worker): e2e-slow=1 = venue Wi-Fi without internet, requests hang; e2e-down=1 = unreachable, connection reset
  fetch: async (req) => {
    const cookie = req.headers.get("cookie") ?? "";
    if (cookie.includes("e2e-slow=1")) await Bun.sleep(8000);
    if (cookie.includes("e2e-down=1")) return new Response(new ReadableStream({ start: (c) => c.error(new Error("e2e: offline")) }));
    return app.fetch(req);
  },
});
console.log("e2e server ready");
