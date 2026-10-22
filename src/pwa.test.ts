import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { getSetting, setSetting } from "./db";
import { seedExample } from "./example";
import { offlineContent, pngSize } from "./pwa";
import { loginAs, testApp } from "./test-helpers";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "kk-pwa-"));
});

/** Just enough of a PNG for pngSize: signature and the IHDR size fields. */
function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function postIcon(app: Hono, cookie: string, file: File) {
  const body = new FormData();
  for (const [k, v] of Object.entries({ site_title: "Diko", color_primary: "#006d84", color_secondary: "#00b6be", hero_position: "center" })) body.append(k, v);
  body.append("app_icon", file);
  return app.request("/admin/settings", { method: "POST", body, headers: { origin: "http://localhost", cookie } });
}

test("pngSize reads the header and rejects other files", () => {
  expect(pngSize(png(512, 256))).toEqual({ width: 512, height: 256 });
  expect(pngSize(new TextEncoder().encode("<svg/>".padEnd(30)))).toBeNull();
});

test("manifest comes from the settings, with the generated icon as fallback", async () => {
  const { app, db } = testApp();
  setSetting(db, "site_title", "Diözesankonferenz 2027");
  const res = await app.request("/manifest.webmanifest");
  expect(res.headers.get("content-type")).toBe("application/manifest+json");
  const m: any = await res.json();
  expect(m).toMatchObject({ name: "Diözesankonferenz 2027", short_name: "Diözesankonf", start_url: "/", display: "standalone" });
  expect(m.icons).toEqual([{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]);

  const icon = await app.request("/app-icon.svg");
  expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  expect(await icon.text()).toContain(">D</text>");

  const html = await (await app.request("/")).text();
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
  expect(html).not.toContain("apple-touch-icon");
});

test("uploaded app icon: square PNG of at least 512 px, used in manifest and for iOS", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  for (const bad of [new File([png(512, 256)], "a.png"), new File([png(256, 256)], "a.png"), new File(["<svg/>"], "a.svg")]) {
    expect((await postIcon(app, cookie, bad)).status).toBe(400);
  }
  expect(getSetting(db, "app_icon")).toBe("");

  await postIcon(app, cookie, new File([png(1024, 1024)], "icon.png"));
  const name = getSetting(db, "app_icon");
  expect(name).toMatch(/\.png$/);
  const m: any = await (await app.request("/manifest.webmanifest")).json();
  expect(m.icons[0]).toEqual({ src: `/uploads/${name}`, sizes: "1024x1024", type: "image/png", purpose: "any" });
  expect(await (await app.request("/")).text()).toContain(`<link rel="apple-touch-icon" href="/uploads/${name}"/>`);
});

test("service worker: root scope, no-cache, version and offline assets filled in", async () => {
  const { app } = testApp();
  const res = await app.request("/sw.js");
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const code = await res.text();
  expect(code).not.toContain("__CONFIG__");
  const config = JSON.parse(code.match(/const CONFIG = (\{.*\});/)![1]!);
  expect(config.VERSION).toMatch(/^\w+$/);
  expect(config.ASSETS[0]).toMatch(/^\/static\/style\.css\?v=\w+$/);
  expect(config.PAGES).toContain("/");
});

test("offline content: every menu page, legal pages, floor tabs and the images they show", async () => {
  const { app, db } = testApp();
  await seedExample(db);
  setSetting(db, "hero_image", "11111111-1111-1111-1111-111111111111.jpg");
  const { pages, uploads } = offlineContent(db);
  for (const p of ["/", "/p/hilfe", "/p/lageplan", "/p/impressum", "/p/datenschutz"]) expect(pages).toContain(p);
  expect(pages.some((p) => /^\/p\/lageplan\?etage=\d+$/.test(p))).toBe(true);
  expect(pages.some((p) => p.startsWith("http"))).toBe(false); // direct external links are no pages of ours
  expect(uploads).toContain("/uploads/11111111-1111-1111-1111-111111111111.jpg");
  expect(uploads.length).toBeGreaterThan(1); // floor plans of the example venue

  // a new page changes the worker, so browsers install it again and store the page
  const before = await (await app.request("/sw.js")).text();
  db.run("UPDATE pages SET enabled = 0 WHERE slug = 'hilfe'");
  const after = await (await app.request("/sw.js")).text();
  expect(after).not.toBe(before);
  expect(offlineContent(db).pages).not.toContain("/p/hilfe");
});

test("SERVICE_WORKER=off serves a worker that removes itself and tells pages not to register", async () => {
  const { app } = testApp();
  process.env.SERVICE_WORKER = "off";
  try {
    const code = await (await app.request("/sw.js")).text();
    expect(code).toContain("registration.unregister()");
    expect(code).not.toContain("CONFIG");
    expect(await (await app.request("/")).text()).toContain('data-sw="off"');
  } finally {
    delete process.env.SERVICE_WORKER;
  }
  expect(await (await app.request("/")).text()).not.toContain("data-sw");
});

test("static files: versioned URLs are cached for a year, plain ones revalidated", async () => {
  const { app } = testApp();
  const html = await (await app.request("/")).text();
  const css = html.match(/href="(\/static\/style\.css\?v=\w+)"/)![1]!;
  expect((await app.request(css)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect((await app.request("/static/style.css")).headers.get("cache-control")).toBe("no-cache");
});

test("responses are gzip-compressed when the browser accepts it", async () => {
  const { app } = testApp();
  const res = await app.request("/static/style.css", { headers: { "accept-encoding": "gzip" } });
  expect(res.headers.get("content-encoding")).toBe("gzip");
  const page = await app.request("/", { headers: { "accept-encoding": "gzip, br" } });
  expect(page.headers.get("content-encoding")).toBe("gzip");
});

test("pages carry their build time and a hidden offline bar for site.js", async () => {
  const { app } = testApp(() => Date.parse("2026-11-13T10:00:00Z"));
  const before = Date.now();
  const html = await (await app.request("/p/hilfe")).text();
  const stand = Number(html.match(/<html lang="de" data-stand="(\d+)"/)![1]);
  expect(stand).toBeGreaterThanOrEqual(before);
  expect(html).toContain('<div class="offlinebar" hidden=""><p role="status"></p></div></header>');
});

test("without App-Icon the tab icon is the app icon: embedded in the square SVG, and for iOS when it is a PNG", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  const body = new FormData();
  for (const [k, v] of Object.entries({ site_title: "Diko", color_primary: "#006d84", color_secondary: "#00b6be", hero_position: "center" })) body.append(k, v);
  body.append("favicon", new File([png(1181, 1170)], "tab.png"));
  await app.request("/admin/settings", { method: "POST", body, headers: { origin: "http://localhost", cookie } });
  const favicon = getSetting(db, "favicon");

  const svg = await (await app.request("/app-icon.svg")).text();
  expect(svg).toContain('<image href="data:image/png;base64,');
  expect(svg).not.toContain("<text");
  expect(await (await app.request("/")).text()).toContain(`<link rel="apple-touch-icon" href="/uploads/${favicon}"/>`);
});

test("start page has the install hint, hidden until site.js knows the browser can install", async () => {
  const { app } = testApp();
  const html = await (await app.request("/")).text();
  expect(html).toContain('<section class="card installhint" hidden="">');
  expect(await (await app.request("/p/hilfe")).text()).not.toContain("installhint");
});
