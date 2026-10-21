import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { activeEvent, type Event, type ItemRow } from "./db";
import { duration, toMinutes } from "./time";
import { releaseUploads, saveData, uploadDir } from "./uploads";

/** A house with floors; independent of events, each event picks one. */
export type Venue = { id: number; name: string; sort: number };
/** `image`: uploaded floor plan (usually SVG), shown as background for the drawn rooms. */
export type Floor = { id: number; venue_id: number; name: string; image: string; sort: number };
/**
 * `shape`: JSON polygon `[[x, y], …]` in percent of the floor image, so it fits any display size.
 * Areas (Foyer, Wiese) are shown and selectable but never count as booked.
 */
export type Room = {
  id: number; venue_id: number; floor_id: number | null; name: string; short: string; description: string;
  kind: "room" | "area"; shape: string; sort: number;
};
export type Point = [number, number];

export const venues = (db: Database): Venue[] => db.query<Venue, []>("SELECT * FROM venues ORDER BY sort, name, id").all();
export const getVenue = (db: Database, id: number | string | null): Venue | null =>
  id === null ? null : db.query<Venue, [number | string]>("SELECT * FROM venues WHERE id = ?").get(id);
export const floorsOf = (db: Database, venueId: number): Floor[] =>
  db.query<Floor, [number]>("SELECT * FROM floors WHERE venue_id = ? ORDER BY sort, id").all(venueId);
export const getFloor = (db: Database, id: number | string): Floor | null =>
  db.query<Floor, [number | string]>("SELECT * FROM floors WHERE id = ?").get(id);
/** Rooms grouped in floor order; rooms without a floor come last. */
export const roomsOf = (db: Database, venueId: number): Room[] =>
  db
    .query<Room, [number]>(
      `SELECT r.* FROM rooms r LEFT JOIN floors f ON f.id = r.floor_id WHERE r.venue_id = ?
       ORDER BY f.id IS NULL, f.sort, f.id, r.sort, r.name, r.id`,
    )
    .all(venueId);
export const getRoom = (db: Database, id: number | string | null): Room | null =>
  id === null ? null : db.query<Room, [number | string]>("SELECT * FROM rooms WHERE id = ?").get(id);

/** A valid polygon (at least 3 points, all within 0–100), or null. */
export function parseShape(v: unknown): Point[] | null {
  let pts: unknown = v;
  if (typeof v === "string") {
    if (!v) return null;
    try {
      pts = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(pts) || pts.length < 3 || pts.length > 500) return null;
  const ok = pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && n >= 0 && n <= 100));
  return ok ? (pts as Point[]).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) : null;
}

/** Label point of a polygon: the centroid, falling back to the bounding box centre for degenerate shapes. */
export function centre(pts: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  pts.forEach(([x0, y0], i) => {
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  });
  if (Math.abs(a) < 1e-6) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** The map page, when it is switched on. */
export function mapPage(db: Database): string | null {
  const p = db.query<{ slug: string }, []>("SELECT slug FROM pages WHERE kind = 'map' AND enabled = 1 ORDER BY sort LIMIT 1").get();
  return p ? `/p/${p.slug}` : null;
}

/** The venue the public map shows: the active event's, otherwise the first one. */
export function publicVenue(db: Database): Venue | null {
  const ev = activeEvent(db);
  return getVenue(db, ev?.venue_id ?? null) ?? venues(db)[0] ?? null;
}

/** Deletes a room; entries that used it keep its name as free-text place. */
export function deleteRoom(db: Database, id: number) {
  db.run("UPDATE items SET location = (SELECT name FROM rooms WHERE id = ?) WHERE room_id = ? AND location = ''", [id, id]);
  db.run("DELETE FROM rooms WHERE id = ?", [id]);
}

/** Rooms by id for one venue (empty without a venue). */
export const roomMap = (db: Database, venueId: number | null) => new Map(venueId === null ? [] : roomsOf(db, venueId).map((r) => [r.id, r]));

// ---------- occupancy ----------

/** An entry using a room; times in minutes since midnight, `end` may pass 1440. */
export type Booking = { item: ItemRow; start: number; end: number };

const span = (start: string, end: string): [number, number] => {
  const s = toMinutes(start);
  return [s, s + duration(start, end)];
};
/** Overlap of two spans, also across midnight. */
const overlaps = (a: [number, number], b: [number, number]) =>
  [0, 1440, -1440].some((d) => a[0] + d < b[1] && b[0] < a[1] + d);

/** Entries (and sub-points) with a room on one day, by room id. */
export function bookings(db: Database, eventId: number, date: string): Map<number, Booking[]> {
  const out = new Map<number, Booking[]>();
  const rows = db
    .query<ItemRow, [number, string]>("SELECT * FROM items WHERE event_id = ? AND date = ? AND room_id IS NOT NULL ORDER BY start, id")
    .all(eventId, date);
  for (const it of rows) {
    const [start, end] = span(it.start, it.end);
    out.set(it.room_id!, [...(out.get(it.room_id!) ?? []), { item: it, start, end }]);
  }
  return out;
}

export type RoomStatus = { room: Room; conflicts: Booking[] };

/**
 * Every room of the event's venue with the entries that overlap `start`–`end` on `date`, ignoring only `selfId` (the
 * entry being edited). A parent and its sub-points count like any other entries. Areas never conflict.
 */
export function roomStatus(db: Database, event: Event, date: string, start: string, end: string, selfId?: number): RoomStatus[] {
  if (event.venue_id === null) return [];
  const booked = bookings(db, event.id, date);
  const slot = span(start, end);
  return roomsOf(db, event.venue_id).map((room) => ({
    room,
    conflicts:
      room.kind === "area" ? [] : (booked.get(room.id) ?? []).filter((b) => b.item.id !== selfId && overlaps(slot, [b.start, b.end])),
  }));
}

// ---------- JSON export / import ----------

export const VENUE_FORMAT = "diko-lageplan";
const IMAGE_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const EXT_FOR = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([k, v]) => [v, k === "jpeg" ? "jpg" : k]));
export const FLOOR_MAX_BYTES = 10 * 1024 * 1024;

export type RoomJson = { name: string; short: string; description: string; kind: "room" | "area"; shape: Point[] | null };
export type VenueJson = {
  format: typeof VENUE_FORMAT; version: 1; name: string;
  /** `image`: data URI of the floor plan, or "" without one. */
  floors: { name: string; image: string; rooms: RoomJson[] }[];
  /** Rooms without a floor. */
  rooms: RoomJson[];
};

const roomJson = (r: Room): RoomJson => ({ name: r.name, short: r.short, description: r.description, kind: r.kind, shape: parseShape(r.shape) });

/** One self-contained file: floor plans are embedded as data URIs. */
export async function exportVenue(db: Database, venueId: number): Promise<VenueJson> {
  const venue = getVenue(db, venueId)!;
  const rooms = roomsOf(db, venueId);
  const floors = [];
  for (const f of floorsOf(db, venueId)) {
    let image = "";
    const file = f.image && Bun.file(join(uploadDir(), f.image));
    if (file && (await file.exists())) {
      const type = IMAGE_TYPES[f.image.split(".").pop()!] ?? "application/octet-stream";
      image = `data:${type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
    }
    floors.push({ name: f.name, image, rooms: rooms.filter((r) => r.floor_id === f.id).map(roomJson) });
  }
  return { format: VENUE_FORMAT, version: 1, name: venue.name, floors, rooms: rooms.filter((r) => r.floor_id === null).map(roomJson) };
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validates an exported file; errors are German and name the floor or room. */
export function parseVenueJson(text: string): { data: VenueJson | null; errors: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { data: null, errors: ["Die Datei ist kein gültiges JSON."] };
  }
  if (raw?.format !== VENUE_FORMAT || raw.version !== 1) return { data: null, errors: ["Die Datei ist kein Lageplan-Export (Version 1)."] };
  const errors: string[] = [];
  const names = new Set<string>();
  const rooms = (list: unknown, where: string): RoomJson[] =>
    (Array.isArray(list) ? list : []).flatMap((r: any, i): RoomJson[] => {
      const name = str(r?.name, 200);
      if (!name) return errors.push(`${where}, Raum ${i + 1}: Name fehlt.`), [];
      if (names.has(name.toLowerCase())) errors.push(`${where}: Raum „${name}“ kommt doppelt vor.`);
      names.add(name.toLowerCase());
      const shape = r.shape == null ? null : parseShape(r.shape);
      if (r.shape != null && !shape) errors.push(`${where}: Umriss von „${name}“ ist ungültig.`);
      return [{ name, short: str(r.short, 50), description: str(r.description, 2000), kind: r.kind === "area" ? "area" : "room", shape }];
    });
  const floors = (Array.isArray(raw.floors) ? raw.floors : []).map((f: any, i: number) => {
    const name = str(f?.name, 200) || `Etage ${i + 1}`;
    const image = typeof f?.image === "string" ? f.image : "";
    const m = /^data:([\w/+.-]+);base64,/.exec(image);
    if (image && (!m || !EXT_FOR[m[1]!])) errors.push(`${name}: Bild ist ungültig (SVG, PNG, JPG oder WebP).`);
    else if (image && (image.length * 3) / 4 > FLOOR_MAX_BYTES) errors.push(`${name}: Bild größer als 10 MB.`);
    return { name, image, rooms: rooms(f?.rooms, name) };
  });
  const data: VenueJson = { format: VENUE_FORMAT, version: 1, name: str(raw.name, 200), floors, rooms: rooms(raw.rooms, "Ohne Etage") };
  if (!data.name) errors.push("Name des Ortes fehlt.");
  return { data: errors.length ? null : data, errors };
}

/**
 * Creates a venue from an export, or replaces `targetId` with it. When replacing, rooms are matched by name so
 * schedule entries keep their room; rooms missing from the file are deleted (entries keep their free-text place).
 */
export async function importVenue(db: Database, data: VenueJson, targetId?: number): Promise<number> {
  const images: string[] = [];
  for (const f of data.floors) {
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(f.image);
    images.push(m ? await saveData(Buffer.from(m[2]!, "base64"), EXT_FOR[m[1]!]!, FLOOR_MAX_BYTES) : "");
  }
  // Replaced floor plans are deleted afterwards; a failed import drops the files it just saved.
  const oldImages = targetId === undefined ? [] : floorsOf(db, targetId).map((f) => f.image);
  const write = db.transaction(() => {
    let venueId = targetId;
    if (venueId === undefined) venueId = Number(db.run("INSERT INTO venues (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM venues))", [data.name]).lastInsertRowid);
    else db.run("UPDATE venues SET name = ? WHERE id = ?", [data.name, venueId]);
    db.run("DELETE FROM floors WHERE venue_id = ?", [venueId]);
    const existing = new Map(roomsOf(db, venueId).map((r) => [r.name.toLowerCase(), r.id]));
    const keep = new Set<number>();
    let sort = 0;
    const put = (r: RoomJson, floorId: number | null) => {
      const values = [floorId, r.name, r.short, r.description, r.kind, r.shape ? JSON.stringify(r.shape) : "", sort++];
      const id = existing.get(r.name.toLowerCase());
      if (id !== undefined) {
        db.run("UPDATE rooms SET floor_id = ?, name = ?, short = ?, description = ?, kind = ?, shape = ?, sort = ? WHERE id = ?", [...values, id]);
        keep.add(id);
      } else db.run("INSERT INTO rooms (venue_id, floor_id, name, short, description, kind, shape, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [venueId, ...values]);
    };
    data.floors.forEach((f, i) => {
      const floorId = Number(db.run("INSERT INTO floors (venue_id, name, image, sort) VALUES (?, ?, ?, ?)", [venueId, f.name, images[i]!, i]).lastInsertRowid);
      f.rooms.forEach((r) => put(r, floorId));
    });
    data.rooms.forEach((r) => put(r, null));
    for (const id of existing.values()) if (!keep.has(id)) deleteRoom(db, id);
    return venueId;
  });
  let venueId: number;
  try {
    venueId = write();
  } catch (e) {
    releaseUploads(db, images);
    throw e;
  }
  releaseUploads(db, oldImages);
  return venueId;
}
