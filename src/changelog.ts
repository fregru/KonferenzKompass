import type { Database } from "bun:sqlite";
import { getItem, type ItemRow } from "./db";
import { getLive } from "./live";
import type { Room } from "./rooms";
import { berlinNow, duration, fmt } from "./time";
import { itemLabel } from "./views/labels";

/** One line of the change log: who changed which entry or the live state. `item_id` may point at a deleted entry. */
export type Change = { id: number; event_id: number; at: number; username: string; item_id: number | null; text: string };

/** Entries kept per event; older ones are dropped. */
const KEEP = 1000;

export function logChange(db: Database, eventId: number, username: string, text: string, itemId: number | null = null, now = Date.now()) {
  db.run("INSERT INTO changes (event_id, at, username, item_id, text) VALUES (?, ?, ?, ?, ?)", [eventId, now, username, itemId, text]);
  db.run(
    "DELETE FROM changes WHERE event_id = ? AND id <= (SELECT id FROM changes WHERE event_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
    [eventId, eventId, KEEP],
  );
}

/** Newest first. */
export const changesFor = (db: Database, eventId: number, limit: number): Change[] =>
  db.query<Change, [number, number]>("SELECT * FROM changes WHERE event_id = ? ORDER BY id DESC LIMIT ?").all(eventId, limit);

export const quoted = (it: Pick<ItemRow, "top_number" | "title">) => `„${itemLabel(it)}“`;

const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
/** "2026-11-13" → "Fr., 13.11." */
export const shortDayLabel = (date: string) => shortDay.format(new Date(`${date}T12:00:00Z`));

/** The live state after a step: "läuft: „TOP 4 Bericht“", "Pause „Mittag“ bis 13:30" or "nichts läuft". */
export function liveSummary(db: Database, eventId: number): string {
  const live = getLive(db, eventId);
  const current = live?.current_item_id == null ? null : getItem(db, live.current_item_id);
  if (live?.pause_until != null) {
    const pause = `Pause „${live.pause_title ?? "Pause"}“ bis ${fmt(berlinNow(new Date(live.pause_until)).minutes)}`;
    return current ? `${pause}, ${quoted(current)} unterbrochen` : pause;
  }
  return current ? `läuft: ${quoted(current)}` : "nichts läuft";
}

type Diffable = Pick<
  ItemRow,
  "date" | "start" | "end" | "title" | "top_number" | "kind" | "location" | "description" | "responsible" | "show_responsible" | "fixed" | "room_id" | "menu"
>;

/** Changed fields of an entry, e.g. "Beginn 10:00 → 10:30, Raum Saal → Foyer"; empty when nothing changed. */
export function itemDiff(before: Diffable, after: Diffable, rooms: Map<number, Pick<Room, "name">>): string {
  const room = (id: number | null) => (id === null ? "–" : (rooms.get(id)?.name ?? "?"));
  const text = (v: string) => v || "–";
  const out: string[] = [];
  const add = (label: string, a: string, b: string) => a !== b && out.push(`${label} ${a} → ${b}`);
  add("Titel", text(itemLabel(before)), text(itemLabel(after)));
  add("Tag", shortDayLabel(before.date), shortDayLabel(after.date));
  add("Beginn", before.start, after.start);
  add("Dauer", `${duration(before.start, before.end)} min`, `${duration(after.start, after.end)} min`);
  add("Art", before.kind === "break" ? "Pause" : "TO-Punkt", after.kind === "break" ? "Pause" : "TO-Punkt");
  add("Zeit", before.fixed ? "fest" : "fließend", after.fixed ? "fest" : "fließend");
  add("Raum", room(before.room_id), room(after.room_id));
  add("Ort", text(before.location), text(after.location));
  add("Zuständig", text(before.responsible), text(after.responsible));
  if (before.show_responsible !== after.show_responsible) out.push(after.show_responsible ? "Zuständig öffentlich" : "Zuständig nicht öffentlich");
  if (before.description !== after.description) out.push("Beschreibung geändert");
  if (before.menu !== after.menu) out.push("Essen geändert");
  return out.join(", ");
}
