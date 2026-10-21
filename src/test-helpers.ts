import type { Hono } from "hono";
import { createApp } from "./app";
import { createUser, type Perm } from "./auth";
import { openDb } from "./db";
import type { Database } from "bun:sqlite";

export function testApp(clock?: () => number) {
  const db = openDb(":memory:");
  return { app: createApp(db, clock), db };
}

export const TEST_PASSWORD = "test-password-123";

/** POST a form like a same-origin browser would. */
export function post(app: Hono, path: string, fields: Record<string, string | string[]> = {}, cookie = "", headers: Record<string, string> = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  return app.request(path, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", ...(cookie && { cookie }), ...headers },
  });
}

let n = 0;
export async function loginAs(app: Hono, db: Database, perms: Perm[]): Promise<string> {
  const username = `user${++n}`;
  await createUser(db, username, TEST_PASSWORD, perms);
  const res = await post(app, "/admin/login", { username, password: TEST_PASSWORD }, "", { "x-forwarded-for": `10.0.0.${n}` });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
