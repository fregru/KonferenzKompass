import { test, expect } from "bun:test";
import { changesFor, itemDiff, logChange } from "./changelog";
import { loginAs, post, testApp } from "./test-helpers";
import { berlinNow } from "./time";

function setup() {
  const t = testApp();
  const today = berlinNow().date;
  const ev = Number(t.db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', ?, 'active')", [today]).lastInsertRowid);
  const ids: Record<string, number> = {};
  for (const [name, start, end, kind] of [["A", "09:00", "10:00", "agenda"], ["B", "10:00", "11:00", "agenda"], ["M", "12:00", "13:00", "break"]])
    ids[name!] = Number(t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ev, today, start!, end!, name!, kind!, Object.keys(ids).length]).lastInsertRowid);
  return { ...t, ev, ids, today };
}
const texts = (db: Parameters<typeof changesFor>[0], ev: number) => changesFor(db, ev, 100).map((c) => `${c.username}: ${c.text}`);
const username = async (cookie: string, app: ReturnType<typeof testApp>["app"]) =>
  /Abmelden \((\w+)\)/.exec(await (await app.request("/admin/live", { headers: { cookie } })).text())![1];

test("live actions are logged with who did them and the resulting state", async () => {
  const { app, db, ev, ids } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  const user = await username(cookie, app);
  await post(app, "/admin/live/next", {}, cookie);
  await post(app, "/admin/live/pause", { title: "Kaffee", minutes: "15" }, cookie);
  await post(app, "/admin/live/back", {}, cookie);
  await post(app, `/admin/live/done/${ids.B}`, { done: "1" }, cookie);
  await post(app, "/admin/live/show-next", { show_next: "0" }, cookie);
  const log = texts(db, ev);
  expect(log[4]).toBe(`${user}: Weiter → läuft: „A“`);
  expect(log[3]).toMatch(new RegExp(`^${user}: Pause gestartet → Pause „Kaffee“ bis \\d\\d:\\d\\d, „A“ unterbrochen$`));
  expect(log[2]).toBe(`${user}: Zurück (rückgängig gemacht) → läuft: „A“`);
  expect(log[1]).toBe(`${user}: Erledigt: „B“ → läuft: „A“`);
  expect(log[0]).toBe(`${user}: Nächster Programmpunkt auf der Startseite ausgeblendet`);
});

test("a failed live action is not logged", async () => {
  const { app, db, ev, ids } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  expect((await post(app, `/admin/live/start/${ids.M}`, {}, cookie)).status).toBe(400);
  expect(changesFor(db, ev, 10)).toEqual([]);
});

test("entry changes log only the changed fields; an unchanged save logs nothing", async () => {
  const { app, db, ev, ids, today } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  const fields = { date: today, start: "09:00", duration: "60", title: "A", kind: "agenda" };
  await post(app, `/admin/items/${ids.A}`, fields, cookie);
  expect(changesFor(db, ev, 10)).toEqual([]);
  await post(app, `/admin/items/${ids.A}`, { ...fields, title: "Begrüßung", top_number: "TOP 1", duration: "30" }, cookie);
  const [ch] = changesFor(db, ev, 10);
  expect(ch).toMatchObject({ item_id: ids.A, text: "„A“ geändert: Titel A → TOP 1 Begrüßung, Dauer 60 min → 30 min" });
});

test("new, moved, deleted entries and the CSV import are logged", async () => {
  const { app, db, ev, ids, today } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  await post(app, `/admin/events/${ev}/items/new`, { date: today, start: "14:00", duration: "30", title: "Neu", kind: "agenda" }, cookie);
  await post(app, `/admin/items/${ids.B}/move`, { dir: "up" }, cookie);
  await post(app, `/admin/items/${ids.A}/delete`, {}, cookie);
  const csv = "Datum;Beginn;Dauer;Titel\n" + `${today};09:00;60;X\n${today};;30;Y\n`;
  await post(app, `/admin/events/${ev}/items/import`, { confirm: "1", replace: "1", text: csv }, cookie);
  const log = changesFor(db, ev, 10).map((c) => c.text);
  expect(log[3]).toMatch(/^„Neu“ angelegt \(.+ 1\d:\d\d\)$/);
  expect(log[2]).toMatch(/^„B“ verschoben \(.+, 1\. Eintrag, jetzt \d\d:\d\d\)$/);
  expect(log[1]).toMatch(/^„A“ gelöscht/);
  expect(log[0]).toBe("Zeitplan aus CSV importiert (2 Einträge)");
});

test("change log page needs the schedule permission and shows the entries", async () => {
  const { app, db, ev } = setup();
  logChange(db, ev, "anna", "„A“ geändert: Beginn 09:00 → 09:15");
  const ok = await app.request(`/admin/events/${ev}/changes`, { headers: { cookie: await loginAs(app, db, ["schedule"]) } });
  expect(ok.status).toBe(200);
  const html = await ok.text();
  expect(html).toContain("anna");
  expect(html).toContain("Beginn 09:00 → 09:15");
  const no = await app.request(`/admin/events/${ev}/changes`, { headers: { cookie: await loginAs(app, db, ["pages"]) } });
  expect(no.status).toBe(403);
});

test("the log keeps the newest 1000 entries per event", () => {
  const { db, ev } = setup();
  for (let i = 0; i < 1005; i++) logChange(db, ev, "x", String(i));
  const all = changesFor(db, ev, 2000);
  expect(all.length).toBe(1000);
  expect(all[0]!.text).toBe("1004");
  expect(all.at(-1)!.text).toBe("5");
});

test("itemDiff names rooms and flags", () => {
  const base = { date: "2026-11-13", start: "09:00", end: "10:00", title: "A", top_number: "", kind: "agenda" as const, location: "", description: "",
    responsible: "", show_responsible: 0, fixed: 0, room_id: 1, menu: "" };
  const rooms = new Map([[1, { name: "Saal" }], [2, { name: "Foyer" }]]);
  expect(itemDiff(base, { ...base, room_id: 2, fixed: 1, description: "neu" }, rooms)).toBe("Zeit fließend → fest, Raum Saal → Foyer, Beschreibung geändert");
  expect(itemDiff(base, base, rooms)).toBe("");
});

test("Übersicht answers 304 for an unchanged ETag and a new one after a change", async () => {
  const { app, db } = setup();
  const cookie = await loginAs(app, db, ["schedule"]);
  const first = await app.request("/admin/live", { headers: { cookie } });
  const etag = first.headers.get("etag")!;
  expect(await first.text()).toContain(`data-etag="${etag.replaceAll('"', "&quot;")}"`);
  expect((await app.request("/admin/live", { headers: { cookie, "if-none-match": etag } })).status).toBe(304);
  await post(app, "/admin/live/next", {}, cookie);
  const after = await app.request("/admin/live", { headers: { cookie, "if-none-match": etag } });
  expect(after.status).toBe(200);
  expect(after.headers.get("etag")).not.toBe(etag);
});
