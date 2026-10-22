import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};
const MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[0-9a-f-]{36}\.(png|jpe?g|webp|ico|svg)$/;

export const uploadDir = () => process.env.UPLOAD_DIR ?? "data/uploads";

/** Stores an image under a random name and returns that name. Throws a German message on invalid input. */
export async function saveUpload(file: File, maxBytes = MAX_BYTES): Promise<string> {
  return saveData(file, file.name.split(".").pop()?.toLowerCase() ?? "", maxBytes);
}

/** Like saveUpload, for data that has no file name (e.g. decoded from an import). */
export async function saveData(data: Blob | Uint8Array, ext: string, maxBytes = MAX_BYTES): Promise<string> {
  if (!(ext in TYPES)) throw new Error("Dateityp nicht erlaubt (PNG, JPG, WebP, ICO, SVG).");
  const size = data instanceof Blob ? data.size : data.byteLength;
  if (size > maxBytes) throw new Error(`Datei größer als ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const name = `${crypto.randomUUID()}.${ext}`;
  mkdirSync(uploadDir(), { recursive: true });
  await Bun.write(join(uploadDir(), name), data);
  return name;
}

/** An upload as data URI for an export; "" when there is none or the file is gone. */
export async function uploadDataUri(name: string): Promise<string> {
  const file = NAME.test(name) && Bun.file(join(uploadDir(), name));
  if (!file || !(await file.exists())) return "";
  return `data:${TYPES[name.split(".").pop()!]};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
}

/** The bytes and file extension of an image data URI, or null when it is not one of the allowed types. */
export function fromDataUri(uri: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(uri);
  const ext = m && Object.entries(TYPES).find(([, type]) => type === m[1])?.[0];
  return ext ? { bytes: new Uint8Array(Buffer.from(m[2]!, "base64")), ext: ext === "jpeg" ? "jpg" : ext } : null;
}

/** Upload names the database still refers to. */
function usedUploads(db: Database): Set<string> {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT value AS name FROM settings WHERE key IN ('logo', 'favicon', 'hero_image', 'app_icon') UNION SELECT photo FROM contacts UNION SELECT image FROM floors",
    )
    .all();
  return new Set(rows.map((r) => r.name));
}

/**
 * Deletes these uploads unless something still refers to them (copied events share photos), so a removed photo is
 * really gone and no longer reachable by its URL.
 */
export function releaseUploads(db: Database, names: (string | null | undefined)[]) {
  const used = usedUploads(db);
  for (const n of names) if (n && NAME.test(n) && !used.has(n)) rmSync(join(uploadDir(), n), { force: true });
}

/** Deletes every upload nothing refers to (e.g. left over from older versions); run at startup. */
export const pruneUploads = (db: Database) => releaseUploads(db, readdirSync(uploadDir()));

/** A non-empty uploaded file from a parsed multipart body, or null. */
export const uploadedFile = (v: unknown): File | null => (v instanceof File && v.size > 0 ? v : null);

export function uploadRoutes() {
  const r = new Hono();
  r.get("/uploads/:name", async (c) => {
    const name = c.req.param("name");
    if (!NAME.test(name)) return c.notFound();
    const file = Bun.file(join(uploadDir(), name));
    if (!(await file.exists())) return c.notFound();
    return c.body(file.stream(), 200, {
      "Content-Type": TYPES[name.split(".").pop()!]!,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });
  return r;
}
