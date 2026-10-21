import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { getItem, subItemsFor } from "./db";
import { floorsOf, roomsOf } from "./rooms";
import { loginAs, post, testApp } from "./test-helpers";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "diko-venues-"));
});

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 60'><rect width='100' height='60'/></svg>";

function multipart(app: Hono, path: string, fields: Record<string, string | File>, cookie: string) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return app.request(path, { method: "POST", body, headers: { origin: "http://localhost", cookie } });
}

/** Admin with map + schedule rights, venue "Haus" with floor EG (SVG) and rooms Saal and S1, active event using it. */
async function setup(clock?: () => number) {
  const t = testApp(clock);
  const cookie = await loginAs(t.app, t.db, ["map", "schedule", "events"]);
  await post(t.app, "/admin/venues", { name: "Haus" }, cookie);
  const venue = t.db.query<{ id: number }, []>("SELECT id FROM venues").get()!.id;
  await multipart(t.app, `/admin/venues/${venue}/floors`, { name: "EG", image: new File([SVG], "eg.svg") }, cookie);
  const floor = floorsOf(t.db, venue)[0]!;
  await post(t.app, `/admin/venues/${venue}/rooms`, { name: "Saal", floor_id: String(floor.id), kind: "room" }, cookie);
  await post(t.app, `/admin/venues/${venue}/rooms`, { name: "Seminarraum 1", short: "S1", floor_id: String(floor.id), kind: "room" }, cookie);
  const [saal, s1] = roomsOf(t.db, venue);
  const ev = Number(t.db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', '2026-11-13', 'active')").lastInsertRowid);
  await post(t.app, `/admin/events/${ev}/venue`, { venue_id: String(venue) }, cookie);
  return { ...t, cookie, venue, floor, saal: saal!, s1: s1!, ev };
}

const item = { date: "2026-11-13", start: "10:00", duration: "60", kind: "agenda", fixed: "1" };

test("the Lageplan admin needs the map permission", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["schedule"]);
  expect((await app.request("/admin/venues", { headers: { cookie } })).status).toBe(403);
});

test("venue, floor upload and rooms are created; shapes are saved from the editor and validated", async () => {
  const { app, db, cookie, floor, saal } = await setup();
  expect(floor.image).toMatch(/\.svg$/);
  const draw = await (await app.request(`/admin/floors/${floor.id}/draw`, { headers: { cookie } })).text();
  expect(draw).toContain('id="rooms-data"');
  expect(draw).toContain('"name":"Saal"');

  const bad = await post(app, `/admin/rooms/${saal.id}/shape`, { shape: "[[0,0],[1,1]]", floor_id: String(floor.id) }, cookie);
  expect(bad.status).toBe(400);
  const ok = await post(app, `/admin/rooms/${saal.id}/shape`, { shape: "[[10,10],[40,10],[40,30],[10,30]]", floor_id: String(floor.id) }, cookie);
  expect(await ok.json()).toEqual({ ok: true, shape: [[10, 10], [40, 10], [40, 30], [10, 30]] });
  expect(roomsOf(db, saal.venue_id)[0]!.shape).toBe("[[10,10],[40,10],[40,30],[10,30]]");
  // duplicate names are refused
  expect((await post(app, `/admin/venues/${saal.venue_id}/rooms`, { name: "saal", floor_id: String(floor.id) }, cookie)).status).toBe(400);
});

test("export downloads JSON that imports as a new venue", async () => {
  const { app, db, cookie, venue } = await setup();
  const res = await app.request(`/admin/venues/${venue}/export.json`, { headers: { cookie } });
  expect(res.headers.get("content-disposition")).toContain("lageplan-haus.json");
  const text = await res.text();
  const imp = await multipart(app, "/admin/venues/import", { file: new File([text], "lageplan.json"), target: "" }, cookie);
  expect(imp.status).toBe(302);
  expect(db.query("SELECT name FROM venues ORDER BY id").all()).toEqual([{ name: "Haus" }, { name: "Haus" }]);
  const bad = await multipart(app, "/admin/venues/import", { file: new File(["{}"], "x.json"), target: "" }, cookie);
  expect(bad.status).toBe(400);
});

test("public map page: menu entry, floor plan, deep link to a room with today's entries, search list", async () => {
  const { app, db, cookie, floor, saal, ev } = await setup(() => Date.parse("2026-11-13T09:00:00+01:00"));
  await post(app, `/admin/rooms/${saal.id}/shape`, { shape: "[[10,10],[40,10],[40,30],[10,30]]", floor_id: String(floor.id) }, cookie);
  await post(app, `/admin/events/${ev}/items/new`, { ...item, title: "Plenum", room_id: String(saal.id) }, cookie);

  const home = await (await app.request("/")).text();
  expect(home).toContain('href="/p/lageplan"');
  expect(home).toMatch(new RegExp(`href="/p/lageplan\\?raum=${saal.id}&amp;von=\\d+#karte"`)); // room link in the schedule

  const html = await (await app.request(`/p/lageplan?raum=${saal.id}`)).text();
  expect(html).toContain(`src="/uploads/${floor.image}"`);
  expect(html).toContain('<polygon class="room active"');
  expect(html).toContain("Heute hier");
  expect(html).toContain("Plenum");
  expect(html).toContain("Seminarraum 1 (S1)");

  db.run("UPDATE pages SET enabled = 0 WHERE slug = 'lageplan'");
  expect((await app.request("/p/lageplan")).status).toBe(404);
  const plain = await (await app.request("/")).text();
  expect(plain).not.toContain("raum=");
  expect(plain).toContain("Saal");
});

test("item form shows room availability and asks before double-booking", async () => {
  const { app, db, cookie, ev, saal } = await setup();
  await post(app, `/admin/events/${ev}/items/new`, { ...item, title: "Plenum", room_id: String(saal.id) }, cookie);
  const form = await (await app.request(`/admin/events/${ev}/items/new`, { headers: { cookie } })).text();
  expect(form).toContain(`<option value="${saal.id}" selected="">Saal</option>`); // taken over from the previous entry; no time yet, so no state

  const check = await post(app, `/admin/events/${ev}/items/new`, { ...item, start: "10:30", title: "X", check: "1" }, cookie);
  expect(check.status).toBe(200);
  const checked = await check.text();
  expect(checked).toContain("Saal – belegt: Plenum (10:00–11:00)");
  expect(checked).toContain("Raumübersicht 10:30–11:30: 1 Raum frei");

  const clash = await post(app, `/admin/events/${ev}/items/new`, { ...item, start: "10:30", title: "Doppelt", room_id: String(saal.id) }, cookie);
  expect(clash.status).toBe(400);
  expect(await clash.text()).toContain("Saal ist um diese Zeit schon belegt");
  const forced = await post(app, `/admin/events/${ev}/items/new`, { ...item, start: "10:30", title: "Doppelt", room_id: String(saal.id), double: "1" }, cookie);
  expect(forced.status).toBe(302);
  expect(db.query("SELECT COUNT(*) AS n FROM items WHERE room_id = ?").get(saal.id)).toEqual({ n: 2 });

  const occ = await (await app.request(`/admin/events/${ev}/rooms?date=2026-11-13`, { headers: { cookie } })).text();
  expect(occ).toContain("slot clash");
});

test("sub-points: created inside the parent's time, parallel in different rooms, shown publicly", async () => {
  const { app, db, cookie, ev, saal, s1 } = await setup(() => Date.parse("2026-11-13T09:00:00+01:00"));
  await post(app, `/admin/events/${ev}/items/new`, { ...item, duration: "120", title: "Arbeitskreise" }, cookie);
  const parent = db.query<{ id: number }, []>("SELECT id FROM items").get()!.id;
  const sub = (title: string, room: number, start = "10:00") =>
    post(app, `/admin/items/${parent}/subs/new`, { title, start, duration: "120", room_id: String(room) }, cookie);
  expect((await sub("AK Finanzen", saal.id)).status).toBe(302);
  expect((await sub("AK Wahl", s1.id)).status).toBe(302);
  expect((await sub("Zu spät", s1.id, "11:00")).status).toBe(400); // runs past the parent
  expect((await sub("Gleicher Raum", s1.id)).status).toBe(400); // S1 is taken by AK Wahl
  const subs = subItemsFor(db, ev).get(parent)!;
  expect(subs.map((s) => [s.title, s.date, s.fixed])).toEqual([["AK Finanzen", "2026-11-13", 0], ["AK Wahl", "2026-11-13", 0]]);

  // moving the parent's start moves its sub-points
  await post(app, `/admin/items/${parent}`, { ...item, duration: "120", title: "Arbeitskreise", start: "14:00" }, cookie);
  expect(getItem(db, subs[0]!.id)!.start).toBe("14:00");

  const edit = await (await app.request(`/admin/items/${parent}`, { headers: { cookie } })).text();
  expect(edit).toContain("Unterpunkte");
  expect(edit).toContain("AK Wahl");
  const home = await (await app.request("/")).text();
  expect(home).toContain('class="subs"');
  expect(home).toContain("AK Finanzen");
  // sub-points cannot be dragged around on their own
  expect((await post(app, `/admin/items/${subs[0]!.id}/move`, { dir: "up" }, cookie)).status).toBe(404);
});

test("admin pages for venues, rooms and the event venue render", async () => {
  const { app, cookie, venue, saal, ev } = await setup();
  for (const [path, text] of [
    ["/admin/venues", "Haus"], [`/admin/venues/${venue}`, "Räume einzeichnen (2)"], [`/admin/rooms/${saal.id}`, "Im Plan einzeichnen"],
    [`/admin/events/${ev}`, `<option value="${venue}" selected="">Haus</option>`], [`/admin/events/${ev}/items`, "Raumbelegung"],
  ] as const) {
    const res = await app.request(path, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(text);
  }
});

test("a sub-point in its parent's room counts as double booking", async () => {
  const { app, db, cookie, ev, saal } = await setup();
  await post(app, `/admin/events/${ev}/items/new`, { ...item, duration: "120", title: "Arbeitskreise", room_id: String(saal.id) }, cookie);
  const parent = db.query<{ id: number }, []>("SELECT id FROM items").get()!.id;
  const form = await (await app.request(`/admin/items/${parent}/subs/new`, { headers: { cookie } })).text();
  expect(form).toContain("Saal – belegt: Arbeitskreise (10:00–12:00)");
  const res = await post(app, `/admin/items/${parent}/subs/new`, { title: "AK", start: "10:00", duration: "60", room_id: String(saal.id) }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Saal ist um diese Zeit schon belegt: Arbeitskreise");
  // editing the parent itself does not clash with itself
  expect((await post(app, `/admin/items/${parent}`, { ...item, duration: "120", title: "Arbeitskreise", room_id: String(saal.id) }, cookie)).status).toBe(302);
});

test("occupancy always shows the whole day; late bookings are cut at midnight", async () => {
  const { app, cookie, ev, saal } = await setup();
  await post(app, `/admin/events/${ev}/items/new`, { ...item, start: "23:00", duration: "120", title: "Party", room_id: String(saal.id) }, cookie);
  const html = await (await app.request(`/admin/events/${ev}/rooms?date=2026-11-13`, { headers: { cookie } })).text();
  expect(html).toContain('<span class="first" style="left:0%">00</span>');
  expect(html).toContain(">23</span>");
  expect(html).toContain(`left:${(23 / 24) * 100}%;width:${(1 / 24) * 100}%`);
});

test("a room opened from the schedule offers the way back to that entry", async () => {
  const { app, db } = testApp();
  const venue = Number(db.run("INSERT INTO venues (name) VALUES ('Haus')").lastInsertRowid);
  const room = Number(db.run("INSERT INTO rooms (venue_id, name) VALUES (?, 'Saal')", [venue]).lastInsertRowid);
  const ev = Number(db.run("INSERT INTO events (name, start_date, status, venue_id) VALUES ('Diko', '2026-11-13', 'active', ?)", [venue]).lastInsertRowid);
  const item = Number(db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, room_id) VALUES (?, '2026-11-13', '09:00', '10:00', 'Wahlen', 'agenda', ?)`, [ev, room]).lastInsertRowid);
  const sub = Number(db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, room_id, parent_id) VALUES (?, '2026-11-13', '09:00', '10:00', 'AG', 'agenda', ?, ?)`, [ev, room, item]).lastInsertRowid);

  const start = await (await app.request("/")).text();
  expect(start).toContain(`id="e${item}"`);
  expect(start).toContain(`/p/lageplan?raum=${room}&amp;von=${item}#karte`);
  expect(start).toContain(`/p/lageplan?raum=${room}&amp;von=${sub}#karte`);

  expect(await (await app.request(`/p/lageplan?raum=${room}&von=${item}`)).text()).toContain(`href="/#e${item}"`);
  expect(await (await app.request(`/p/lageplan?raum=${room}&von=${sub}`)).text()).toContain(`href="/#e${item}"`); // sub-point: its main entry
  expect(await (await app.request(`/p/lageplan?raum=${room}`)).text()).not.toContain("Zurück zum Zeitplan");
  expect(await (await app.request(`/p/lageplan?raum=${room}&von=999`)).text()).not.toContain("Zurück zum Zeitplan");
});
