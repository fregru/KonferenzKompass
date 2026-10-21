import type { Database } from "bun:sqlite";
import { endOf, type ImportRow } from "./csv";
import { getEvent, getItem, type ItemRow } from "./db";
import { roomsOf } from "./rooms";
import { duration, fmt, toMinutes, unwrapStarts } from "./time";

/** One day's top-level entries in their order. */
export const dayItems = (db: Database, eventId: number, date: string) =>
  db
    .query<ItemRow, [number, string]>("SELECT * FROM items WHERE event_id = ? AND date = ? AND parent_id IS NULL ORDER BY sort, start, id")
    .all(eventId, date);

/** Moves an entry's sub-points by `delta` minutes (they keep their place within the parent). */
export function shiftSubItems(db: Database, parentId: number, delta: number) {
  if (delta === 0) return;
  for (const s of db.query<ItemRow, [number]>("SELECT * FROM items WHERE parent_id = ?").all(parentId))
    db.run(`UPDATE items SET start = ?, "end" = ? WHERE id = ?`, [fmt(toMinutes(s.start) + delta), fmt(toMinutes(s.end) + delta), s.id]);
}

/** Minutes from the parent's start and length of a sub-point, or an error when it does not fit into the parent. */
export function subSlot(parent: Pick<ItemRow, "start" | "end">, start: string, end: string): string | null {
  const offset = (toMinutes(start) - toMinutes(parent.start) + 1440) % 1440;
  return offset + duration(start, end) > duration(parent.start, parent.end)
    ? `Unterpunkte müssen in die Zeit des Eintrags passen (${parent.start}–${parent.end}).`
    : null;
}

/**
 * Recalculates a day: fixed entries keep their start, flowing ones start when the previous entry ends.
 * A flowing first entry starts at `dayStart` (default: its own start). Writes start, end and sort.
 */
export function reflow(db: Database, eventId: number, date: string, dayStart?: string) {
  let cursor: number | null = null;
  dayItems(db, eventId, date).forEach((it, i) => {
    const len = duration(it.start, it.end);
    let own = toMinutes(it.start);
    if (cursor !== null && own < cursor - 720) own += 1440;
    const start = it.fixed ? own : (cursor ?? (dayStart === undefined ? own : toMinutes(dayStart)));
    // ponytail: after a clash the fixed entry wins and the next ones follow it; the warning shows the overlap.
    cursor = start + len;
    db.run(`UPDATE items SET start = ?, "end" = ?, sort = ? WHERE id = ?`, [fmt(start), fmt(cursor), i, it.id]);
    shiftSubItems(db, it.id, start - toMinutes(it.start));
  });
}

/** Overlap in minutes for each entry that starts before the previous one ends (one day, in order). */
export function clashes(items: ItemRow[]): Map<number, { minutes: number; with: ItemRow }> {
  const starts = unwrapStarts(items.map((it) => it.start));
  const out = new Map<number, { minutes: number; with: ItemRow }>();
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!;
    const over = starts[i - 1]! + duration(prev.start, prev.end) - starts[i]!;
    if (over > 0) out.set(items[i]!.id, { minutes: over, with: prev });
  }
  return out;
}

/**
 * Moves an entry to position `index` on `date` (default: fixed entries by their time, flowing ones to the end)
 * and recalculates the affected days. Both days keep their start time; `dayStart` overrides it for `date`.
 */
export function moveItem(db: Database, itemId: number, date: string, index?: number, dayStart?: string) {
  db.transaction(() => {
    const it = getItem(db, itemId)!;
    const from = dayItems(db, it.event_id, it.date);
    const to = date === it.date ? from : dayItems(db, it.event_id, date);
    const rest = to.filter((x) => x.id !== it.id);
    const byTime = () => {
      const i = rest.findIndex((x) => toMinutes(x.start) > toMinutes(it.start));
      return i < 0 ? rest.length : i;
    };
    const pos = Math.max(0, Math.min(rest.length, index ?? (it.fixed ? byTime() : rest.length)));
    rest.splice(pos, 0, it);
    db.run("UPDATE items SET date = ? WHERE id = ? OR parent_id = ?", [date, it.id, it.id]);
    rest.forEach((x, i) => db.run("UPDATE items SET sort = ? WHERE id = ?", [i, x.id]));
    if (date !== it.date) {
      from.filter((x) => x.id !== it.id).forEach((x, i) => db.run("UPDATE items SET sort = ? WHERE id = ?", [i, x.id]));
      reflow(db, it.event_id, it.date, from[0]?.start);
    }
    reflow(db, it.event_id, date, dayStart ?? to[0]?.start ?? it.start);
  })();
}

/** Deletes an entry; the rest of its day closes up behind it. */
export function deleteItem(db: Database, itemId: number) {
  db.transaction(() => {
    const it = getItem(db, itemId)!;
    const dayStart = dayItems(db, it.event_id, it.date)[0]?.start;
    db.run("DELETE FROM items WHERE id = ?", [it.id]);
    reflow(db, it.event_id, it.date, dayStart);
  })();
}

/**
 * Replaces the event's whole schedule with imported rows (already validated and sorted by day). Refused once an
 * entry is done, so a running event is never pulled out from under the live control.
 */
export function importSchedule(db: Database, eventId: number, rows: ImportRow[]) {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM items WHERE event_id = ? AND done = 1").get(eventId))
      throw new Error("Import nicht möglich: Einträge dieser Veranstaltung sind schon erledigt.");
    db.run("DELETE FROM live WHERE event_id = ?", [eventId]);
    db.run("DELETE FROM live_history WHERE event_id = ?", [eventId]);
    db.run("DELETE FROM items WHERE event_id = ?", [eventId]);
    const venueId = getEvent(db, eventId)?.venue_id ?? null;
    const rooms = venueId === null ? [] : roomsOf(db, venueId);
    const findRoom = (name: string) => rooms.find((x) => [x.name, x.short].some((n) => n && n.toLowerCase() === name.toLowerCase()));
    const insert = (r: ImportRow, start: string, sort: number, parentId: number | null) => {
      const room = r.room ? findRoom(r.room) : undefined;
      // An unknown room stays readable as free-text place.
      const location = r.room && !room ? [r.room, r.location].filter(Boolean).join(", ") : r.location;
      return Number(
        db.run(
          `INSERT INTO items (event_id, date, start, "end", title, kind, top_number, location, room_id, responsible, description, fixed, sort, parent_id, menu)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [eventId, r.date, start, endOf(start, r.minutes), r.title, r.kind, r.top_number, location, room?.id ?? null, r.responsible,
            r.description, r.start && !parentId ? 1 : 0, sort, parentId, r.kind === "break" ? r.menu : ""],
        ).lastInsertRowid,
      );
    };
    // Main entries first (flowing ones are placed by reflow), then the sub-points at their parent's final time.
    const subs: [ImportRow, number, number][] = [];
    let parent = 0;
    let subSort = 0;
    rows.forEach((r, i) => {
      if (r.sub) subs.push([r, parent, subSort++]);
      else (parent = insert(r, r.start ?? "00:00", i, null)), (subSort = 0);
    });
    for (const date of new Set(rows.map((r) => r.date))) reflow(db, eventId, date);
    for (const [r, parentId, sort] of subs) {
      const parent = getItem(db, parentId)!;
      const start = r.start ?? parent.start;
      const error = subSlot(parent, start, endOf(start, r.minutes));
      if (error) throw new Error(`Zeile ${r.line}: ${error}`);
      insert(r, start, sort, parentId);
    }
  })();
}
