import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting } from "./db";
import { loginAs, post, testApp } from "./test-helpers";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "diko-uploads-"));
});

async function setup(perms: Parameters<typeof loginAs>[2]) {
  const t = testApp();
  const ev = Number(t.db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', '2026-11-13', 'active')").lastInsertRowid);
  const cookie = await loginAs(t.app, t.db, perms);
  return { ...t, ev, cookie };
}

test("intro text and FAQ are edited per event and shown on the start page", async () => {
  const { app, db, ev, cookie } = await setup(["intro"]);
  await post(app, `/admin/events/${ev}/intro`, { intro: "Willkommen zur **Diko**" }, cookie);
  await post(app, `/admin/events/${ev}/faq`, { question: "Wo finde ich die Unterlagen?", answer: "Unter [Unterlagen](https://cloud.example)." }, cookie);
  const html = await (await app.request("/")).text();
  expect(html).toContain("Willkommen zur <strong>Diko</strong>");
  expect(html).toContain("Häufige Fragen");
  expect(html).toContain("<summary>Wo finde ich die Unterlagen?</summary>");
  expect(html).toContain('href="https://cloud.example"');
  const faqId = db.query<{ id: number }, []>("SELECT id FROM faq").get()!.id;
  await post(app, `/admin/faq/${faqId}`, { question: "Wo sind die Unterlagen?", answer: "Nextcloud", sort: "2" }, cookie);
  expect(await (await app.request("/")).text()).toContain("Wo sind die Unterlagen?");
  setSetting(db, "show_intro", "0");
  const hidden = await (await app.request("/")).text();
  expect(hidden).not.toContain("Häufige Fragen");
  expect(hidden).not.toContain("Willkommen zur");
  await post(app, `/admin/faq/${faqId}/delete`, {}, cookie);
  expect(db.query("SELECT COUNT(*) AS n FROM faq").get()).toEqual({ n: 0 });
});

test("FAQ entry needs question and answer", async () => {
  const { app, db, ev, cookie } = await setup(["intro"]);
  const res = await post(app, `/admin/events/${ev}/faq`, { question: "", answer: "x" }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Frage und Antwort angeben");
  expect(db.query("SELECT COUNT(*) AS n FROM faq").get()).toEqual({ n: 0 });
});

test("intro and FAQ of an archived event cannot be written", async () => {
  const { app, db, ev, cookie } = await setup(["intro"]);
  db.run("UPDATE events SET status = 'archived' WHERE id = ?", [ev]);
  expect((await post(app, `/admin/events/${ev}/intro`, { intro: "x" }, cookie)).status).toBe(403);
  expect((await post(app, `/admin/events/${ev}/faq`, { question: "a", answer: "b" }, cookie)).status).toBe(403);
});

test("intro admin requires intro perm", async () => {
  const { app, ev, cookie } = await setup(["schedule"]);
  expect((await app.request(`/admin/events/${ev}/intro`, { headers: { cookie } })).status).toBe(403);
});

test("link with javascript: URL is rejected", async () => {
  const { app, db, cookie } = await setup(["pages"]);
  const res = await post(app, "/admin/pages/unterlagen/links", { label: "Böse", url: "javascript:alert(1)" }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Nur http(s)-Links erlaubt");
  expect(db.query("SELECT COUNT(*) AS n FROM page_links").get()).toEqual({ n: 0 });
});

test("link page shows buttons; direct page links straight from the nav", async () => {
  const { app, cookie } = await setup(["pages"]);
  await post(app, "/admin/pages/unterlagen/links", { label: "Zur Nextcloud", url: "https://cloud.example/s/abc" }, cookie);
  const page = await (await app.request("/p/unterlagen")).text();
  expect(page).toContain('href="https://cloud.example/s/abc"');
  expect(page).toContain("Zur Nextcloud");
  expect(await (await app.request("/")).text()).toContain('href="/p/unterlagen"');
  await post(app, "/admin/pages/unterlagen", { title: "Unterlagen", enabled: "1", sort: "1", body: "", direct: "1" }, cookie);
  expect(await (await app.request("/")).text()).toContain('href="https://cloud.example/s/abc"');
});

test("page title can be renamed and pages disabled; legal pages always reachable", async () => {
  const { app, cookie } = await setup(["pages"]);
  await post(app, "/admin/pages/wahlen", { title: "OpenSlides", sort: "3", body: "" }, cookie);
  expect((await app.request("/p/wahlen")).status).toBe(404);
  expect(await (await app.request("/")).text()).not.toContain("OpenSlides");
  await post(app, "/admin/pages/impressum", { title: "Impressum", sort: "90", body: "Verantwortlich: **KjG**" }, cookie);
  const legal = await app.request("/p/impressum");
  expect(legal.status).toBe(200);
  expect(await legal.text()).toContain("<strong>KjG</strong>");
});

test("contact with photo is shown on the start page", async () => {
  const { app, db, ev, cookie } = await setup(["settings"]);
  const body = new FormData();
  body.append("name", "Anna Beispiel");
  body.append("role", "Diözesanleitung");
  body.append("phone", "+49 221 123");
  body.append("email", "anna@example.org");
  body.append("messenger", "");
  body.append("photo", new File([new Uint8Array([0x89, 0x50])], "anna.jpg"));
  const res = await app.request(`/admin/events/${ev}/contacts`, { method: "POST", body, headers: { origin: "http://localhost", cookie } });
  expect(res.status).toBe(302);
  const html = await (await app.request("/")).text();
  expect(html).toContain("Anna Beispiel");
  expect(html).toMatch(/<img src="\/uploads\/[0-9a-f-]{36}\.jpg"/);
  expect(html).toContain('href="tel:+49221123"');
  expect(html).toContain('href="mailto:anna@example.org"');
  setSetting(db, "show_contact", "0");
  expect(await (await app.request("/")).text()).not.toContain("Anna Beispiel");
});

test("pages admin requires pages perm", async () => {
  const { app, cookie } = await setup(["intro"]);
  expect((await app.request("/admin/pages", { headers: { cookie } })).status).toBe(403);
});

test("start page puts contact and quick links into a sidebar after the main column", async () => {
  const { app, db, ev } = await setup(["settings"]);
  db.run("INSERT INTO contacts (event_id, name) VALUES (?, 'Anna Beispiel')", [ev]);
  db.run("INSERT INTO page_links (event_id, page_slug, label, url) VALUES (?, 'unterlagen', 'Cloud', 'https://c.example')", [ev]);
  const html = await (await app.request("/")).text();
  const main = html.indexOf('<div class="maincol">');
  const side = html.indexOf('<aside class="side">');
  expect(main).toBeGreaterThan(0);
  expect(side).toBeGreaterThan(main);
  expect(html.indexOf("Anna Beispiel")).toBeGreaterThan(side);
  expect(html.slice(side)).toContain("Schnellzugriff");
  expect(html.slice(side)).toContain('href="/p/unterlagen"');
});

test("content pages use the same layout as the start page: card on the left, sidebar on the right", async () => {
  const { app, db, ev } = await setup(["pages"]);
  db.run("INSERT INTO contacts (event_id, name) VALUES (?, 'Anna Beispiel')", [ev]);
  db.run("UPDATE pages SET body = 'Hallo' WHERE slug = 'hilfe'");
  const html = await (await app.request("/p/hilfe")).text();
  expect(html).toMatch(/<div class="layout"><div class="maincol"><article class="card page">/);
  expect(html.indexOf('<aside class="side">')).toBeGreaterThan(html.indexOf("Hallo"));
  expect(html.slice(html.indexOf('<aside class="side">'))).toContain("Anna Beispiel");
});

test("admin link in the top menu only when logged in", async () => {
  const { app, cookie } = await setup([]);
  expect(await (await app.request("/")).text()).not.toContain('href="/admin"');
  expect(await (await app.request("/", { headers: { cookie } })).text()).toContain('href="/admin"');
});

test("a removed or replaced contact photo is deleted, unless a copied event still shows it", async () => {
  const { app, db, ev, cookie } = await setup(["settings", "events"]);
  const send = (path: string, fields: Record<string, string | File>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    return app.request(path, { method: "POST", body, headers: { origin: "http://localhost", cookie } });
  };
  const photo = () => new File([new Uint8Array([0x89, 0x50])], "anna.jpg");
  await send(`/admin/events/${ev}/contacts`, { name: "Anna", photo: photo() });
  const contact = () => db.query<{ id: number; photo: string }, []>("SELECT id, photo FROM contacts ORDER BY id LIMIT 1").get()!;
  const first = contact().photo;
  await send(`/admin/contacts/${contact().id}`, { name: "Anna", photo: photo() });
  expect((await app.request(`/uploads/${first}`)).status).toBe(404);
  const second = contact().photo;
  // a copy shares the file: deleting the original contact keeps it
  await post(app, `/admin/events/${ev}/copy`, { name: "Kopie", start_date: "2027-11-12" }, cookie);
  await post(app, `/admin/contacts/${contact().id}/delete`, {}, cookie);
  expect((await app.request(`/uploads/${second}`)).status).toBe(200);
  const copy = db.query<{ id: number }, []>("SELECT id FROM contacts").get()!.id;
  await send(`/admin/contacts/${copy}`, { name: "Anna", remove_photo: "1" });
  expect((await app.request(`/uploads/${second}`)).status).toBe(404);
});
