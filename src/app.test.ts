import { test, expect, spyOn } from "bun:test";
import { setSetting } from "./db";
import { testApp } from "./test-helpers";

test("start page renders with site title and footer", async () => {
  const { app, db } = testApp();
  setSetting(db, "site_title", "Diko 2026");
  const html = await (await app.request("/")).text();
  expect(html).toContain("<title>Diko 2026</title>");
  expect(html).toContain('href="/p/impressum"');
  expect(html).toContain('href="/p/datenschutz"');
});

test("nav hides disabled pages, hidden entirely when none enabled", async () => {
  const { app, db } = testApp();
  db.run("UPDATE pages SET enabled = 0 WHERE kind != 'legal'");
  expect(await (await app.request("/")).text()).not.toContain("<nav");
  db.run("UPDATE pages SET enabled = 1, title = 'OpenSlides' WHERE slug = 'wahlen'");
  expect(await (await app.request("/")).text()).toContain("OpenSlides");
});

test("viewport supports edge-to-edge phones", async () => {
  const { app } = testApp();
  expect(await (await app.request("/")).text()).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover"');
});

test("phone menu is a native disclosure listing every page, current page marked", async () => {
  const { app } = testApp();
  const html = await (await app.request("/p/hilfe")).text();
  const menu = html.slice(html.indexOf('<details class="menu">'), html.indexOf("</details>"));
  expect(menu).toContain("<summary");
  expect(menu).toContain("Menü");
  for (const href of ['href="/"', 'href="/p/unterlagen"', 'href="/p/antraege"', 'href="/p/wahlen"', 'href="/p/hilfe"']) expect(menu).toContain(href);
  expect(menu).toContain('href="/p/hilfe" aria-current="page"');
});

test("health check answers without login and reports a broken database", async () => {
  const { app, db } = testApp();
  const ok = await app.request("/health");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("ok");
  expect(ok.headers.get("cache-control")).toBe("no-store");
  db.close();
  // the failure is logged on purpose; keep it out of the test output, but make sure it is logged
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const broken = await app.request("/health");
    expect(broken.status).toBe(503);
    expect(await broken.text()).toBe("fehler");
    expect(log.mock.calls[0]?.[0]).toBe("Health-Check fehlgeschlagen:");
  } finally {
    log.mockRestore();
  }
});
