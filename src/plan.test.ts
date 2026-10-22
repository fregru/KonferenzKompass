import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { initOrder, openDb } from "./db";
import { clashes, dayItems, deleteItem, moveItem } from "./plan";
import { loginAs, post, testApp } from "./test-helpers";

const D = "2026-11-13";

/** A=09:00 60', B 30', M fixed 12:00 60' (break), C 45' – all on one day, ordered. */
function setup() {
  const t = testApp();
  const ev = Number(t.db.run("INSERT INTO events (name, start_date) VALUES ('Diko', ?)", [D]).lastInsertRowid);
  const ids: Record<string, number> = {};
  const rows: [string, string, string, string, number][] = [
    ["A", "09:00", "10:00", "agenda", 0], ["B", "10:00", "10:30", "agenda", 0],
    ["M", "12:00", "13:00", "break", 1], ["C", "13:00", "13:45", "agenda", 0],
  ];
  rows.forEach(([title, start, end, kind, fixed], sort) => {
    ids[title] = Number(t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, fixed, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ev, D, start, end, title, kind, fixed, sort]).lastInsertRowid);
  });
  return { ...t, ev, ids };
}
const times = (db: Database, ev: number, date = D) => dayItems(db, ev, date).map((i) => `${i.title} ${i.start}-${i.end}`);

test("moving a flowing entry recalculates the day; fixed entries keep their time", () => {
  const { db, ev, ids } = setup();
  moveItem(db, ids.B!, D, 0);
  expect(times(db, ev)).toEqual(["B 09:00-09:30", "A 09:30-10:30", "M 12:00-13:00", "C 13:00-13:45"]);
  moveItem(db, ids.C!, D, 1);
  expect(times(db, ev)).toEqual(["B 09:00-09:30", "C 09:30-10:15", "A 10:15-11:15", "M 12:00-13:00"]);
});

test("a fixed entry moved before flowing ones keeps its time and shows the overlap", () => {
  const { db, ev, ids } = setup();
  moveItem(db, ids.M!, D, 1);
  expect(times(db, ev)).toEqual(["A 09:00-10:00", "M 12:00-13:00", "B 13:00-13:30", "C 13:30-14:15"]);
  db.run("UPDATE items SET \"end\" = '12:30' WHERE id = ?", [ids.A!]); // A now runs 30 min into the break
  const day = dayItems(db, ev, D);
  expect(clashes(day).get(ids.M!)).toMatchObject({ minutes: 30, with: { title: "A" } });
});

test("moving to another day: both days close up, the new day keeps its start", () => {
  const { db, ev, ids } = setup();
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, sort) VALUES (?, '2026-11-14', '08:30', '09:00', 'X', 'agenda', 0)`, [ev]);
  moveItem(db, ids.A!, "2026-11-14", 0);
  expect(times(db, ev)).toEqual(["B 09:00-09:30", "M 12:00-13:00", "C 13:00-13:45"]);
  expect(times(db, ev, "2026-11-14")).toEqual(["A 08:30-09:30", "X 09:30-10:00"]);
});

test("deleting an entry closes the gap", () => {
  const { db, ev, ids } = setup();
  deleteItem(db, ids.A!);
  expect(times(db, ev)).toEqual(["B 09:00-09:30", "M 12:00-13:00", "C 13:00-13:45"]);
});

test("↑/↓ and drag-and-drop endpoint", async () => {
  const { app, db, ev, ids } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  expect((await post(app, `/admin/items/${ids.B}/move`, { dir: "up" }, cookie)).status).toBe(302);
  expect(times(db, ev)[0]).toBe("B 09:00-09:30");
  await post(app, `/admin/items/${ids.B}/move`, { date: D, index: "3" }, cookie);
  expect(times(db, ev).at(-1)).toBe("B 13:45-14:15");
  expect((await post(app, `/admin/items/${ids.B}/move`, { date: "kaputt", index: "0" }, cookie)).status).toBe(400);
  const html = await (await app.request(`/admin/events/${ev}/items`, { headers: { cookie } })).text();
  expect(html).toContain(`data-sortable="${D}"`);
  expect(html).toMatch(/<script src="\/static\/vendor\/sortable\.js\?v=\w+" defer/);
  expect((await app.request("/static/vendor/sortable.js")).status).toBe(200);
});

test("editing a flowing first entry's start moves the whole day; editing a duration shifts the rest", async () => {
  const { app, db, ev, ids } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  await post(app, `/admin/items/${ids.A}`, { date: D, start: "08:00", duration: "60", title: "A", kind: "agenda" }, cookie);
  expect(times(db, ev).slice(0, 2)).toEqual(["A 08:00-09:00", "B 09:00-09:30"]);
  await post(app, `/admin/items/${ids.A}`, { date: D, start: "08:00", duration: "90", title: "A", kind: "agenda" }, cookie);
  expect(times(db, ev).slice(0, 2)).toEqual(["A 08:00-09:30", "B 09:30-10:00"]);
});

test("migration derives order and anchors without changing any time", () => {
  const db = openDb(":memory:");
  const ev = Number(db.run("INSERT INTO events (name, start_date) VALUES ('Alt', ?)", [D]).lastInsertRowid);
  for (const [start, end, title, kind] of [
    ["09:00", "10:00", "A", "agenda"], ["10:00", "10:30", "B", "agenda"], ["10:45", "11:30", "C", "agenda"], ["12:00", "13:00", "M", "break"],
  ])
    db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, ?, ?, ?, ?, ?)`, [ev, D, start!, end!, title!, kind!]);
  initOrder(db);
  expect(dayItems(db, ev, D).map((i) => `${i.title}${i.fixed ? "*" : ""}${i.sort}`)).toEqual(["A0", "B1", "C*2", "M*3"]);
  moveItem(db, dayItems(db, ev, D)[1]!.id, D, 1); // recalculating changes nothing
  expect(times(db, ev)).toEqual(["A 09:00-10:00", "B 10:00-10:30", "C 10:45-11:30", "M 12:00-13:00"]);
});
