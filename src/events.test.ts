import { test, expect } from "bun:test";
import { getSetting } from "./db";
import { loginAs, post, testApp } from "./test-helpers";

const item = { date: "2026-11-13", start: "10:00", duration: "60", title: "Begrüßung", kind: "agenda" };

async function setup() {
  const t = testApp();
  const cookie = await loginAs(t.app, t.db, ["events", "schedule"]);
  await post(t.app, "/admin/events", { name: "Diko 2026", start_date: "2026-11-13" }, cookie);
  const id = t.db.query<{ id: number }, []>("SELECT id FROM events ORDER BY id DESC").get()!.id;
  return { ...t, cookie, id };
}

test("activate leaves exactly one active event", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, "/admin/events", { name: "Diko 2027", start_date: "2027-11-12" }, cookie);
  await post(app, `/admin/events/${id}/activate`, {}, cookie);
  await post(app, `/admin/events/${id + 1}/activate`, {}, cookie);
  expect(db.query("SELECT id FROM events WHERE status = 'active'").all()).toEqual([{ id: id + 1 }]);
});

test("fixed entries are placed by their time, days in date order", async () => {
  const { app, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, { ...item, start: "14:00", title: "Später", fixed: "1" }, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, date: "2026-11-14", start: "09:00", title: "Tag 2" }, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, fixed: "1" }, cookie);
  const html = await (await app.request(`/admin/events/${id}/items`, { headers: { cookie } })).text();
  const pos = ["Begrüßung", "Später", "Tag 2"].map((t) => html.indexOf(t));
  expect(pos.every((p) => p > 0)).toBe(true);
  expect([...pos].sort((a, b) => a - b)).toEqual(pos);
});

test("missing title re-renders form with error and inserts nothing", async () => {
  const { app, db, cookie, id } = await setup();
  const res = await post(app, `/admin/events/${id}/items/new`, { ...item, title: "" }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Titel fehlt");
  expect(db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
});

test("a duration outside 1–1440 minutes is rejected", async () => {
  const { app, cookie, id } = await setup();
  const res = await post(app, `/admin/events/${id}/items/new`, { ...item, duration: "0" }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("zwischen 1 und 1440 Minuten");
});

test("writes on an archived event are rejected", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  const itemId = db.query<{ id: number }, []>("SELECT id FROM items").get()!.id;
  db.run("UPDATE events SET status = 'archived' WHERE id = ?", [id]);
  expect((await post(app, `/admin/events/${id}/items/new`, item, cookie)).status).toBe(403);
  expect((await post(app, `/admin/items/${itemId}`, { ...item, title: "Neu" }, cookie)).status).toBe(403);
  expect((await post(app, `/admin/items/${itemId}/delete`, {}, cookie)).status).toBe(403);
});

test("schedule perm alone cannot manage events", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["schedule"]);
  expect((await post(app, "/admin/events", { name: "X", start_date: "2026-01-01" }, cookie)).status).toBe(403);
});

test("every write increments version", async () => {
  const { app, db, cookie, id } = await setup();
  const v = () => Number(getSetting(db, "version"));
  const v0 = v();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  const itemId = db.query<{ id: number }, []>("SELECT id FROM items").get()!.id;
  expect(v()).toBe(v0 + 1);
  await post(app, `/admin/items/${itemId}`, { ...item, title: "Neu" }, cookie);
  expect(v()).toBe(v0 + 2);
  await post(app, `/admin/items/${itemId}/delete`, {}, cookie);
  expect(v()).toBe(v0 + 3);
  await post(app, `/admin/events/${id}/activate`, {}, cookie);
  expect(v()).toBe(v0 + 4);
});

test("copy shifts dates, resets progress, copies intro, FAQ, contacts and links", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, date: "2026-11-15", title: "Abschluss" }, cookie);
  db.run("UPDATE items SET done = 1");
  db.run("UPDATE events SET intro = 'Hallo' WHERE id = ?", [id]);
  db.run("INSERT INTO faq (event_id, question, answer) VALUES (?, 'Wo?', 'Hier.')", [id]);
  db.run("INSERT INTO contacts (event_id, name) VALUES (?, 'Anna')", [id]);
  db.run("INSERT INTO page_links (event_id, page_slug, label, url) VALUES (?, 'unterlagen', 'Cloud', 'https://c.example')", [id]);
  const res = await post(app, `/admin/events/${id}/copy`, { name: "Diko 2027", start_date: "2027-11-12" }, cookie);
  expect(res.status).toBe(302);
  const copy = db.query<{ id: number; status: string }, []>("SELECT id, status FROM events WHERE name = 'Diko 2027'").get()!;
  expect(copy.status).toBe("draft");
  expect(db.query("SELECT date, title, done FROM items WHERE event_id = ? ORDER BY date", ).all(copy.id)).toEqual([
    { date: "2027-11-12", title: "Begrüßung", done: 0 },
    { date: "2027-11-14", title: "Abschluss", done: 0 },
  ]);
  expect(db.query("SELECT intro FROM events WHERE id = ?").get(copy.id)).toEqual({ intro: "Hallo" });
  expect(db.query("SELECT question, answer FROM faq WHERE event_id = ?").all(copy.id)).toEqual([{ question: "Wo?", answer: "Hier." }]);
  expect(db.query("SELECT name FROM contacts WHERE event_id = ?").all(copy.id)).toEqual([{ name: "Anna" }]);
  expect(db.query("SELECT url FROM page_links WHERE event_id = ?").all(copy.id)).toEqual([{ url: "https://c.example" }]);
});

test("archived event is not public and rejects writes", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  await post(app, `/admin/events/${id}/activate`, {}, cookie);
  expect(await (await app.request("/")).text()).toContain("Begrüßung");
  await post(app, `/admin/events/${id}/archive`, {}, cookie);
  expect(db.query("SELECT status FROM events WHERE id = ?").get(id)).toEqual({ status: "archived" });
  expect(await (await app.request("/")).text()).toContain("Aktuell ist keine Veranstaltung geplant.");
  expect((await post(app, `/admin/events/${id}/items/new`, item, cookie)).status).toBe(403);
  expect((await post(app, `/admin/events/${id}/activate`, {}, cookie)).status).toBe(403);
});

test("delete requires confirmation and cascades", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  db.run("INSERT INTO faq (event_id, question, answer) VALUES (?, 'x', 'y')", [id]);
  db.run("INSERT INTO contacts (event_id, name) VALUES (?, 'Anna')", [id]);
  const no = await post(app, `/admin/events/${id}/delete`, {}, cookie);
  expect(no.status).toBe(400);
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  await post(app, `/admin/events/${id}/delete`, { confirm: "1" }, cookie);
  for (const t of ["events", "items", "faq", "contacts"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
});

test("admin schedule lists one block per day; location sits under the title", async () => {
  const { app, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, { ...item, location: "Großer Saal" }, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, date: "2026-11-14", title: "Tag 2" }, cookie);
  const html = await (await app.request(`/admin/events/${id}/items`, { headers: { cookie } })).text();
  expect(html.match(/<ol class="planlist card"/g)?.length).toBe(2);
  expect(html).toMatch(/<span class="c-time">10:00<span class="end">–11:00<\/span><\/span><div class="body"><a [^>]+>Begrüßung<\/a><div class="sub">Großer Saal<\/div>/);
});

test("breaks keep their menu and show it under the entry; agenda items and empty menus show nothing", async () => {
  const t = testApp(() => Date.parse("2026-11-13T09:00:00+01:00"));
  const cookie = await loginAs(t.app, t.db, ["events", "schedule"]);
  await post(t.app, "/admin/events", { name: "Diko 2026", start_date: "2026-11-13" }, cookie);
  const id = t.db.query<{ id: number }, []>("SELECT id FROM events ORDER BY id DESC").get()!.id;
  await post(t.app, `/admin/events/${id}/activate`, {}, cookie);
  await post(t.app, `/admin/events/${id}/items/new`, { ...item, fixed: "1" }, cookie);
  await post(t.app, `/admin/events/${id}/items/new`, { ...item, start: "12:00", title: "Mittagessen", kind: "break", fixed: "1", menu: "Spaghetti\r\n\r\nvegetarisch: Lasagne" }, cookie);
  await post(t.app, `/admin/events/${id}/items/new`, { ...item, start: "18:00", title: "Abendessen", kind: "break", fixed: "1", menu: "" }, cookie);
  // a TO-Punkt cannot carry a menu
  await post(t.app, `/admin/events/${id}/items/new`, { ...item, start: "14:00", title: "Wahlen", fixed: "1", menu: "Kuchen" }, cookie);
  expect(t.db.query("SELECT title, menu FROM items ORDER BY start").all()).toEqual([
    { title: "Begrüßung", menu: "" }, { title: "Mittagessen", menu: "Spaghetti\r\n\r\nvegetarisch: Lasagne" },
    { title: "Wahlen", menu: "" }, { title: "Abendessen", menu: "" },
  ]);
  const html = await (await t.app.request("/")).text();
  expect(html.match(/class="dishes"/g)?.length).toBe(1);
  expect(html).toContain("<li>Spaghetti</li><li>vegetarisch: Lasagne</li>");
  expect(html).not.toContain("Kuchen");
  const form = await (await t.app.request(`/admin/items/${t.db.query<{ id: number }, []>("SELECT id FROM items WHERE title = 'Mittagessen'").get()!.id}`, { headers: { cookie } })).text();
  expect(form).toContain('name="menu"');
  expect(form).toContain("vegetarisch: Lasagne");
});

test("admin schedule and live control show a break's menu", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/activate`, {}, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, start: "12:00", title: "Mittagessen", kind: "break", fixed: "1", menu: "Spaghetti\nvegan: Linsencurry" }, cookie);
  const plan = await (await app.request(`/admin/events/${id}/items`, { headers: { cookie } })).text();
  expect(plan).toContain("<li>Spaghetti</li><li>vegan: Linsencurry</li>");
  const live = await (await app.request("/admin/live", { headers: { cookie } })).text();
  expect(live).toContain("<li>vegan: Linsencurry</li>");
  expect(db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
});

test("impossible dates are rejected for entries, events and the occupancy view", async () => {
  const { app, db, cookie, id } = await setup();
  const res = await post(app, `/admin/events/${id}/items/new`, { ...item, date: "2026-02-31" }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Datum fehlt oder ist ungültig");
  expect((await post(app, "/admin/events", { name: "X", start_date: "2026-13-01" }, cookie)).status).toBe(400);
  expect(db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
});

test("renaming an event and giving it a new first day moves its entries along", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, date: "2026-11-15", start: "09:00" }, cookie);
  expect((await post(app, `/admin/events/${id}`, { name: "Diko neu", start_date: "2026-12-04" }, cookie)).status).toBe(302);
  expect(db.query("SELECT name, start_date FROM events WHERE id = ?").get(id)).toEqual({ name: "Diko neu", start_date: "2026-12-04" });
  expect(db.query("SELECT date FROM items ORDER BY date").all()).toEqual([{ date: "2026-12-04" }, { date: "2026-12-06" }]);
  expect((await post(app, `/admin/events/${id}`, { name: "X", start_date: "2026-02-31" }, cookie)).status).toBe(400);
  db.run("UPDATE events SET status = 'archived' WHERE id = ?", [id]);
  expect((await post(app, `/admin/events/${id}`, { name: "Y", start_date: "2026-12-04" }, cookie)).status).toBe(403);
});

test("the schedule editor shows empty days in between as drop targets; archived entries are read-only", async () => {
  const { app, db, cookie, id } = await setup();
  await post(app, `/admin/events/${id}/items/new`, item, cookie);
  await post(app, `/admin/events/${id}/items/new`, { ...item, date: "2026-11-15", start: "09:00" }, cookie);
  const html = await (await app.request(`/admin/events/${id}/items`, { headers: { cookie } })).text();
  expect(html).toContain('data-sortable="2026-11-14"');
  const itemId = db.query<{ id: number }, []>("SELECT id FROM items").get()!.id;
  db.run("UPDATE events SET status = 'archived' WHERE id = ?", [id]);
  const form = await (await app.request(`/admin/items/${itemId}`, { headers: { cookie } })).text();
  expect(form).toContain('<fieldset class="bare" disabled="">');
  expect(form).not.toContain("/delete");
});
