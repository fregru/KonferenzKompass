import type { Database } from "bun:sqlite";
import type { MiddlewareHandler } from "hono";
import { can, type AppEnv, type Perm } from "../auth";
import { Forbidden } from "../views/admin";

export const requirePerm = (db: Database, p: Perm): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!can(c.get("user"), p)) return c.html(<Forbidden db={db} user={c.get("user")} />, 403);
  await next();
};

/** Form fields as strings; repeated fields (checkboxes) as arrays. */
export async function form(c: { req: { parseBody: (o: { all: true }) => Promise<Record<string, unknown>> } }) {
  const body = await c.req.parseBody({ all: true });
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const list = (k: string) => [body[k] ?? []].flat().filter((x): x is string => typeof x === "string");
  return { body, str, list };
}
