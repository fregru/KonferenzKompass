import { beforeAll, expect, test } from "bun:test";
import { activeEvent, getSetting } from "./db";
import { seedExample } from "./example";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testApp } from "./test-helpers";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "diko-example-"));
});

const now = Date.parse("2026-11-13T10:00:00+01:00");

test("first start creates an active three-day example event with intro, FAQ, contact and links", async () => {
  const { app, db } = testApp(() => now);
  expect(await seedExample(db, now)).toBe(true);
  const ev = activeEvent(db)!;
  expect(ev.start_date).toBe("2026-11-13");
  const days = db.query<{ date: string }, [number]>("SELECT DISTINCT date FROM items WHERE event_id = ? ORDER BY date").all(ev.id).map((r) => r.date);
  expect(days).toEqual(["2026-11-13", "2026-11-14", "2026-11-15"]);
  expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'break'").get()).not.toEqual({ n: 0 });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM faq").get()!.n).toBeGreaterThanOrEqual(4);
  expect(db.query("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM page_links").get()!.n).toBeGreaterThanOrEqual(3);
  expect(ev.name).toContain("Beispiel");
  expect((await app.request("/")).status).toBe(200);
});

test("example is created only once, never when events already exist", async () => {
  const { db } = testApp();
  expect(await seedExample(db, now)).toBe(true);
  db.run("DELETE FROM events");
  expect(await seedExample(db, now)).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });

  const other = testApp().db;
  other.run("INSERT INTO events (name, start_date) VALUES ('Echt', '2026-01-01')");
  expect(await seedExample(other, now)).toBe(false);
  expect(getSetting(other, "example_seeded")).toBe("1");
});

test("example keeps existing page texts", async () => {
  const { db } = testApp();
  db.run("UPDATE pages SET body = 'Eigener Text' WHERE slug = 'impressum'");
  await seedExample(db, now);
  expect(db.query("SELECT body FROM pages WHERE slug = 'impressum'").get()).toEqual({ body: "Eigener Text" });
});

test("example days have no gaps between entries", async () => {
  const { db } = testApp();
  await seedExample(db, now);
  const items = db.query<{ date: string; start: string; end: string }, []>('SELECT date, start, "end" FROM items WHERE parent_id IS NULL ORDER BY date, start').all();
  for (let i = 1; i < items.length; i++)
    if (items[i]!.date === items[i - 1]!.date) expect(`${items[i]!.date} ${items[i]!.start}`).toBe(`${items[i]!.date} ${items[i - 1]!.end}`);
});

test("example is held in Haus Altenberg: floor plans, drawn rooms, schedule entries in those rooms", async () => {
  const { app, db } = testApp(() => now);
  await seedExample(db, now);
  const ev = activeEvent(db)!;
  expect(ev.venue_id).not.toBeNull();
  const floors = db.query<{ image: string }, [number]>("SELECT image FROM floors WHERE venue_id = ?").all(ev.venue_id!);
  expect(floors.length).toBe(4);
  for (const f of floors) expect(await Bun.file(join(process.env.UPLOAD_DIR!, f.image)).exists()).toBe(true);
  const room = (name: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM items JOIN rooms ON rooms.id = items.room_id WHERE rooms.name = ?").get(name)!.n;
  expect(room("Kapitelsaal")).toBeGreaterThan(3);
  expect(room("Christkönigskapelle")).toBe(1);
  const ags = db.query<{ title: string; room_id: number | null }, []>("SELECT title, room_id FROM items WHERE parent_id IS NOT NULL").all();
  expect(ags.length).toBe(4);
  expect(ags.every((a) => a.room_id !== null)).toBe(true);
  // free-text places stay text
  expect(db.query("SELECT room_id FROM items WHERE location = 'Speisesaal' LIMIT 1").get()).toEqual({ room_id: null });
  expect(await (await app.request("/p/lageplan")).text()).toContain("Kapitelsaal");
});

test("an existing venue is left alone: the example then has no rooms", async () => {
  const { db } = testApp();
  db.run("INSERT INTO venues (name) VALUES ('Eigenes Haus')");
  await seedExample(db, now);
  expect(db.query("SELECT COUNT(*) AS n FROM venues").get()).toEqual({ n: 1 });
  expect(activeEvent(db)!.venue_id).toBeNull();
  expect(db.query("SELECT location FROM items WHERE title = 'Wahlen'").get()).toEqual({ location: "Kapitelsaal" });
});
