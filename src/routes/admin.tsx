import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import {
  can,
  cleanPerms,
  clientIp,
  createSession,
  createUser,
  isHttps,
  loginLimiter,
  MIN_PASSWORD,
  requireLogin,
  SESSION_DAYS,
  verifyLogin,
  type AppEnv,
} from "../auth";
import { Dashboard, LoginPage, UserEdit, UsersPage } from "../views/admin";
import { contentRoutes } from "./content";
import { eventRoutes } from "./events";
import { liveRoutes } from "./live";
import { settingsRoutes } from "./settings";
import { venueRoutes } from "./venues";
import { form, requirePerm } from "./util";

export function adminRoutes(db: Database) {
  const r = new Hono<AppEnv>();
  const limiter = loginLimiter();

  r.use("*", csrf());

  r.get("/login", (c) => c.html(<LoginPage db={db} />));
  r.post("/login", async (c) => {
    const ip = clientIp(c);
    if (limiter.blocked(ip)) return c.html(<LoginPage db={db} error="Zu viele Versuche. Bitte warte eine Minute." />, 429);
    const f = await form(c);
    const userId = await verifyLogin(db, f.str("username"), f.str("password"));
    if (!userId) {
      limiter.fail(ip);
      return c.html(<LoginPage db={db} error="Benutzername oder Passwort falsch." />, 401);
    }
    setCookie(c, "sid", createSession(db, userId), {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return c.redirect("/admin");
  });

  r.use("*", requireLogin(db));

  r.post("/logout", (c) => {
    db.run("DELETE FROM sessions WHERE token = ?", [getCookie(c, "sid") ?? ""]);
    deleteCookie(c, "sid", { path: "/" });
    return c.redirect("/admin/login");
  });

  r.get("/", (c) => {
    const user = c.get("user");
    return can(user, "schedule") ? c.redirect("/admin/live") : c.html(<Dashboard db={db} user={user} />);
  });

  // --- users ---
  type UserRow = { id: number; username: string; perms: string };
  const allUsers = () => db.query<UserRow, []>("SELECT id, username, perms FROM users ORDER BY username").all();
  const getUser = (id: string) => db.query<UserRow, [string]>("SELECT id, username, perms FROM users WHERE id = ?").get(id);

  r.use("/users/*", requirePerm(db, "users"));
  r.use("/users", requirePerm(db, "users"));

  r.get("/users", (c) => c.html(<UsersPage db={db} user={c.get("user")} users={allUsers()} />));
  r.post("/users", async (c) => {
    const f = await form(c);
    const fail = (error: string) => c.html(<UsersPage db={db} user={c.get("user")} users={allUsers()} error={error} />, 400);
    const username = f.str("username");
    if (!username) return fail("Benutzername fehlt.");
    if (f.str("password").length < MIN_PASSWORD) return fail(`Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen haben.`);
    if (db.query("SELECT 1 FROM users WHERE username = ?").get(username)) return fail("Diesen Benutzernamen gibt es schon.");
    await createUser(db, username, f.str("password"), cleanPerms(f.list("perms")));
    return c.redirect("/admin/users");
  });

  r.get("/users/:id", (c) => {
    const target = getUser(c.req.param("id"));
    return target ? c.html(<UserEdit db={db} user={c.get("user")} target={target} />) : c.notFound();
  });
  r.post("/users/:id", async (c) => {
    const user = c.get("user");
    const target = getUser(c.req.param("id"));
    if (!target) return c.notFound();
    const f = await form(c);
    const perms = cleanPerms(f.list("perms"));
    const fail = (error: string) => c.html(<UserEdit db={db} user={user} target={target} error={error} />, 400);
    if (target.id === user.id && !perms.includes("users")) return fail("Du kannst dir die eigene Benutzerverwaltung nicht entziehen.");
    const pw = f.str("password");
    if (pw && pw.length < MIN_PASSWORD) return fail(`Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen haben.`);
    db.run("UPDATE users SET perms = ? WHERE id = ?", [JSON.stringify(perms), target.id]);
    if (pw) {
      db.run("UPDATE users SET hash = ? WHERE id = ?", [await Bun.password.hash(pw), target.id]);
      // Signs the account out everywhere, except this browser when changing the own password.
      db.run("DELETE FROM sessions WHERE user_id = ? AND token != ?", [target.id, getCookie(c, "sid") ?? ""]);
    }
    return c.redirect("/admin/users");
  });
  r.post("/users/:id/delete", async (c) => {
    const user = c.get("user");
    const target = getUser(c.req.param("id"));
    if (!target) return c.notFound();
    if (target.id === user.id) return c.html(<UserEdit db={db} user={user} target={target} error="Du kannst dich nicht selbst löschen." />, 400);
    db.run("DELETE FROM users WHERE id = ?", [target.id]);
    return c.redirect("/admin/users");
  });

  r.route("/", eventRoutes(db));
  r.route("/", liveRoutes(db));
  r.route("/", settingsRoutes(db));
  r.route("/", contentRoutes(db));
  r.route("/", venueRoutes(db));

  return r;
}
