import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { applyImport, parseBackup, type Backup } from "./backup";
import { getSetting, setSetting } from "./db";
import { loginAs, post, TEST_PASSWORD, testApp } from "./test-helpers";
import { saveData, uploadDir } from "./uploads";
import { PERMS } from "./auth";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "kk-backup-"));
  process.env.IMPORT_DIR = mkdtempSync(join(tmpdir(), "kk-imports-"));
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>`;
const FANCY = "Präsidium für Übergänge – „Wahlen“ · Straße 😀";

/** Source installation: settings with logo, a venue with floor plan, an event using it, users. */
async function source() {
  const t = testApp();
  const { db } = t;
  const logo = await saveData(PNG, "png");
  setSetting(db, "logo", logo);
  setSetting(db, "site_title", `Titel ${FANCY}`);
  db.run("UPDATE pages SET body = ? WHERE slug = 'hilfe'", [`Hilfe: ${FANCY}`]);
  const venue = Number(db.run("INSERT INTO venues (name) VALUES ('Haus Ölberg')").lastInsertRowid);
  const floor = Number(db.run("INSERT INTO floors (venue_id, name, image) VALUES (?, 'EG', ?)", [venue, await saveData(new TextEncoder().encode(SVG), "svg")]).lastInsertRowid);
  const room = Number(db.run("INSERT INTO rooms (venue_id, floor_id, name) VALUES (?, ?, 'Großer Saal')", [venue, floor]).lastInsertRowid);
  const ev = Number(db.run("INSERT INTO events (name, start_date, status, intro, venue_id) VALUES (?, '2026-11-13', 'active', 'Willkommen', ?)", [FANCY, venue]).lastInsertRowid);
  const main = Number(db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, room_id, done, fixed) VALUES (?, '2026-11-13', '09:00', '10:00', ?, 'agenda', ?, 1, 1)`, [ev, `TOP ${FANCY}`, room]).lastInsertRowid);
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, parent_id) VALUES (?, '2026-11-13', '09:00', '09:30', 'Unterpunkt ä', 'agenda', ?)`, [ev, main]);
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, menu, sort) VALUES (?, '2026-11-13', '12:00', '13:00', 'Mittag', 'break', 'Spätzle', 1)`, [ev]);
  db.run("INSERT INTO faq (event_id, question, answer) VALUES (?, 'Wo schlafe ich?', 'Im Haus.')", [ev]);
  db.run("INSERT INTO contacts (event_id, name, photo) VALUES (?, 'Jörg', ?)", [ev, logo]); // same image as the logo
  db.run("INSERT INTO page_links (event_id, page_slug, label, url) VALUES (?, 'unterlagen', 'Ordner', 'https://example.org/ü')", [ev]);
  db.run("INSERT INTO changes (event_id, at, username, text) VALUES (?, 1, 'anna', 'früher')", [ev]);
  const cookie = await loginAs(t.app, db, [...PERMS]);
  return { ...t, ev, venue, room, cookie };
}

async function exportAll(s: Awaited<ReturnType<typeof source>>) {
  const res = await s.app.request(`/admin/sicherung/export?settings=1&pages=1&users=1&venue=${s.venue}&event=${s.ev}&changes=1`, { headers: { cookie: s.cookie } });
  expect(res.status).toBe(200);
  return res;
}

function upload(app: Hono, cookie: string, bytes: Uint8Array | string, name = "sicherung.json") {
  const body = new FormData();
  body.append("file", new File([bytes], name));
  return app.request("/admin/sicherung/import", { method: "POST", body, headers: { origin: "http://localhost", cookie } });
}

/** Uploads, then imports with `choices` (defaults for everything else); returns the result page. */
async function importFile(app: Hono, cookie: string, bytes: Uint8Array | string, choices: Record<string, string> = {}) {
  const preview = await (await upload(app, cookie, bytes)).text();
  const token = /\/admin\/sicherung\/import\/([0-9a-f-]{36})/.exec(preview)?.[1];
  expect(token).toBeDefined();
  return { preview, res: await post(app, `/admin/sicherung/import/${token}`, choices, cookie) };
}

const count = (db: Database, sql: string, ...args: (string | number)[]) => db.query<{ n: number }, any>(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args)!.n;

test("export has UTF-8 headers, an ASCII file name and embeds each image once", async () => {
  const s = await source();
  const res = await exportAll(s);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="konferenzkompass-\d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''/);
  const text = await res.text();
  expect(text).toContain(FANCY); // written as-is, not \u-escaped
  const data = JSON.parse(text) as Backup;
  expect(Object.keys(data.files)).toHaveLength(1); // logo and contact photo are the same file
  expect(data.users).toHaveLength(1);
  expect(data.venues![0]!.floors[0]!.image).toStartWith("data:image/svg+xml;base64,");
});

test("single-event export is named after the event with Umlaute transliterated", async () => {
  const s = await source();
  const res = await s.app.request(`/admin/sicherung/export?event=${s.ev}`, { headers: { cookie: s.cookie } });
  expect(res.headers.get("content-disposition")).toContain('filename="veranstaltung-praesidium-fuer-uebergaenge-wahlen-strasse-');
});

test("round trip into a fresh installation keeps everything, Umlaute and emoji included", async () => {
  const s = await source();
  const file = await (await exportAll(s)).text();
  const t = testApp();
  const cookie = await loginAs(t.app, t.db, [...PERMS]);
  const { preview, res } = await importFile(t.app, cookie, file);
  expect(preview).toContain(FANCY);
  expect(preview).toContain("Wird als Entwurf angelegt");
  expect(await res.text()).toContain("Import abgeschlossen");

  const { db } = t;
  expect(getSetting(db, "site_title")).toBe(`Titel ${FANCY}`);
  expect(db.query<{ body: string }, []>("SELECT body FROM pages WHERE slug = 'hilfe'").get()!.body).toBe(`Hilfe: ${FANCY}`);
  const ev = db.query<{ id: number; status: string; venue_id: number }, [string]>("SELECT id, status, venue_id FROM events WHERE name = ?").get(FANCY)!;
  expect(ev.status).toBe("draft");
  const room = db.query<{ id: number }, []>("SELECT id FROM rooms WHERE name = 'Großer Saal'").get()!;
  expect(db.query<{ room_id: number; done: number; fixed: number }, [string]>("SELECT room_id, done, fixed FROM items WHERE title = ?").get(`TOP ${FANCY}`))
    .toEqual({ room_id: room.id, done: 1, fixed: 1 });
  expect(count(db, "SELECT 1 FROM items WHERE parent_id IS NOT NULL AND title = 'Unterpunkt ä'")).toBe(1);
  expect(db.query<{ menu: string }, []>("SELECT menu FROM items WHERE kind = 'break'").get()!.menu).toBe("Spätzle");
  expect(count(db, "SELECT 1 FROM page_links WHERE event_id = ? AND url = 'https://example.org/ü'", ev.id)).toBe(1);
  expect(count(db, "SELECT 1 FROM changes WHERE event_id = ? AND text = 'früher'", ev.id)).toBe(1);
  // logo and photo are new files with the same content
  const logo = getSetting(db, "logo");
  const photo = db.query<{ photo: string }, []>("SELECT photo FROM contacts WHERE name = 'Jörg'").get()!.photo;
  expect(new Uint8Array(await Bun.file(join(uploadDir(), logo)).arrayBuffer())).toEqual(PNG);
  expect(await Bun.file(join(uploadDir(), photo)).exists()).toBe(true);
  // the imported user can sign in with the old password
  const username = db.query<{ username: string }, []>("SELECT username FROM users ORDER BY id LIMIT 1 OFFSET 1").get()!.username;
  const login = await post(t.app, "/admin/login", { username, password: TEST_PASSWORD }, "", { "x-forwarded-for": "10.9.9.9" });
  expect(login.headers.get("location")).toBe("/admin");
});

test("an existing event is skipped by default, replaced in place or added as a new draft", async () => {
  const s = await source();
  const file = await (await exportAll(s)).text();
  const events = () => s.db.query<{ id: number; status: string }, [string]>("SELECT id, status FROM events WHERE name = ?").all(FANCY);
  s.db.run("UPDATE items SET title = 'lokal geändert' WHERE event_id = ? AND kind = 'break'", [s.ev]);

  await importFile(s.app, s.cookie, file, { settings: "skip", "venue:0": "skip" });
  expect(events()).toEqual([{ id: s.ev, status: "active" }]);
  expect(count(s.db, "SELECT 1 FROM items WHERE title = 'lokal geändert'")).toBe(1);

  await importFile(s.app, s.cookie, file, { "event:0": "replace", "venue:0": "replace" });
  expect(events()).toEqual([{ id: s.ev, status: "active" }]); // same id, status kept
  expect(count(s.db, "SELECT 1 FROM items WHERE title = 'lokal geändert'")).toBe(0);
  // the venue was replaced in place: the room keeps its id and the entry its room
  expect(s.db.query<{ room_id: number }, [string]>("SELECT room_id FROM items WHERE title = ?").get(`TOP ${FANCY}`)!.room_id).toBe(s.room);
  expect(count(s.db, "SELECT 1 FROM venues")).toBe(1);

  await importFile(s.app, s.cookie, file, { "event:0": "new", "venue:0": "skip" });
  expect(events().map((e) => e.status)).toEqual(["active", "draft"]);
});

test("the own account is never replaced; another one gets new rights and its sessions end", async () => {
  const s = await source();
  const file = JSON.parse(await (await exportAll(s)).text()) as Backup;
  const own = file.users![0]!.username;
  const other = await loginAs(s.app, s.db, ["schedule"]);
  const otherName = s.db.query<{ username: string }, []>("SELECT username FROM users ORDER BY id DESC").get()!.username;
  file.users = [
    { username: own, hash: file.users![0]!.hash, perms: [] },
    { username: otherName, hash: file.users![0]!.hash, perms: ["pages"] },
  ];
  const { preview } = await importFile(s.app, s.cookie, JSON.stringify(file), { "user:0": "replace", "user:1": "replace" });
  expect(preview).toContain("Das eigene Konto wird nie überschrieben.");
  const perms = (u: string) => s.db.query<{ perms: string }, [string]>("SELECT perms FROM users WHERE username = ?").get(u)!.perms;
  expect(JSON.parse(perms(own))).toEqual([...PERMS]);
  expect(JSON.parse(perms(otherName))).toEqual(["pages"]);
  expect((await s.app.request("/admin/live", { headers: { cookie: other } })).headers.get("location")).toBe("/admin/login");
});

test("parts without permission are neither exported nor imported, even when asked for", async () => {
  const s = await source();
  const full = await (await exportAll(s)).text();
  const cookie = await loginAs(s.app, s.db, ["events"]);
  const res = await s.app.request(`/admin/sicherung/export?users=1&settings=1&event=${s.ev}&venue=${s.venue}`, { headers: { cookie } });
  const data = JSON.parse(await res.text()) as Backup;
  expect(data.users).toBeUndefined();
  expect(data.settings).toBeUndefined();
  expect(data.venues).toBeUndefined();
  expect(data.events).toHaveLength(1);

  const users = count(s.db, "SELECT 1 FROM users");
  const parsed = JSON.parse(full) as Backup;
  parsed.users![0]!.username = "eindringling";
  const { preview } = await importFile(s.app, cookie, JSON.stringify(parsed), { "user:0": "new", settings: "replace", "event:0": "skip" });
  expect(preview).toContain("Keine Berechtigung");
  expect(count(s.db, "SELECT 1 FROM users")).toBe(users);

  const none = await loginAs(s.app, s.db, ["schedule"]);
  expect((await s.app.request("/admin/sicherung", { headers: { cookie: none } })).status).toBe(403);
});

test("a UTF-8 BOM and a Windows-1252 re-save are read correctly", async () => {
  const s = await source();
  const t = testApp();
  const cookie = await loginAs(t.app, t.db, [...PERMS]);
  const file = new TextEncoder().encode(await (await exportAll(s)).text());
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...file]);
  expect((await upload(t.app, cookie, bom)).status).toBe(200);

  // a Lageplan file saved as "ANSI": Latin-1 characters are single bytes
  const lageplan = JSON.stringify({ format: "diko-lageplan", version: 1, name: "Haus Größe Ä", floors: [], rooms: [{ name: "Saal ü", short: "", description: "", kind: "room", shape: null }] });
  const ansi = new Uint8Array([...lageplan].map((ch) => ch.charCodeAt(0)));
  const { preview } = await importFile(t.app, cookie, ansi);
  expect(preview).toContain("Haus Größe Ä");
  expect(t.db.query<{ name: string }, []>("SELECT name FROM rooms").get()!.name).toBe("Saal ü");
});

test("invalid files are refused with a German message", async () => {
  const s = await source();
  const res = await upload(s.app, s.cookie, "{kaputt");
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("kein gültiges JSON");
  const bad = { format: "konferenzkompass-sicherung", version: 1, files: { x: "data:text/html;base64,PGI+" }, events: [{ name: "", start_date: "x" }] };
  const { errors } = parseBackup(JSON.stringify(bad));
  expect(errors).toEqual(["Datei „x“: kein gültiges Bild (PNG, JPG, WebP, ICO, SVG).", "Veranstaltung 1: Name fehlt.", "Veranstaltung 1: erster Tag fehlt oder ist ungültig."]);
  expect(parseBackup(JSON.stringify({ format: "etwas", version: 1 })).errors[0]).toContain("keine KonferenzKompass-Sicherung");
});

test("a failing import changes nothing and leaves no new files behind", async () => {
  const s = await source();
  const data = JSON.parse(await (await exportAll(s)).text()) as Backup;
  (data.events![0]!.items[0] as any).kind = "unbekannt"; // breaks the CHECK constraint while writing
  const files = readdirSync(uploadDir()).length;
  const events = count(s.db, "SELECT 1 FROM events");
  const user = { id: 0, username: "niemand", perms: [...PERMS] };
  await expect(applyImport(s.db, data, { "event:0": "new", settings: "replace", "venue:0": "new" }, user)).rejects.toThrow();
  expect(count(s.db, "SELECT 1 FROM events")).toBe(events);
  expect(count(s.db, "SELECT 1 FROM venues")).toBe(1);
  expect(readdirSync(uploadDir()).length).toBe(files);
});
