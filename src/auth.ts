import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";

export const PERMS = ["schedule", "intro", "pages", "map", "settings", "events", "users"] as const;
export type Perm = (typeof PERMS)[number];
export const PERM_LABELS: Record<Perm, string> = {
  schedule: "Zeitplan",
  intro: "Einführung & FAQ",
  pages: "Seiten",
  map: "Lageplan",
  settings: "Einstellungen",
  events: "Veranstaltungen",
  users: "Benutzer",
};

export type User = { id: number; username: string; perms: Perm[] };
export type AppEnv = { Variables: { user: User } };

export const MIN_PASSWORD = 12;
export const SESSION_DAYS = 14;

/** Keeps only known perms, in canonical order. */
export const cleanPerms = (perms: unknown[]): Perm[] => PERMS.filter((p) => perms.includes(p));

export async function createUser(db: Database, username: string, password: string, perms: Perm[]): Promise<number> {
  const hash = await Bun.password.hash(password);
  const r = db.run("INSERT INTO users (username, hash, perms) VALUES (?, ?, ?)", [username, hash, JSON.stringify(cleanPerms(perms))]);
  return Number(r.lastInsertRowid);
}

export async function bootstrapAdmin(db: Database, env: Record<string, string | undefined>): Promise<void> {
  const { n } = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!;
  if (n > 0) return;
  const { ADMIN_USER: user, ADMIN_PASSWORD: pw } = env;
  if (!user || !pw || pw.length < MIN_PASSWORD) {
    console.warn(`Kein Admin vorhanden. Starte mit ADMIN_USER und ADMIN_PASSWORD (mind. ${MIN_PASSWORD} Zeichen), um einen anzulegen.`);
    return;
  }
  await createUser(db, user, pw, [...PERMS]);
  console.log(`Admin "${user}" angelegt.`);
}

export async function verifyLogin(db: Database, username: string, password: string): Promise<number | null> {
  const row = db.query<{ id: number; hash: string }, [string]>("SELECT id, hash FROM users WHERE username = ?").get(username);
  if (!row) return null;
  return (await Bun.password.verify(password, row.hash)) ? row.id : null;
}

export function createSession(db: Database, userId: number): string {
  const token = crypto.randomUUID();
  db.run("DELETE FROM sessions WHERE expires <= ?", [Date.now()]);
  db.run("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)", [token, userId, Date.now() + SESSION_DAYS * 864e5]);
  return token;
}

export function sessionUser(db: Database, token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .query<{ id: number; username: string; perms: string }, [string, number]>(
      "SELECT u.id, u.username, u.perms FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?",
    )
    .get(token, Date.now());
  return row && { id: row.id, username: row.username, perms: JSON.parse(row.perms) };
}

export const isHttps = (c: Context) => new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";

/** Client IP for rate limiting. X-Forwarded-For is only trusted with TRUST_PROXY=1, and then only its last entry (added by our proxy). */
export function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === "1") {
    const fwd = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ponytail: in-memory, resets on restart; fine for a single process.
export function loginLimiter(max = 5, windowMs = 60_000) {
  const fails = new Map<string, number[]>();
  const recent = (ip: string) => (fails.get(ip) ?? []).filter((t) => Date.now() - t < windowMs);
  return {
    blocked: (ip: string) => recent(ip).length >= max,
    fail: (ip: string) => {
      // forget addresses whose attempts are over, so the map does not grow forever
      for (const other of fails.keys()) if (!recent(other).length) fails.delete(other);
      fails.set(ip, [...recent(ip), Date.now()]);
    },
  };
}

export const requireLogin = (db: Database): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = sessionUser(db, getCookie(c, "sid"));
  if (!user) return c.redirect("/admin/login");
  c.set("user", user);
  await next();
};

export const can = (user: User, p: Perm) => user.perms.includes(p);
