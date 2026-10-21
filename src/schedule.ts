import { duration, unwrapStarts } from "./time";

/** One day's entries in their order. Times are "HH:MM"; entries after midnight count as the same (event) day. */
export type Item = { id: number; start: string; end: string; kind: "agenda" | "break"; done: boolean };

/** Live state of today; all times in minutes since the day's midnight (past 1440 at night, see eventNow). */
export type LiveInput = {
  /** The running agenda item, or the one frozen by a pause; breaks are never current. */
  currentItemId: number | null;
  /** Null while paused. */
  startedAt: number | null;
  elapsedBefore: number;
  /** `untilMs` is the exact end as a timestamp, for the countdown. */
  pause: { title: string; start: number; until: number; untilMs: number } | null;
};

export type Row = {
  id: number;
  plannedStart: number;
  expectedStart: number;
  expectedEnd: number;
  /** End as planned from the actual start, ignoring overrun (equals expectedEnd unless the item overruns). */
  dueEnd: number;
  status: "done" | "current" | "interrupted" | "upcoming";
  overrun: boolean;
};

/** Expected times for one day (spec §4): delays push everything back, early finishes pull agenda items (not breaks) forward. */
export function computeDay(items: Item[], live: LiveInput | null, now: number): Row[] {
  const rows = new Map<number, Row>();
  const starts = new Map(unwrapStarts(items.map((it) => it.start)).map((s, i) => [items[i]!.id, s]));
  const planned = (it: Item, status: Row["status"]): Row => {
    const s = starts.get(it.id)!;
    const end = s + duration(it.start, it.end);
    return { id: it.id, plannedStart: s, expectedStart: s, expectedEnd: end, dueEnd: end, status, overrun: false };
  };
  for (const it of items) rows.set(it.id, planned(it, it.done ? "done" : "upcoming"));

  if (!live) return items.map((it) => rows.get(it.id)!);
  const current = items.find((it) => it.id === live.currentItemId);
  let cursor = now;
  if (live.pause) {
    // An overrun pause keeps pushing everything back until someone presses Weiter.
    cursor = Math.max(now, live.pause.until);
    if (current) {
      const end = cursor + Math.max(0, duration(current.start, current.end) - live.elapsedBefore);
      rows.set(current.id, { ...rows.get(current.id)!, status: "interrupted", expectedStart: cursor, expectedEnd: end, dueEnd: end });
      cursor = end;
    }
  } else if (current && live.startedAt !== null) {
    const plannedEnd = live.startedAt + Math.max(0, duration(current.start, current.end) - live.elapsedBefore);
    cursor = Math.max(now, plannedEnd);
    rows.set(current.id, { ...rows.get(current.id)!, status: "current", expectedStart: live.startedAt, expectedEnd: cursor, dueEnd: plannedEnd, overrun: now > plannedEnd });
  } else return items.map((it) => rows.get(it.id)!);

  // After a pause with nothing behind it, the next entry does not start earlier than planned.
  let pinned = !current;
  for (const it of items) {
    if (it.done || it === current) continue;
    const row = rows.get(it.id)!;
    const start = it.kind === "break" || pinned ? Math.max(cursor, row.plannedStart) : cursor;
    pinned = false;
    cursor = start + duration(it.start, it.end);
    rows.set(it.id, { ...row, expectedStart: start, expectedEnd: cursor, dueEnd: cursor });
  }
  return items.map((it) => rows.get(it.id)!);
}

/** The entry that should be running now according to the plan. */
export function plannedNowId(items: Item[], now: number): number | null {
  const starts = unwrapStarts(items.map((it) => it.start));
  const hit = items.find((it, i) => now >= starts[i]! && now < starts[i]! + duration(it.start, it.end));
  return hit?.id ?? null;
}
