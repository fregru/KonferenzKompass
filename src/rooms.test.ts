import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { copyEvent, getEvent, getItem, openDb, subItemsFor } from "./db";
import { dayItems, deleteItem, importSchedule, moveItem, subSlot } from "./plan";
import { scheduleFromCsv, scheduleToCsv } from "./csv";
import { itemsForEvent } from "./db";
import {
  centre, deleteRoom, exportVenue, floorsOf, importVenue, parseShape, parseVenueJson, roomMap, roomsOf, roomStatus, type VenueJson,
} from "./rooms";
import { saveData } from "./uploads";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "diko-rooms-"));
});

const D = "2026-11-13";
const SQUARE = "[[10,10],[30,10],[30,30],[10,30]]";

/** Venue with floor EG (Saal, S1, Foyer as area); event using it; parent "AKs" 10:00–12:00 with nothing in it yet. */
function setup() {
  const db = openDb(":memory:");
  const venue = Number(db.run("INSERT INTO venues (name) VALUES ('Haus')").lastInsertRowid);
  const floor = Number(db.run("INSERT INTO floors (venue_id, name) VALUES (?, 'EG')", [venue]).lastInsertRowid);
  const room = (name: string, kind = "room", short = "") =>
    Number(db.run("INSERT INTO rooms (venue_id, floor_id, name, short, kind, shape) VALUES (?, ?, ?, ?, ?, ?)", [venue, floor, name, short, kind, SQUARE]).lastInsertRowid);
  const saal = room("Saal"), s1 = room("Seminarraum 1", "room", "S1"), foyer = room("Foyer", "area");
  const ev = Number(db.run("INSERT INTO events (name, start_date, venue_id) VALUES ('Diko', ?, ?)", [D, venue]).lastInsertRowid);
  const add = (title: string, start: string, end: string, room: number | null, extra: { parent?: number; fixed?: number; sort?: number } = {}) =>
    Number(
      db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, room_id, parent_id, fixed, sort) VALUES (?, ?, ?, ?, ?, 'agenda', ?, ?, ?, ?)`,
        [ev, D, start, end, title, room, extra.parent ?? null, extra.fixed ?? 0, extra.sort ?? 0]).lastInsertRowid,
    );
  return { db, venue, floor, saal, s1, foyer, ev, add };
}

test("parseShape accepts polygons within 0–100 and rejects the rest", () => {
  expect(parseShape(SQUARE)).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]]);
  expect(parseShape("[[1,1],[2,2]]")).toBeNull();
  expect(parseShape("[[1,1],[2,2],[101,3]]")).toBeNull();
  expect(parseShape("nope")).toBeNull();
  expect(centre([[10, 10], [30, 10], [30, 30], [10, 30]])).toEqual([20, 20]);
});

test("roomStatus: overlapping entries block a room, touching ones do not, areas never", () => {
  const { db, ev, saal, s1, foyer, add } = setup();
  add("Plenum", "09:00", "10:30", saal, { sort: 0 });
  add("Kaffee", "09:00", "10:30", foyer, { sort: 1 });
  const status = (start: string, end: string) =>
    Object.fromEntries(roomStatus(db, getEvent(db, ev)!, D, start, end).map((s) => [s.room.name, s.conflicts.map((b) => b.item.title)]));
  expect(status("10:00", "11:00")).toEqual({ Saal: ["Plenum"], "Seminarraum 1": [], Foyer: [] });
  expect(status("10:30", "11:00")).toEqual({ Saal: [], "Seminarraum 1": [], Foyer: [] });
  void s1;
});

test("roomStatus ignores only the entry itself; parent and sub-points block each other", () => {
  const { db, ev, saal, s1, add } = setup();
  const parent = add("AKs", "10:00", "12:00", saal);
  const ak = add("AK 1", "10:00", "11:00", s1, { parent });
  const e = getEvent(db, ev)!;
  const taken = (room: number, selfId?: number) =>
    roomStatus(db, e, D, "10:00", "11:00", selfId).find((s) => s.room.id === room)!.conflicts.map((b) => b.item.title);
  expect(taken(saal, ak)).toEqual(["AKs"]); // a sub-point in its parent's room clashes
  expect(taken(s1, parent)).toEqual(["AK 1"]); // and the other way round
  expect(taken(s1, ak)).toEqual([]); // editing AK 1 itself
  expect(taken(saal)).toEqual(["AKs"]);
});

test("sub-points move with their parent, follow it to another day and are deleted with it", () => {
  const { db, ev, s1, add } = setup();
  const a = add("A", "09:00", "10:00", null, { fixed: 1, sort: 0 });
  const b = add("B", "10:00", "12:00", null, { sort: 1 });
  const ak1 = add("AK 1", "10:00", "11:00", s1, { parent: b });
  const ak2 = add("AK 2", "11:00", "12:00", s1, { parent: b, sort: 1 });
  expect(dayItems(db, ev, D).map((i) => i.title)).toEqual(["A", "B"]);
  db.run(`UPDATE items SET "end" = '10:30' WHERE id = ?`, [a]);
  moveItem(db, a, D, 0); // reflow: B now starts 10:30
  expect([getItem(db, ak1)!.start, getItem(db, ak2)!.start, getItem(db, ak2)!.end]).toEqual(["10:30", "11:30", "12:30"]);
  moveItem(db, b, "2026-11-14", 0, "14:00");
  expect([getItem(db, ak1)!.date, getItem(db, ak1)!.start]).toEqual(["2026-11-14", "14:00"]);
  deleteItem(db, b);
  expect(getItem(db, ak1)).toBeNull();
});

test("subSlot keeps sub-points inside their parent", () => {
  const p = { start: "10:00", end: "12:00" };
  expect(subSlot(p, "10:00", "12:00")).toBeNull();
  expect(subSlot(p, "11:00", "12:30")).toContain("10:00–12:00");
  expect(subSlot(p, "09:30", "10:30")).toContain("passen");
});

test("copyEvent copies sub-points with their room and venue", () => {
  const { db, ev, s1, add } = setup();
  const b = add("B", "10:00", "12:00", null, { fixed: 1 });
  add("AK 1", "10:00", "11:00", s1, { parent: b });
  const copy = copyEvent(db, ev, "Kopie", "2027-11-12");
  const [parent] = itemsForEvent(db, copy);
  expect(getEvent(db, copy)!.venue_id).toBe(getEvent(db, ev)!.venue_id);
  expect(subItemsFor(db, copy).get(parent!.id)!.map((s) => [s.title, s.room_id, s.date])).toEqual([["AK 1", s1, "2027-11-12"]]);
});

test("deleting a room keeps its name as free-text place", () => {
  const { db, saal, add } = setup();
  const it = add("Plenum", "09:00", "10:00", saal);
  deleteRoom(db, saal);
  expect(getItem(db, it)).toMatchObject({ room_id: null, location: "Saal" });
});

test("CSV: rooms are matched by name or short name, sub-points follow their parent; export round-trips", () => {
  const { db, ev, s1 } = setup();
  const csv = `Datum;Beginn;Dauer;Titel;Raum;Ort;Unterpunkt
13.11.2026;09:00;60;Plenum;saal;;
13.11.2026;;120;Arbeitskreise;;;
13.11.2026;;60;AK Finanzen;S1;;x
13.11.2026;11:00;60;AK Wahl;Turnhalle;hinten;x
`;
  const { rows, errors } = scheduleFromCsv(csv);
  expect(errors).toEqual([]);
  importSchedule(db, ev, rows);
  const [plenum, aks] = itemsForEvent(db, ev);
  expect(plenum!.room_id).not.toBeNull();
  const subs = subItemsFor(db, ev).get(aks!.id)!;
  expect(subs.map((s) => [s.title, s.start, s.end, s.room_id, s.location])).toEqual([
    ["AK Finanzen", "10:00", "11:00", s1, ""],
    ["AK Wahl", "11:00", "12:00", null, "Turnhalle, hinten"],
  ]);
  const again = scheduleFromCsv(scheduleToCsv(itemsForEvent(db, ev), subItemsFor(db, ev), roomMap(db, getEvent(db, ev)!.venue_id)).replace(/^﻿/, ""));
  expect(again.errors).toEqual([]);
  expect(again.rows.map((r) => [r.title, r.room, r.sub])).toEqual([
    ["Plenum", "Saal", false], ["Arbeitskreise", "", false], ["AK Finanzen", "Seminarraum 1", true], ["AK Wahl", "", true],
  ]);
  expect(scheduleFromCsv("Datum;Beginn;Dauer;Titel;Unterpunkt\n13.11.2026;09:00;30;Allein;x\n").errors[0]).toContain("Haupteintrag");
});

test("venue export/import round-trips floors, images and rooms; replacing keeps room ids by name", async () => {
  const { db, venue, floor, saal, add } = setup();
  const image = await saveData(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>"), "svg");
  db.run("UPDATE floors SET image = ? WHERE id = ?", [image, floor]);
  const it = add("Plenum", "09:00", "10:00", saal);
  const json = await exportVenue(db, venue);
  expect(json.floors[0]!.image).toStartWith("data:image/svg+xml;base64,");

  const parsed = parseVenueJson(JSON.stringify(json));
  expect(parsed.errors).toEqual([]);
  const copy = await importVenue(db, parsed.data!);
  expect(roomsOf(db, copy).map((r) => [r.name, r.kind, r.shape])).toEqual(roomsOf(db, venue).map((r) => [r.name, r.kind, r.shape]));
  const newImage = floorsOf(db, copy)[0]!.image;
  expect(newImage).not.toBe(image);
  expect(await Bun.file(join(process.env.UPLOAD_DIR!, newImage)).text()).toContain("<svg");

  const changed: VenueJson = { ...json, name: "Haus neu", floors: [{ ...json.floors[0]!, rooms: json.floors[0]!.rooms.filter((r) => r.name !== "Foyer") }] };
  await importVenue(db, parseVenueJson(JSON.stringify(changed)).data!, venue);
  expect(roomsOf(db, venue).map((r) => r.name)).toEqual(["Saal", "Seminarraum 1"]);
  expect(getItem(db, it)!.room_id).toBe(saal);
  expect(parseVenueJson('{"format":"x"}').errors[0]).toContain("kein Lageplan-Export");
  expect(parseVenueJson(JSON.stringify({ ...json, floors: [{ name: "EG", image: "data:text/html;base64,AA==", rooms: [] }] })).errors[0]).toContain("Bild ist ungültig");
});

test("old databases get the map page kind, Lageplan page and new columns", () => {
  const path = join(process.env.UPLOAD_DIR!, "old.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE pages (slug TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('link','markdown','legal')),
    title TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL DEFAULT '', direct INTEGER NOT NULL DEFAULT 0);
    INSERT INTO pages (slug, kind, title, body) VALUES ('unterlagen', 'link', 'Meine Unterlagen', 'Text');
    CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','active','archived')) DEFAULT 'draft', intro TEXT NOT NULL DEFAULT '');
    INSERT INTO events (name, start_date) VALUES ('Alt', '2025-11-14');
    CREATE TABLE page_links (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
      page_slug TEXT NOT NULL REFERENCES pages, label TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
    INSERT INTO page_links (event_id, page_slug, label, url) VALUES (1, 'unterlagen', 'Cloud', 'https://example.org');
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]');
    INSERT INTO users (username, hash, perms) VALUES ('admin', 'x', '["schedule","users"]'), ('helfer', 'x', '["schedule"]');`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT kind, title FROM pages WHERE slug = 'lageplan'").get()).toEqual({ kind: "map", title: "Lageplan" });
  expect(db.query("SELECT title, body FROM pages WHERE slug = 'unterlagen'").get()).toEqual({ title: "Meine Unterlagen", body: "Text" });
  expect(db.query("SELECT label FROM page_links").all()).toEqual([{ label: "Cloud" }]);
  expect(db.query("SELECT venue_id FROM events").get()).toEqual({ venue_id: null });
  expect(db.query("SELECT perms FROM users ORDER BY id").all()).toEqual([{ perms: '["schedule","users","map"]' }, { perms: '["schedule"]' }]);
  db.close();
});

test("sub-points must still fit when their parent gets shorter, and on CSV import", async () => {
  const { testApp, loginAs, post } = await import("./test-helpers");
  const t = testApp();
  const ev = Number(t.db.run("INSERT INTO events (name, start_date) VALUES ('Diko', ?)", [D]).lastInsertRowid);
  const p = Number(t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, fixed) VALUES (?, ?, '10:00', '12:00', 'AKs', 'agenda', 1)`, [ev, D]).lastInsertRowid);
  t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, parent_id) VALUES (?, ?, '11:00', '12:00', 'AK 2', 'agenda', ?)`, [ev, D, p]);
  const cookie = await loginAs(t.app, t.db, ["schedule"]);
  const edit = (duration: string) => post(t.app, `/admin/items/${p}`, { date: D, start: "10:00", duration, title: "AKs", kind: "agenda", fixed: "1" }, cookie);
  const res = await edit("90");
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("„AK 2“ passt nicht mehr");
  expect((await edit("120")).status).toBe(302);

  const { rows, errors } = scheduleFromCsv("Datum;Beginn;Dauer;Titel;Unterpunkt\n13.11.2026;09:00;60;Plenum;\n13.11.2026;09:30;60;Zu lang;x\n");
  expect(errors).toEqual([]);
  expect(() => importSchedule(t.db, ev, rows)).toThrow("Zeile 3: Unterpunkte müssen in die Zeit des Eintrags passen");
  expect(itemsForEvent(t.db, ev).map((i) => i.title)).toEqual(["AKs"]); // rolled back
});

test("migrations are counted in user_version and not run again", () => {
  const path = join(process.env.UPLOAD_DIR!, "migrate.db");
  const db = openDb(path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  // would get the map permission if the first step ran again
  db.run("DELETE FROM settings WHERE key = 'perm_map_granted'");
  db.run(`INSERT INTO users (username, hash, perms) VALUES ('a', 'x', '["users"]')`);
  db.close();
  const again = openDb(path);
  expect(again.query("SELECT perms FROM users").get()).toEqual({ perms: '["users"]' });
  again.close();
});
