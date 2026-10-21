import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { can, type AppEnv } from "../auth";
import { applyImport, canBackup, exportBackup, parseBackup, PART_PERMS, previewImport } from "../backup";
import { bump, getEvent } from "../db";
import { berlinNow } from "../time";
import { attachment, decode, slug } from "../text";
import { uploadDir, uploadedFile } from "../uploads";
import { Forbidden } from "../views/admin";
import { BackupPage, ImportPreview } from "../views/backup";
import { form } from "./util";

const MAX_BYTES = 100 * 1024 * 1024;
const TOKEN = /^[0-9a-f-]{36}$/;
/** Uploaded files wait here between preview and import; next to the uploads, so inside the data volume. */
const importDir = () => process.env.IMPORT_DIR ?? join(uploadDir(), "..", "imports");

/** Removes waiting imports older than an hour (abandoned previews). */
function pruneImports() {
  mkdirSync(importDir(), { recursive: true });
  for (const name of readdirSync(importDir())) {
    const path = join(importDir(), name);
    if (Date.now() - statSync(path).mtimeMs > 3_600_000) rmSync(path, { force: true });
  }
}

export function backupRoutes(db: Database) {
  const r = new Hono<AppEnv>();
  const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!canBackup(c.get("user"))) return c.html(<Forbidden db={db} user={c.get("user")} />, 403);
    await next();
  };
  r.use("/sicherung", gate);
  r.use("/sicherung/*", gate);
  const page = (c: Context<AppEnv>, props: { error?: string; done?: string[] } = {}, status: 200 | 400 = 200) =>
    c.html(<BackupPage db={db} user={c.get("user")} {...props} />, status);

  r.get("/sicherung", (c) => {
    const only = Number(c.req.query("event")) || undefined;
    return c.html(<BackupPage db={db} user={c.get("user")} only={only ? (getEvent(db, only) ?? undefined) : undefined} />);
  });

  r.get("/sicherung/export", async (c) => {
    const user = c.get("user");
    const on = (k: string) => c.req.query(k) === "1";
    const ids = (k: string) => (c.req.queries(k) ?? []).map(Number).filter(Number.isInteger);
    // Parts without the matching permission are dropped, also when the address was written by hand.
    const sel = {
      settings: on("settings") && can(user, PART_PERMS.settings),
      pages: on("pages") && can(user, PART_PERMS.pages),
      users: on("users") && can(user, PART_PERMS.users),
      venues: can(user, PART_PERMS.venues) ? ids("venue") : [],
      events: can(user, PART_PERMS.events) ? ids("event") : [],
      changes: on("changes"),
    };
    if (!sel.settings && !sel.pages && !sel.users && !sel.venues.length && !sel.events.length)
      return page(c, { error: "Bitte mindestens einen Teil auswählen." }, 400);
    const date = berlinNow().date;
    const single = sel.events.length === 1 && !sel.settings && !sel.pages && !sel.users ? getEvent(db, sel.events[0]!) : null;
    const base = single ? `veranstaltung-${single.name}` : "konferenzkompass";
    c.header("Content-Disposition", attachment(`${slug(base, "konferenzkompass")}-${date}.json`, `${base}-${date}.json`));
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.body(JSON.stringify(await exportBackup(db, sel)));
  });

  r.post("/sicherung/import", async (c) => {
    const file = uploadedFile((await form(c)).body.file);
    if (!file) return page(c, { error: "Bitte eine Datei auswählen." }, 400);
    if (file.size > MAX_BYTES) return page(c, { error: "Die Datei ist zu groß (höchstens 100 MB)." }, 400);
    const text = decode(new Uint8Array(await file.arrayBuffer()));
    const { data, errors } = parseBackup(text);
    if (!data) return page(c, { error: `Import nicht möglich: ${errors.join(" ")}` }, 400);
    pruneImports();
    const token = crypto.randomUUID();
    await Bun.write(join(importDir(), `${token}.json`), text);
    return c.html(<ImportPreview db={db} user={c.get("user")} rows={previewImport(db, data, c.get("user"))} token={token} created={data.created} />);
  });

  r.post("/sicherung/import/:token", async (c) => {
    const token = c.req.param("token");
    const path = join(importDir(), `${token}.json`);
    const file = Bun.file(path);
    if (!TOKEN.test(token) || !(await file.exists())) return page(c, { error: "Die hochgeladene Datei ist abgelaufen. Bitte noch einmal hochladen." }, 400);
    const { data } = parseBackup(await file.text());
    if (!data) return page(c, { error: "Die hochgeladene Datei ist nicht mehr lesbar." }, 400);
    const f = await form(c);
    const choices = Object.fromEntries(Object.keys(f.body).map((k) => [k, f.str(k)]));
    let done: string[];
    try {
      ({ done } = await applyImport(db, data, choices, c.get("user")));
    } catch (e) {
      return page(c, { error: `Import fehlgeschlagen, es wurde nichts geändert: ${(e as Error).message}` }, 400);
    }
    rmSync(path, { force: true });
    bump(db);
    return page(c, { done });
  });

  return r;
}
