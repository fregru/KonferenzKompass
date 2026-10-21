import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth";
import { activeEvent, bump, getSetting, itemsForEvent, setSetting, type Event, type ItemRow } from "../db";
import { back, liveDay, liveInput, next, pauseUntil, setDone, startItem, startPause, stopNow, type PauseRequest } from "../live";
import { computeDay, type Row } from "../schedule";
import { dayLabel, duration, eventNow, fmt } from "../time";
import { AdminPage } from "../views/admin";
import { itemLabel } from "../views/labels";
import { Menu, PauseTimer } from "../views/public";
import { form, requirePerm } from "./util";

/** Name plus either a duration or an end time ("bis" wins when filled in). */
function PauseFields({ title, minutes }: { title: string; minutes: number }) {
  return (
    <>
      <label class="full">
        Name <input name="title" value={title} maxlength={100} />
      </label>
      <label>
        Dauer (min) <input type="number" name="minutes" value={String(minutes)} min="1" max="720" />
      </label>
      <label>
        oder bis <input type="time" name="until" />
      </label>
    </>
  );
}

function LivePage({ db, c, event, error }: { db: Database; c: Context<AppEnv>; event: Event | null; error?: string }) {
  const user = c.get("user");
  if (!event)
    return (
      <AdminPage db={db} user={user} title="Übersicht">
        <p>Es ist keine Veranstaltung aktiv.</p>
      </AdminPage>
    );
  const now = eventNow();
  const input = liveInput(db, event.id);
  const pause = input?.pause ?? null;
  const all = itemsForEvent(db, event.id);
  const byId = new Map(all.map((i) => [i.id, i]));
  // Whole event, one block per day; the live state applies to the running item's day (usually today).
  const active = liveDay(all, input, now.date);
  const days = [...new Set(all.map((i) => i.date))].map((d) => ({
    date: d,
    rows: computeDay(all.filter((i) => i.date === d).map((i) => ({ ...i, done: !!i.done })), d === active ? input : null, now.minutes),
  }));
  const rows = days.find((d) => d.date === active)?.rows ?? [];
  const current = rows.find((r) => r.status === "current");
  const interrupted = rows.find((r) => r.status === "interrupted");
  const hasItem = !!(current || interrupted);
  const upcoming = rows.filter((r) => r.status === "upcoming" || r.status === "interrupted").slice(0, 3);
  const pauseOver = !!pause && now.minutes > pause.until;
  const showNext = getSetting(db, "show_next") !== "0";
  /** Buttons for an entry: breaks get "Pause starten…", agenda items Erledigt / Jetzt starten. */
  const rowActions = (it: ItemRow, status: Row["status"]) =>
    it.kind === "break" ? (
      status === "done" ? (
        <span class="muted">vorbei</span>
      ) : (
        <details class="breakstart">
          <summary>Pause starten…</summary>
          <form method="post" action="/admin/live/pause" class="pauseform">
            <input type="hidden" name="break" value={String(it.id)} />
            <PauseFields title={it.title} minutes={duration(it.start, it.end)} />
            <button class="full" name="mode" value="interrupt">
              {hasItem ? "TOP unterbrechen" : "Pause starten"}
            </button>
            {hasItem && (
              <button class="full secondary" name="mode" value="close">
                TOP abschließen & Pause
              </button>
            )}
          </form>
        </details>
      )
    ) : (
      status !== "current" && (
        <div class="rowactions">
          <form method="post" action={`/admin/live/done/${it.id}`}>
            <input type="hidden" name="done" value={status === "done" ? "0" : "1"} />
            <button class="secondary">{status === "done" ? "TOP öffnen" : "Erledigt"}</button>
          </form>
          <form method="post" action={`/admin/live/start/${it.id}`}>
            <button class="secondary">{status === "interrupted" ? "Fortsetzen" : "Jetzt starten"}</button>
          </form>
        </div>
      )
    );
  return (
    <AdminPage db={db} user={user} title="Übersicht" error={error}>
      <p class="muted">
        {event.name} · {dayLabel(now.date)} · {fmt(now.minutes)} Uhr
      </p>
      <div class="livegrid">
        <div class="livecontrol">
          <section class={`card now${current?.overrun || pauseOver ? " over" : ""}`}>
            {pause ? (
              <>
                <div class="nowhead">
                  <div>
                    <div class="eyebrow">Pause seit {fmt(pause.start)}</div>
                    <h3>{pause.title}</h3>
                    {pauseOver ? (
                      <div class="status">überzogen – geplant bis {fmt(pause.until)}</div>
                    ) : (
                      <div class="meta">bis {fmt(pause.until)}</div>
                    )}
                  </div>
                  <PauseTimer untilMs={pause.untilMs} nowMs={Date.now()} />
                </div>
                {interrupted && <div class="meta">Unterbrochen: {itemLabel(byId.get(interrupted.id)!)}</div>}
              </>
            ) : current ? (
              <>
                <div class="eyebrow">
                  Läuft seit {fmt(current.expectedStart)} · {Math.max(0, now.minutes - current.expectedStart) + (input?.elapsedBefore ?? 0)} min
                </div>
                <h3>
                  <a href={`/admin/items/${current.id}?back=/admin/live`}>{itemLabel(byId.get(current.id)!)}</a>
                </h3>
                {current.overrun ? <div class="status">überzogen</div> : <div class="meta">Ende ca. {fmt(current.expectedEnd)}</div>}
              </>
            ) : (
              <p class="meta">Gerade läuft nichts.</p>
            )}
          </section>
          <div class="sticky">
            <div class="controls">
              <form method="post" action="/admin/live/next" class="wide">
                <button>{interrupted ? "Weiter (fortsetzen)" : "Weiter"}</button>
              </form>
              <form method="post" action="/admin/live/back">
                <button class="secondary">Zurück</button>
              </form>
              <form method="post" action="/admin/live/stop">
                <button class="secondary">Nichts läuft</button>
              </form>
            </div>
          </div>
          <form method="post" action="/admin/live/pause" class="card pauseform">
            <PauseFields title="Pause" minutes={15} />
            <button class="full secondary">{pause ? "Pause ändern" : hasItem ? "Pause starten (TOP unterbrechen)" : "Pause starten"}</button>
          </form>
          <form method="post" action="/admin/live/show-next" class="card toggle">
            <input type="hidden" name="show_next" value={showNext ? "0" : "1"} />
            <span>
              Nächster Programmpunkt auf der Startseite: <strong>{showNext ? "sichtbar" : "ausgeblendet"}</strong>
            </span>
            <button class="secondary">{showNext ? "Ausblenden" : "Anzeigen"}</button>
          </form>
          {upcoming.length > 0 && (
            <section class="card">
              <h2>Als Nächstes</h2>
              <ul>
                {upcoming.map((r) => (
                  <li>
                    {fmt(r.expectedStart)} {itemLabel(byId.get(r.id)!)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div class="liveplan">
          <section class="card">
            <h2>Zeitplan</h2>
            {all.length === 0 && <p>Für diese Veranstaltung stehen keine Einträge im Zeitplan.</p>}
            <div class="planscroll">
              <table class="fixed">
                {days.map(({ date, rows }) => {
                  const isToday = date === now.date;
                  return (
                    <>
                      <tr class={`daysep${isToday ? " today" : ""}`} id={isToday ? "today" : undefined}>
                        <th colspan={3}>{isToday ? `Heute · ${dayLabel(date)}` : dayLabel(date)}</th>
                      </tr>
                      {rows.map((r) => {
                        const it = byId.get(r.id)!;
                        return (
                          <tr class={`${r.status} ${it.kind}`}>
                            <td class="c-time">{fmt(r.expectedStart)}</td>
                            <td>
                              <a href={`/admin/items/${it.id}?back=/admin/live`}>{itemLabel(it)}</a>
                              {it.kind === "break" && <span class="muted"> (Pause)</span>}
                              <Menu item={it} />
                            </td>
                            <td class="c-actions">{rowActions(it, r.status)}</td>
                          </tr>
                        );
                      })}
                    </>
                  );
                })}
              </table>
            </div>
            <p>
              <a href={`/admin/events/${event.id}/items`}>Zeitplan bearbeiten</a>
            </p>
          </section>
        </div>
      </div>
    </AdminPage>
  );
}

/** Reads the pause form: "bis HH:MM" wins over the duration in minutes. */
async function pauseRequest(c: Context<AppEnv>, now: number): Promise<PauseRequest> {
  const f = await form(c);
  const until = f.str("until");
  let untilMs: number;
  if (/^\d{2}:\d{2}$/.test(until)) untilMs = pauseUntil(until, now);
  else {
    const minutes = Number(f.str("minutes"));
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) throw new Error("Die Dauer muss zwischen 1 und 720 Minuten liegen.");
    untilMs = now + minutes * 60_000;
  }
  const breakId = f.str("break");
  return { title: f.str("title"), until: untilMs, mode: f.str("mode") === "close" ? "close" : "interrupt", breakId: breakId ? Number(breakId) : undefined };
}

export function liveRoutes(db: Database) {
  const r = new Hono<AppEnv>();
  r.use("/live", requirePerm(db, "schedule"));
  r.use("/live/*", requirePerm(db, "schedule"));

  r.get("/live", (c) => c.html(<LivePage db={db} c={c} event={activeEvent(db)} />));

  const act = (fn: (c: Context<AppEnv>, eventId: number) => void | Promise<void>) => async (c: Context<AppEnv>) => {
    const ev = activeEvent(db);
    if (!ev) return c.redirect("/admin/live");
    try {
      await fn(c, ev.id);
    } catch (e) {
      return c.html(<LivePage db={db} c={c} event={ev} error={(e as Error).message} />, 400);
    }
    return c.redirect("/admin/live");
  };

  r.post("/live/next", act((_, id) => next(db, id)));
  r.post("/live/pause", act(async (c, id) => {
    const now = Date.now();
    startPause(db, id, await pauseRequest(c, now), now);
  }));
  r.post("/live/back", act((_, id) => back(db, id)));
  r.post("/live/stop", act((_, id) => stopNow(db, id)));
  r.post("/live/show-next", act(async (c) => {
    setSetting(db, "show_next", (await form(c)).str("show_next") === "0" ? "0" : "1");
    bump(db);
  }));
  const eventItem = (c: Context<AppEnv>, eventId: number) => {
    const itemId = Number(c.req.param("item"));
    if (!db.query("SELECT 1 FROM items WHERE id = ? AND event_id = ?").get(itemId, eventId)) throw new Error("Eintrag nicht gefunden.");
    return itemId;
  };
  r.post("/live/start/:item", act((c, id) => startItem(db, id, eventItem(c, id))));
  r.post("/live/done/:item", act(async (c, id) => setDone(db, id, eventItem(c, id), (await form(c)).str("done") === "1")));

  return r;
}
