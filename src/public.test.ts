import { test, expect } from "bun:test";
import { bump, setSetting } from "./db";
import { startItem } from "./live";
import { testApp } from "./test-helpers";

const at = (hhmm: string, date = "2026-11-13") => Date.parse(`${date}T${hhmm}:00+01:00`);

function setup(nowMs: number) {
  const t = testApp(() => nowMs);
  const ev = Number(t.db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', '2026-11-13', 'active')").lastInsertRowid);
  const add = (start: string, end: string, title: string, extra = "") =>
    Number(t.db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, responsible, show_responsible) VALUES (?, '2026-11-13', ?, ?, ?, 'agenda', ?, ?)`,
      [ev, start, end, title, extra, extra ? 1 : 0]).lastInsertRowid);
  const a = add("09:00", "10:00", "Begrüßung");
  add("10:00", "11:00", "Berichte", "Vorstand Anna");
  return { ...t, ev, a };
}

test("no active event shows friendly message", async () => {
  const { app } = testApp();
  const res = await app.request("/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Aktuell ist keine Veranstaltung geplant.");
});

test("active event without items shows placeholder", async () => {
  const { app, db } = testApp();
  db.run("INSERT INTO events (name, start_date, status) VALUES ('Diko', '2026-11-13', 'active')");
  expect(await (await app.request("/")).text()).toContain("Der Zeitplan folgt.");
});

test("overrun shows expected and struck planned time", async () => {
  const { app, db, ev, a } = setup(at("10:20"));
  startItem(db, ev, a, at("09:00"));
  const html = await (await app.request("/")).text();
  expect(html).toContain("überzogen");
  expect(html).toContain("10:20");
  expect(html).toContain("<s>10:00</s>");
  expect(html).toContain("Laut Plan wäre jetzt: <strong>Berichte</strong>");
  expect(html).toContain("Freitag, 13.11.");
});

test("responsible shown only when enabled per item", async () => {
  const { app, db } = setup(at("08:00"));
  expect(await (await app.request("/")).text()).toContain("Vorstand Anna");
  db.run("UPDATE items SET show_responsible = 0");
  expect(await (await app.request("/")).text()).not.toContain("Vorstand Anna");
});

test("schedule block can be switched off", async () => {
  const { app, db } = setup(at("08:00"));
  expect(await (await app.request("/")).text()).toContain("Begrüßung");
  setSetting(db, "show_schedule", "0");
  expect(await (await app.request("/")).text()).not.toContain("Begrüßung");
});

test("/api/live answers 304 for unchanged content and 200 after a change", async () => {
  const { app, db } = setup(at("08:00"));
  const first = await app.request("/api/live");
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("Begrüßung");
  const etag = first.headers.get("etag")!;
  expect((await app.request("/api/live", { headers: { "if-none-match": etag } })).status).toBe(304);
  bump(db);
  expect((await app.request("/api/live", { headers: { "if-none-match": etag } })).status).toBe(200);
});

test("live state from a previous day shows planned times (daily reset)", async () => {
  const { app, db, ev, a } = setup(at("10:20"));
  startItem(db, ev, a, at("09:00", "2026-11-12"));
  const html = await (await app.request("/")).text();
  expect(html).toContain("Begrüßung");
  expect(html).not.toContain("überzogen");
  expect(html).not.toContain("<s>");
});

test("now card shows the running item, how far it runs over and what comes next", async () => {
  const { app, db, ev, a } = setup(at("10:20"));
  startItem(db, ev, a, at("09:00"));
  const html = await (await app.request("/")).text();
  expect(html).toContain('class="card now over"');
  expect(html).toContain("20 Minuten länger als geplant");
  expect(html).toContain("Danach: Berichte");
  expect(html).toContain("ca. 10:20");
});

test("before anything runs today the card announces the next item", async () => {
  const { app } = setup(at("08:30"));
  const html = await (await app.request("/")).text();
  expect(html).toContain("Als Nächstes");
  expect(html).toMatch(/Begrüßung[\s\S]*09:00/);
});

test("no now card on days without schedule entries", async () => {
  const { app } = setup(at("08:30", "2026-11-20"));
  expect(await (await app.request("/")).text()).not.toContain('class="card now');
});

test("hero shows the event name and uses the title image when set", async () => {
  const { app, db } = setup(at("08:00"));
  const plain = await (await app.request("/")).text();
  expect(plain).toMatch(/<section class="hero"[^>]*><div class="hero-inner"><h1>Diko<\/h1>/);
  expect(plain).not.toContain("background-image");
  setSetting(db, "hero_image", "0b8a3c1e-1111-4222-8333-944455556666.jpg");
  setSetting(db, "hero_position", "top");
  const withImage = await (await app.request("/")).text();
  expect(withImage).toContain("background-image:url(/uploads/0b8a3c1e-1111-4222-8333-944455556666.jpg)");
  expect(withImage).toContain("background-position:center top");
});

test("in the evening with nothing left today the card shows tomorrow's first agenda item, not a break", async () => {
  const { app, db, ev } = setup(at("21:00"));
  db.run("UPDATE items SET done = 1");
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, '2026-11-14', '08:00', '09:00', 'Frühstück', 'break')`, [ev]);
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, '2026-11-14', '09:00', '10:00', 'Morgenimpuls', 'agenda')`, [ev]);
  const html = await (await app.request("/")).text();
  expect(html).toContain("Als Nächstes</div><h3>Morgenimpuls</h3>");
  expect(html).toContain("Morgen, 09:00 Uhr");
});

test("before the event starts the card names the day of the first item", async () => {
  const { app } = setup(at("12:00", "2026-11-10"));
  const html = await (await app.request("/")).text();
  expect(html).toContain("Als Nächstes");
  expect(html).toContain("Freitag, 13.11. · 09:00 Uhr");
});

test("next-item switch hides the Als-Nächstes card and the Danach line", async () => {
  const { app, db, ev, a } = setup(at("09:30"));
  setSetting(db, "show_next", "0");
  expect(await (await app.request("/")).text()).not.toContain("Als Nächstes");
  startItem(db, ev, a, at("09:00"));
  const html = await (await app.request("/")).text();
  expect(html).toContain('class="card now');
  expect(html).not.toContain("Danach:");
});

test("after midnight the start page still shows the evening's running entry", async () => {
  const { db, app, ev } = setup(at("00:30", "2026-11-14"));
  const party = Number(db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, sort) VALUES (?, '2026-11-13', '22:00', '01:00', 'Konferenzparty', 'agenda', 9)`, [ev]).lastInsertRowid);
  startItem(db, ev, party, at("22:00"));
  const html = await (await app.request("/")).text();
  expect(html).toContain("Jetzt");
  expect(html.slice(html.indexOf("Jetzt"), html.indexOf("Jetzt") + 300)).toContain("Konferenzparty");
});
