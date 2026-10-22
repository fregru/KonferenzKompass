import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { back, getLive, liveInput, next, pauseUntil, setDone, startItem, startPause, stopNow } from "./live";
import { getSetting } from "./db";
import { loginAs, post, testApp } from "./test-helpers";
import { berlinNow, fmt } from "./time";

/** Berlin wall-clock time on the event day (CET, UTC+1). */
const at = (hhmm: string, date = "2026-11-13") => Date.parse(`${date}T${hhmm}:00+01:00`);

function setup(date = "2026-11-13") {
  const t = testApp();
  const ev = Number(t.db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', '2026-11-13', 'active')").lastInsertRowid);
  const ids: Record<string, number> = {};
  for (const [name, start, end, kind] of [
    ["A", "09:00", "10:00", "agenda"], ["B", "10:00", "11:00", "agenda"], ["C", "11:00", "12:00", "agenda"],
    ["M", "12:00", "13:00", "break"], ["D", "13:00", "14:00", "agenda"],
  ])
    ids[name!] = Number(t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, ?, ?, ?, ?, ?)`,
      [ev, date, start!, end!, name!, kind!]).lastInsertRowid);
  return { ...t, ev, ids };
}
const done = (db: Database, id: number) => db.query<{ done: number }, [number]>("SELECT done FROM items WHERE id = ?").get(id)!.done;

test("next from nothing starts first item, again marks it done and starts second", () => {
  const { db, ev, ids } = setup();
  next(db, ev, at("09:00"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.A, started_at: at("09:00") });
  next(db, ev, at("09:55"));
  expect(done(db, ids.A!)).toBe(1);
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.B, started_at: at("09:55") });
});

test("back after next un-marks the done item", () => {
  const { db, ev, ids } = setup();
  next(db, ev, at("09:00"));
  next(db, ev, at("10:00"));
  back(db, ev);
  expect(done(db, ids.A!)).toBe(0);
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.A });
});

test("liveInput is null when the current item was started on a previous day", () => {
  const { db, ev, ids } = setup();
  startItem(db, ev, ids.A!, at("09:00"));
  expect(liveInput(db, ev, at("09:30"))).toMatchObject({ currentItemId: ids.A, startedAt: 540 });
  expect(liveInput(db, ev, at("09:30", "2026-11-14"))).toBeNull();
});

test("deleting the current item clears live state and start page still renders", async () => {
  const { app, db, ev, ids } = setup();
  startItem(db, ev, ids.A!, Date.now());
  const cookie = await loginAs(app, db, ["schedule"]);
  await post(app, `/admin/items/${ids.A}/delete`, {}, cookie);
  expect(getLive(db, ev)!.current_item_id).toBeNull();
  expect((await app.request("/")).status).toBe(200);
});

test("live control page shows current item and buttons work", async () => {
  const { app, db, ev } = setup(berlinNow().date);
  const cookie = await loginAs(app, db, ["schedule"]);
  expect((await post(app, "/admin/live/next", {}, cookie)).status).toBe(302);
  expect(getLive(db, ev)!.current_item_id).not.toBeNull();
  const html = await (await app.request("/admin/live", { headers: { cookie } })).text();
  expect(html).toContain("Weiter");
  expect(html).toContain("Pause starten");
  const err = await post(app, "/admin/live/pause", { title: "Kaffee", minutes: "999" }, cookie);
  expect(err.status).toBe(400);
  expect(await err.text()).toContain("zwischen 1 und 720");
});

test("actions on the next day ignore yesterday's live state (daily reset)", () => {
  const { db, ev, ids } = setup();
  const b2 = Number(db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, '2026-11-14', '09:00', '09:30', 'B2', 'break')`, [ev]).lastInsertRowid);
  startItem(db, ev, ids.A!, at("10:05"));
  startPause(db, ev, { title: "Kaffee", until: at("09:30", "2026-11-14"), mode: "interrupt" }, at("09:10", "2026-11-14"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: null, elapsed_before: 0, pause_title: "Kaffee" });
  next(db, ev, at("09:20", "2026-11-14"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: null, pause_until: null });
  expect(done(db, b2)).toBe(0); // no agenda item follows, so the break is not passed
  back(db, ev);
  back(db, ev); // must not restore yesterday's state
  expect(getLive(db, ev)).toBeNull();
});

test("stopNow ends the running item without starting the next; back undoes it", () => {
  const { db, ev, ids } = setup();
  next(db, ev, at("09:00"));
  stopNow(db, ev, at("09:50"));
  expect(done(db, ids.A!)).toBe(1);
  expect(getLive(db, ev)).toMatchObject({ current_item_id: null, pause_until: null });
  back(db, ev);
  expect(done(db, ids.A!)).toBe(0);
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.A });
});

test("Nichts läuft button and next-item switch on the live screen", async () => {
  const { app, db, ev } = setup(berlinNow().date);
  const cookie = await loginAs(app, db, ["schedule"]);
  await post(app, "/admin/live/next", {}, cookie);
  expect((await post(app, "/admin/live/stop", {}, cookie)).status).toBe(302);
  expect(getLive(db, ev)!.current_item_id).toBeNull();
  expect(await (await app.request("/admin/live", { headers: { cookie } })).text()).toContain("Nichts läuft");
  await post(app, "/admin/live/show-next", { show_next: "0" }, cookie);
  expect(getSetting(db, "show_next")).toBe("0");
  await post(app, "/admin/live/show-next", { show_next: "1" }, cookie);
  expect(getSetting(db, "show_next")).toBe("1");
});

test("setDone marks an item done and open again; back undoes each step", () => {
  const { db, ev, ids } = setup();
  setDone(db, ev, ids.B!, true, at("09:00"));
  expect(done(db, ids.B!)).toBe(1);
  setDone(db, ev, ids.B!, false, at("09:01"));
  expect(done(db, ids.B!)).toBe(0);
  back(db, ev);
  expect(done(db, ids.B!)).toBe(1);
  back(db, ev);
  expect(done(db, ids.B!)).toBe(0);
});

test("live screen offers Erledigt / Wieder öffnen per entry", async () => {
  const { app, db, ids } = setup(berlinNow().date);
  const cookie = await loginAs(app, db, ["schedule"]);
  const html = await (await app.request("/admin/live", { headers: { cookie } })).text();
  expect(html).toContain(`action="/admin/live/done/${ids.A}"`);
  expect(html).toContain("Erledigt");
  expect(html.indexOf(`/admin/live/done/${ids.B}`)).toBeLessThan(html.indexOf(`/admin/live/start/${ids.B}`)); // Erledigt left of Jetzt starten
  expect(html).toMatch(/<script src="\/static\/admin\.js\?v=\w+" defer/);
  await post(app, `/admin/live/done/${ids.A}`, { done: "1" }, cookie);
  expect(done(db, ids.A!)).toBe(1);
  expect(await (await app.request("/admin/live", { headers: { cookie } })).text()).toContain("TOP öffnen");
  await post(app, `/admin/live/done/${ids.A}`, { done: "0" }, cookie);
  expect(done(db, ids.A!)).toBe(0);
});

test("live screen splits into control and schedule columns", async () => {
  const { app, db } = setup(berlinNow().date);
  const cookie = await loginAs(app, db, ["schedule"]);
  const html = await (await app.request("/admin/live", { headers: { cookie } })).text();
  expect(html.indexOf('<div class="livegrid"')).toBeGreaterThan(0);
  expect(html.indexOf('class="livecontrol"')).toBeLessThan(html.indexOf('class="liveplan"'));
  // upcoming items sit at the bottom of the left column, below the next-item switch
  expect(html.indexOf("Als Nächstes")).toBeGreaterThan(html.indexOf("/admin/live/show-next"));
  expect(html.indexOf("Als Nächstes")).toBeLessThan(html.indexOf('class="liveplan"'));
});

test("pause interrupts the running item; Weiter resumes it with its elapsed time", () => {
  const { db, ev, ids } = setup();
  startItem(db, ev, ids.C!, at("11:00"));
  startPause(db, ev, { title: "Kaffee", until: at("11:45"), mode: "interrupt" }, at("11:30"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.C, started_at: null, elapsed_before: 30, pause_title: "Kaffee", pause_until: at("11:45") });
  expect(liveInput(db, ev, at("11:40"))).toMatchObject({ currentItemId: ids.C, pause: { title: "Kaffee", start: 690, until: 705 } });
  next(db, ev, at("11:50"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.C, started_at: at("11:50"), elapsed_before: 30, pause_until: null });
  expect(done(db, ids.C!)).toBe(0);
});

test("planned break with close: item done, break passed, Weiter starts the next agenda item; back undoes", () => {
  const { db, ev, ids } = setup();
  db.run("UPDATE items SET done = 1 WHERE id IN (?, ?)", [ids.A!, ids.B!]);
  startItem(db, ev, ids.C!, at("11:00"));
  startPause(db, ev, { title: "Mittag", until: at("13:00"), mode: "close", breakId: ids.M }, at("11:55"));
  expect(done(db, ids.C!)).toBe(1);
  expect(done(db, ids.M!)).toBe(1);
  expect(getLive(db, ev)).toMatchObject({ current_item_id: null, pause_title: "Mittag" });
  next(db, ev, at("13:00"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.D, pause_until: null });
  back(db, ev);
  back(db, ev);
  expect(done(db, ids.C!)).toBe(0);
  expect(done(db, ids.M!)).toBe(0);
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.C, started_at: at("11:00"), pause_until: null });
});

test("Weiter skips a planned break and marks it passed; back reopens it", () => {
  const { db, ev, ids } = setup();
  db.run("UPDATE items SET done = 1 WHERE id IN (?, ?)", [ids.A!, ids.B!]);
  startItem(db, ev, ids.C!, at("11:00"));
  next(db, ev, at("12:00"));
  expect(getLive(db, ev)!.current_item_id).toBe(ids.D!);
  expect(done(db, ids.M!)).toBe(1);
  back(db, ev);
  expect(done(db, ids.M!)).toBe(0);
  expect(done(db, ids.C!)).toBe(0);
});

test("startPause validates end time and break", () => {
  const { db, ev, ids } = setup();
  expect(() => startPause(db, ev, { title: "", until: at("09:00"), mode: "interrupt" }, at("09:10"))).toThrow("in der Zukunft");
  expect(() => startPause(db, ev, { title: "", until: at("10:00"), mode: "interrupt", breakId: ids.A }, at("09:10"))).toThrow("nicht mehr geplant");
  startPause(db, ev, { title: "  ", until: at("10:00"), mode: "interrupt" }, at("09:10"));
  expect(getLive(db, ev)!.pause_title).toBe("Pause");
});

test("breaks cannot be started or marked done like agenda items", () => {
  const { db, ev, ids } = setup();
  expect(() => startItem(db, ev, ids.M!, at("12:00"))).toThrow("Pause starten");
  expect(() => setDone(db, ev, ids.M!, true, at("12:00"))).toThrow("Pause starten");
});

test("Jetzt starten on the paused item resumes it; marking it done drops it from the pause", () => {
  const { db, ev, ids } = setup();
  startItem(db, ev, ids.C!, at("11:00"));
  startPause(db, ev, { title: "Pause", until: at("12:00"), mode: "interrupt" }, at("11:45"));
  startItem(db, ev, ids.C!, at("12:30"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: ids.C, started_at: at("12:30"), elapsed_before: 45, pause_until: null });
  startPause(db, ev, { title: "Pause", until: at("13:00"), mode: "interrupt" }, at("12:40"));
  setDone(db, ev, ids.C!, true, at("12:45"));
  expect(getLive(db, ev)).toMatchObject({ current_item_id: null, pause_title: "Pause" });
});

test("pause form on the live screen and pause card on the start page", async () => {
  const { app, db, ev, ids } = setup(berlinNow().date);
  const cookie = await loginAs(app, db, ["schedule"]);
  expect(await (await app.request("/admin/live", { headers: { cookie } })).text()).toContain(`name="break" value="${ids.M}"`);
  expect((await post(app, "/admin/live/pause", { title: "Kaffee", minutes: "10" }, cookie)).status).toBe(302);
  expect(getLive(db, ev)).toMatchObject({ pause_title: "Kaffee" });
  const start = await (await app.request("/")).text();
  expect(start).toContain("Gerade Pause");
  expect(start).toContain("Kaffee");
  const now = berlinNow().minutes;
  if (now < 23 * 60) {
    await post(app, "/admin/live/pause", { title: "Mittag", minutes: "10", until: fmt(now + 30) }, cookie);
    const l = getLive(db, ev)!;
    expect(Math.round((l.pause_until! - Date.now()) / 60_000)).toBeGreaterThanOrEqual(29);
  }
});

test("overrun pause on the start page: warning and a counting-up timer", async () => {
  const { app, db, ev } = setup(berlinNow().date);
  const t = Date.now();
  startPause(db, ev, { title: "Kaffee", until: t - 3 * 60_000, mode: "interrupt" }, t - 10 * 60_000);
  const html = await (await app.request("/")).text();
  expect(html).toContain('class="card now over"');
  expect(html).toContain("3 Minuten länger als geplant");
  expect(html).toMatch(/class="timer over" role="timer" data-left="-18\d"/);
});

test("start page never announces a break as next", async () => {
  const { app, db, ev, ids } = setup(berlinNow().date);
  db.run("UPDATE items SET done = 1 WHERE id IN (?, ?, ?)", [ids.A!, ids.B!, ids.C!]);
  const idle = await (await app.request("/")).text();
  expect(idle).toContain("Als Nächstes</div><h3>D</h3>");
  startItem(db, ev, ids.C!, Date.now());
  expect(await (await app.request("/")).text()).toContain("Danach: D");
});

test("live screen lists every day with separators and actions on every day", async () => {
  const { app, db, ev, ids } = setup(berlinNow().date);
  const tomorrow = Number(db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, date(?, '+1 day'), '09:00', '10:00', 'Morgen-TOP', 'agenda')`,
    [ev, berlinNow().date]).lastInsertRowid);
  const cookie = await loginAs(app, db, ["schedule"]);
  const html = await (await app.request("/admin/live", { headers: { cookie } })).text();
  expect(html).toContain('<div class="planscroll">');
  expect(html).toContain('id="today"');
  expect(html.match(/class="daysep/g)!.length).toBe(2);
  expect(html).toContain("Morgen-TOP");
  expect(html).toContain(`/admin/live/start/${ids.A}`);
  expect(html).toContain(`/admin/live/start/${tomorrow}`);
});

test("starting an item of another day runs it there; Weiter continues on that day", async () => {
  const { app, db, ev } = setup(berlinNow().date);
  const add = (title: string, start: string, end: string) => Number(db.run(
    `INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, date(?, '+1 day'), ?, ?, ?, 'agenda')`,
    [ev, berlinNow().date, start, end, title]).lastInsertRowid);
  const t1 = add("Morgen-1", "09:00", "10:00");
  const t2 = add("Morgen-2", "10:00", "11:00");
  const cookie = await loginAs(app, db, ["schedule"]);
  await post(app, `/admin/live/start/${t1}`, {}, cookie);
  const html = await (await app.request("/admin/live", { headers: { cookie } })).text();
  expect(html).toMatch(new RegExp(`Läuft seit[^]*<h3><a href="/admin/items/${t1}\\?back=/admin/live">Morgen-1</a></h3>`));
  expect(html).toContain(`<a href="/admin/items/${t2}?back=/admin/live">Morgen-2</a>`);
  expect(html).toContain("<title>Übersicht");
  expect(await (await app.request("/")).text()).toContain("<h3>Morgen-1</h3>");
  await post(app, "/admin/live/next", {}, cookie);
  expect(getLive(db, ev)!.current_item_id).toBe(t2);
});

test("item page opened from the Übersicht leads back there; foreign back targets are ignored", async () => {
  const { app, db, ids } = setup(berlinNow().date);
  const cookie = await loginAs(app, db, ["schedule"]);
  const page = await (await app.request(`/admin/items/${ids.A}?back=/admin/live`, { headers: { cookie } })).text();
  expect(page).toContain('<a href="/admin/live">← Übersicht</a>');
  expect(page).toContain('<input type="hidden" name="back" value="/admin/live"/>');
  const fields = { date: berlinNow().date, start: "09:00", duration: "60", title: "A", kind: "agenda" };
  expect((await post(app, `/admin/items/${ids.A}`, { ...fields, back: "/admin/live" }, cookie)).headers.get("location")).toBe("/admin/live");
  expect((await post(app, `/admin/items/${ids.A}`, { ...fields, back: "//evil.example" }, cookie)).headers.get("location")).toMatch(/^\/admin\/events\/\d+\/items$/);
  expect((await post(app, `/admin/items/${ids.B}/delete`, { confirm: "1", back: "/admin/live" }, cookie)).headers.get("location")).toBe("/admin/live");
  const plain = await (await app.request(`/admin/items/${ids.C}?back=https://evil.example`, { headers: { cookie } })).text();
  expect(plain).toContain("← Zeitplan Diko");
});

test("Zurück after Jetzt starten on a finished item closes it again", () => {
  const { db, ev, ids } = setup();
  setDone(db, ev, ids.B!, true, at("09:00"));
  startItem(db, ev, ids.B!, at("09:10"));
  expect(done(db, ids.B!)).toBe(0);
  back(db, ev);
  expect(done(db, ids.B!)).toBe(1);
});

test("pause bis HH:MM: after midnight late in the evening, a time just past stays in the past", () => {
  expect(pauseUntil("00:15", at("23:50"))).toBe(at("00:15", "2026-11-14"));
  expect(pauseUntil("10:30", at("10:00"))).toBe(at("10:30"));
  expect(pauseUntil("09:55", at("10:00"))).toBeLessThan(at("10:00"));
});

test("an entry running past midnight keeps running; the reset waits until the night is over", () => {
  const t = testApp();
  const ev = Number(t.db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', '2026-11-13', 'active')").lastInsertRowid);
  const add = (title: string, start: string, end: string, sort: number) =>
    Number(t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, sort) VALUES (?, '2026-11-13', ?, ?, ?, 'agenda', ?)`, [ev, start, end, title, sort]).lastInsertRowid);
  const party = add("Party", "22:00", "01:00", 0);
  const late = add("Absacker", "01:00", "02:00", 1);
  startItem(t.db, ev, party, at("22:00"));
  expect(liveInput(t.db, ev, at("00:30", "2026-11-14"))).toMatchObject({ currentItemId: party, startedAt: 22 * 60 });
  next(t.db, ev, at("00:45", "2026-11-14"));
  expect(getLive(t.db, ev)).toMatchObject({ current_item_id: late });
  expect(done(t.db, party)).toBe(1);
  expect(liveInput(t.db, ev, at("05:00", "2026-11-14"))).toBeNull();
});
