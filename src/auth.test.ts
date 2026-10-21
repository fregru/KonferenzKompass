import { test, expect } from "bun:test";
import { bootstrapAdmin, createUser, PERMS } from "./auth";
import { loginAs, post, TEST_PASSWORD, testApp } from "./test-helpers";

const ip = (n: number) => ({ "x-forwarded-for": `1.2.3.${n}` });

test("login with correct password sets HttpOnly session cookie", async () => {
  const { app, db } = testApp();
  await createUser(db, "anna", TEST_PASSWORD, ["intro"]);
  const res = await post(app, "/admin/login", { username: "anna", password: TEST_PASSWORD }, "", ip(1));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/admin");
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
});

test("wrong password shows error", async () => {
  const { app, db } = testApp();
  await createUser(db, "anna", TEST_PASSWORD, []);
  const res = await post(app, "/admin/login", { username: "anna", password: "falsch" }, "", ip(2));
  expect(res.status).toBe(401);
  expect(await res.text()).toContain("Benutzername oder Passwort falsch");
});

test("6th failed login within a minute from same IP is rate limited", async () => {
  const { app } = testApp();
  for (let i = 0; i < 5; i++) expect((await post(app, "/admin/login", { username: "x", password: "y" }, "", ip(3))).status).toBe(401);
  const res = await post(app, "/admin/login", { username: "x", password: "y" }, "", ip(3));
  expect(res.status).toBe(429);
  expect(await res.text()).toContain("Zu viele Versuche");
});

test("admin pages require login", async () => {
  const { app } = testApp();
  const res = await app.request("/admin/users");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/admin/login");
});

test("/admin/users requires users perm", async () => {
  const { app, db } = testApp();
  expect((await app.request("/admin/users", { headers: { cookie: await loginAs(app, db, ["intro"]) } })).status).toBe(403);
  expect((await app.request("/admin/users", { headers: { cookie: await loginAs(app, db, ["users"]) } })).status).toBe(200);
});

test("cross-origin POST is rejected", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["users"]);
  const res = await post(app, "/admin/users", { username: "neu", password: TEST_PASSWORD }, cookie, { origin: "https://evil.example" });
  expect(res.status).toBe(403);
  expect(db.query("SELECT 1 FROM users WHERE username = 'neu'").get()).toBeNull();
});

test("users admin creates user with perms and enforces password length", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["users"]);
  const short = await post(app, "/admin/users", { username: "kurz", password: "abc" }, cookie);
  expect(await short.text()).toContain("mindestens 12 Zeichen");
  await post(app, "/admin/users", { username: "neu", password: TEST_PASSWORD, perms: ["intro", "schedule"] }, cookie);
  const row = db.query<{ perms: string }, []>("SELECT perms FROM users WHERE username = 'neu'").get()!;
  expect(JSON.parse(row.perms)).toEqual(["schedule", "intro"]);
});

test("user cannot delete themselves or remove their own users perm", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["users", "intro"]);
  const me = db.query<{ id: number }, []>("SELECT id FROM users ORDER BY id DESC LIMIT 1").get()!;
  const del = await post(app, `/admin/users/${me.id}/delete`, {}, cookie);
  expect(await del.text()).toContain("Du kannst dich nicht selbst löschen");
  const upd = await post(app, `/admin/users/${me.id}`, { perms: ["intro"] }, cookie);
  expect(await upd.text()).toContain("eigene Benutzerverwaltung");
  const row = db.query<{ perms: string }, [number]>("SELECT perms FROM users WHERE id = ?").get(me.id)!;
  expect(JSON.parse(row.perms)).toEqual(["intro", "users"]);
});

test("bootstrapAdmin creates admin with all perms only when table empty", async () => {
  const { db } = testApp();
  await bootstrapAdmin(db, { ADMIN_USER: "admin", ADMIN_PASSWORD: TEST_PASSWORD });
  const row = db.query<{ perms: string }, []>("SELECT perms FROM users WHERE username = 'admin'").get()!;
  expect(JSON.parse(row.perms)).toEqual([...PERMS]);
  await bootstrapAdmin(db, { ADMIN_USER: "zweiter", ADMIN_PASSWORD: TEST_PASSWORD });
  expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
});

test("logout deletes session", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["intro"]);
  await post(app, "/admin/logout", {}, cookie);
  expect((await app.request("/admin", { headers: { cookie } })).status).toBe(302);
});

test("spoofed X-Forwarded-For does not bypass the rate limit unless TRUST_PROXY is set", async () => {
  delete process.env.TRUST_PROXY;
  const { app } = testApp();
  for (let i = 0; i < 5; i++) await post(app, "/admin/login", { username: "x", password: "y" }, "", ip(100 + i));
  expect((await post(app, "/admin/login", { username: "x", password: "y" }, "", ip(200))).status).toBe(429);
});

test("with TRUST_PROXY the last X-Forwarded-For entry (set by the proxy) counts", async () => {
  process.env.TRUST_PROXY = "1";
  try {
    const { app } = testApp();
    for (let i = 0; i < 5; i++)
      await post(app, "/admin/login", { username: "x", password: "y" }, "", { "x-forwarded-for": `9.9.9.${i}, 5.5.5.5` });
    expect((await post(app, "/admin/login", { username: "x", password: "y" }, "", { "x-forwarded-for": "8.8.8.8, 5.5.5.5" })).status).toBe(429);
    expect((await post(app, "/admin/login", { username: "x", password: "y" }, "", { "x-forwarded-for": "6.6.6.6" })).status).toBe(401);
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

test("admin area has a compact phone menu with all permitted sections and logout", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["users", "settings"]);
  const html = await (await app.request("/admin/users", { headers: { cookie } })).text();
  const menu = html.slice(html.indexOf('<details class="menu adminmenu">'), html.indexOf("</details>", html.indexOf("adminmenu")));
  expect(menu).toContain("Admin-Bereiche");
  expect(menu).toContain('href="/admin/users"');
  expect(menu).toContain('href="/admin/settings"');
  expect(menu).not.toContain('href="/admin/live"');
  expect(menu).toContain('action="/admin/logout"');
});

test("/admin/ redirects to /admin (and on to the live control)", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["schedule"]);
  const r = await app.request("/admin/", { headers: { cookie } });
  expect(r.headers.get("location")).toBe("/admin");
  expect((await app.request("/admin", { headers: { cookie } })).headers.get("location")).toBe("/admin/live");
});

test("changing the own password signs out all other sessions of that account, not this one", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["users"]);
  const me = db.query<{ id: number; username: string }, []>("SELECT id, username FROM users ORDER BY id DESC LIMIT 1").get()!;
  const other = (await post(app, "/admin/login", { username: me.username, password: TEST_PASSWORD }, "", ip(77))).headers.get("set-cookie")!.split(";")[0]!;
  await post(app, `/admin/users/${me.id}`, { perms: ["users"], password: "ganz-neues-passwort" }, cookie);
  expect((await app.request("/admin/users", { headers: { cookie } })).status).toBe(200);
  expect((await app.request("/admin/users", { headers: { cookie: other } })).status).toBe(302);
});

test("logging in clears expired sessions", async () => {
  const { app, db } = testApp();
  await loginAs(app, db, ["intro"]);
  db.run("UPDATE sessions SET expires = 1");
  await loginAs(app, db, ["intro"]);
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
});
