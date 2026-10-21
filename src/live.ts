import type { Database } from "bun:sqlite";
import { bump, getItem } from "./db";
import { dayItems } from "./plan";
import type { LiveInput } from "./schedule";
import { berlinNow, eventNow, toEventTime, toMinutes } from "./time";

/**
 * Live state of an event. `current_item_id` is the running agenda item; breaks never run as items.
 * A pause (`pause_until` set) freezes the current item (`started_at` null, minutes kept in `elapsed_before`)
 * or runs with nothing behind it.
 */
export type LiveRow = {
  event_id: number;
  current_item_id: number | null;
  started_at: number | null;
  elapsed_before: number;
  pause_title: string | null;
  pause_started_at: number | null;
  pause_until: number | null;
};
type State = Omit<LiveRow, "event_id">;
type Snapshot = {
  live: LiveRow | null;
  /** Items this step marked done; Zurück opens them again. */
  markedDone: number[];
  /** [item id, previous done value] for a manual Erledigt/Wieder öffnen. */
  restoreDone?: [number, number];
};

export const getLive = (db: Database, eventId: number): LiveRow | null =>
  db.query<LiveRow, [number]>(
    "SELECT event_id, current_item_id, started_at, elapsed_before, pause_title, pause_started_at, pause_until FROM live WHERE event_id = ?",
  ).get(eventId);

const minutesSince = (from: number | null, now: number) => (from === null ? 0 : Math.max(0, Math.floor((now - from) / 60_000)));

const IDLE: State = { current_item_id: null, started_at: null, elapsed_before: 0, pause_title: null, pause_started_at: null, pause_until: null };

function save(db: Database, eventId: number, l: State) {
  db.run(
    `INSERT INTO live (event_id, current_item_id, started_at, elapsed_before, pause_title, pause_started_at, pause_until)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET current_item_id = excluded.current_item_id,
     started_at = excluded.started_at, elapsed_before = excluded.elapsed_before, pause_title = excluded.pause_title,
     pause_started_at = excluded.pause_started_at, pause_until = excluded.pause_until`,
    [eventId, l.current_item_id, l.started_at, l.elapsed_before, l.pause_title, l.pause_started_at, l.pause_until],
  );
}

const markDone = (db: Database, ids: number[]) => {
  for (const id of ids) db.run("UPDATE items SET done = 1 WHERE id = ?", [id]);
  return ids;
};

/**
 * Runs one live-state step in a transaction: snapshot for "Zurück", then the change, then bump.
 * Daily reset: state started on an earlier day (and its undo history) is discarded, so actions start fresh.
 */
function step(db: Database, eventId: number, now: number, fn: (live: LiveRow | null) => Omit<Snapshot, "live">) {
  db.transaction(() => {
    let live = getLive(db, eventId);
    const since = live?.started_at ?? live?.pause_started_at;
    if (since != null && toEventTime(since).date !== eventNow(new Date(now)).date) {
      db.run("DELETE FROM live WHERE event_id = ?", [eventId]);
      db.run("DELETE FROM live_history WHERE event_id = ?", [eventId]);
      live = null;
    }
    const snap: Snapshot = { live, ...fn(live) };
    db.run("INSERT INTO live_history (event_id, snapshot) VALUES (?, ?)", [eventId, JSON.stringify(snap)]);
    bump(db);
  })();
}

const run = (id: number | null, now: number, elapsedBefore = 0): State => ({
  ...IDLE,
  current_item_id: id,
  started_at: id === null ? null : now,
  elapsed_before: elapsedBefore,
});

/**
 * Starts the next open agenda item on the day of `afterId` (today if none), or the first one. Planned breaks that this skips are
 * marked as passed. Returns the ids marked done.
 */
function startNextAgenda(db: Database, eventId: number, now: number, afterId: number | null): number[] {
  const date = (afterId === null ? null : getItem(db, afterId))?.date ?? eventNow(new Date(now)).date;
  const today = dayItems(db, eventId, date).filter((it) => !it.done && it.id !== afterId);
  const nextIdx = today.findIndex((it) => it.kind === "agenda");
  save(db, eventId, run(nextIdx < 0 ? null : today[nextIdx]!.id, now));
  return nextIdx < 0 ? [] : markDone(db, today.slice(0, nextIdx).map((it) => it.id));
}

/**
 * Weiter: during a pause, end it and resume the frozen item (or start the next agenda item);
 * otherwise finish the current item and start the next agenda item.
 */
export function next(db: Database, eventId: number, now = Date.now()) {
  step(db, eventId, now, (live) => {
    if (live?.pause_until != null && live.current_item_id !== null) {
      save(db, eventId, run(live.current_item_id, now, live.elapsed_before));
      return { markedDone: [] };
    }
    const current = live?.current_item_id ?? null;
    const marked = markDone(db, current === null ? [] : [current]);
    return { markedDone: [...marked, ...startNextAgenda(db, eventId, now, current)] };
  });
}

const DAY_MS = 86_400_000;

/** End of a pause "bis HH:MM": the next such time, so "bis 00:15" late in the evening is after midnight. A time just past stays in the past (and is rejected). */
export function pauseUntil(hhmm: string, now: number): number {
  const until = now - (now % 60_000) + (toMinutes(hhmm) - berlinNow(new Date(now)).minutes) * 60_000;
  return until <= now && until + DAY_MS - now <= 12 * 3_600_000 ? until + DAY_MS : until;
}

export type PauseRequest = {
  title: string;
  until: number;
  /** "close" finishes the current agenda item instead of interrupting it. */
  mode: "interrupt" | "close";
  /** A planned break this pause stands for; it counts as passed. */
  breakId?: number;
};

/** Pause starten: pause (or close) the current agenda item until `until`; replaces a running pause. */
export function startPause(db: Database, eventId: number, req: PauseRequest, now = Date.now()) {
  const title = req.title.trim().slice(0, 100) || "Pause";
  if (req.until <= now) throw new Error("Das Ende der Pause muss in der Zukunft liegen.");
  if (req.until - now > 12 * 3_600_000) throw new Error("Eine Pause darf höchstens 12 Stunden dauern.");
  step(db, eventId, now, (live) => {
    const brk = req.breakId === undefined ? null : getItem(db, req.breakId);
    if (req.breakId !== undefined && (brk?.event_id !== eventId || brk.kind !== "break" || brk.done))
      throw new Error("Diese Pause ist nicht mehr geplant.");
    const current = live?.current_item_id ?? null;
    const close = req.mode === "close" && current !== null;
    const elapsed = live ? live.elapsed_before + minutesSince(live.started_at, now) : 0;
    save(db, eventId, {
      current_item_id: close ? null : current,
      started_at: null,
      elapsed_before: close || current === null ? 0 : elapsed,
      pause_title: title,
      pause_started_at: live?.pause_started_at ?? now,
      pause_until: req.until,
    });
    return { markedDone: markDone(db, [...(close ? [current] : []), ...(brk ? [brk.id] : [])]) };
  });
}

/** Erledigt / Wieder öffnen for agenda items. Marking the paused item done drops it from the pause. */
export function setDone(db: Database, eventId: number, itemId: number, isDone: boolean, now = Date.now()) {
  step(db, eventId, now, (live) => {
    const it = getItem(db, itemId);
    if (it?.kind === "break") throw new Error("Pausen werden über „Pause starten“ begonnen.");
    db.run("UPDATE items SET done = ? WHERE id = ?", [isDone ? 1 : 0, itemId]);
    if (isDone && live?.pause_until != null && live.current_item_id === itemId)
      save(db, eventId, { ...live, current_item_id: null, elapsed_before: 0 });
    return { markedDone: [], restoreDone: [itemId, it?.done ?? 0] };
  });
}

/** Nichts läuft: the running entry counts as done, nothing new starts (e.g. in the evening); a pause ends. */
export function stopNow(db: Database, eventId: number, now = Date.now()) {
  step(db, eventId, now, (live) => {
    const current = live?.current_item_id ?? null;
    save(db, eventId, IDLE);
    return { markedDone: markDone(db, current === null ? [] : [current]) };
  });
}

/** Jetzt starten: jump to any agenda item and end a pause; the previous item counts as done unless it is resumed. */
export function startItem(db: Database, eventId: number, itemId: number, now = Date.now()) {
  step(db, eventId, now, (live) => {
    const it = getItem(db, itemId);
    if (it?.kind === "break") throw new Error("Pausen werden über „Pause starten“ begonnen.");
    const prev = live?.current_item_id ?? null;
    const resumed = prev === itemId;
    const marked = markDone(db, prev === null || resumed ? [] : [prev]);
    db.run("UPDATE items SET done = 0 WHERE id = ?", [itemId]);
    // Starting the paused item resumes it; starting the running one changes nothing.
    save(db, eventId, !resumed ? run(itemId, now) : live!.pause_until !== null ? run(itemId, now, live!.elapsed_before) : live!);
    return { markedDone: marked, restoreDone: [itemId, it?.done ?? 0] };
  });
}

/** Zurück: undo the last step. */
export function back(db: Database, eventId: number) {
  db.transaction(() => {
    const row = db.query<{ id: number; snapshot: string }, [number]>(
      "SELECT id, snapshot FROM live_history WHERE event_id = ? ORDER BY id DESC LIMIT 1").get(eventId);
    if (!row) return;
    const snap: Snapshot = JSON.parse(row.snapshot);
    if (snap.live) save(db, eventId, { ...IDLE, ...snap.live });
    else db.run("DELETE FROM live WHERE event_id = ?", [eventId]);
    for (const id of snap.markedDone) db.run("UPDATE items SET done = 0 WHERE id = ?", [id]);
    if (snap.restoreDone) db.run("UPDATE items SET done = ? WHERE id = ?", [snap.restoreDone[1], snap.restoreDone[0]]);
    db.run("DELETE FROM live_history WHERE id = ?", [row.id]);
    bump(db);
  })();
}

/** Clears live references to an item that is about to be deleted. */
export function forgetItem(db: Database, itemId: number) {
  db.run("UPDATE live SET current_item_id = NULL, started_at = NULL, elapsed_before = 0 WHERE current_item_id = ?", [itemId]);
}

/** The day the live state applies to: the running (or paused) item's day, otherwise today. */
export const liveDay = (items: { id: number; date: string }[], live: LiveInput | null, today: string) =>
  items.find((it) => it.id === live?.currentItemId)?.date ?? today;

/** Live state as schedule input for today; null when nothing runs or it was started on another day (daily reset). */
export function liveInput(db: Database, eventId: number, now = Date.now()): LiveInput | null {
  const live = getLive(db, eventId);
  const since = live?.started_at ?? live?.pause_started_at;
  if (!live || since == null || toEventTime(since).date !== eventNow(new Date(now)).date) return null;
  const pause =
    live.pause_started_at !== null && live.pause_until !== null
      ? (() => {
          const start = toEventTime(live.pause_started_at).minutes;
          return { title: live.pause_title ?? "Pause", start, until: start + Math.round((live.pause_until - live.pause_started_at) / 60_000), untilMs: live.pause_until };
        })()
      : null;
  return {
    currentItemId: live.current_item_id,
    startedAt: live.started_at === null ? null : toEventTime(live.started_at).minutes,
    elapsedBefore: live.elapsed_before,
    pause,
  };
}
