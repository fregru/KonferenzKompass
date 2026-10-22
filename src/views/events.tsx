import type { Database } from "bun:sqlite";
import { assetUrl } from "../assets";
import type { User } from "../auth";
import { subItemsFor, type Event, type ItemRow } from "../db";
import { CSV_COLUMNS, type ImportRow } from "../csv";
import { clashes } from "../plan";
import { bookings, floorsOf, mapPage, roomMap, roomsOf, roomStatus, venues, type Booking, type RoomStatus } from "../rooms";
import { shortDayLabel, type Change } from "../changelog";
import { addDays, berlinNow, dayLabel, daysBetween, duration, fmt } from "../time";
import { AdminPage } from "./admin";
import { Place, placeText, roomName } from "./map";
import { itemLabel } from "./labels";
import { Menu } from "./public";

const statusLabel = { draft: "Entwurf", active: "Aktiv", archived: "Archiviert" };

export function EventsPage({ db, user, events, error }: { db: Database; user: User; events: Event[]; error?: string }) {
  return (
    <AdminPage db={db} user={user} title="Veranstaltungen" error={error}>
      <table>
        <tr>
          <th>Name</th>
          <th>Beginn</th>
          <th>Status</th>
          <th></th>
        </tr>
        {events.map((e) => (
          <tr>
            <td>
              <a href={`/admin/events/${e.id}`}>{e.name}</a>
            </td>
            <td>{dayLabel(e.start_date)}</td>
            <td>{statusLabel[e.status]}</td>
            <td>
              {e.status === "draft" && (
                <form method="post" action={`/admin/events/${e.id}/activate`}>
                  <button class="secondary">Aktivieren</button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </table>
      <form method="post" action="/admin/events" class="card">
        <h2>Neue Veranstaltung</h2>
        <label>
          Name <input name="name" required />
        </label>
        <label>
          Erster Tag <input type="date" name="start_date" required />
        </label>
        <button>Anlegen</button>
      </form>
    </AdminPage>
  );
}

/** Days with entries; when editing, also the empty days in between (from the first day on), so entries can be dragged there. */
function planDays(event: Event, items: ItemRow[], readonly: boolean): string[] {
  const used = [...new Set(items.map((i) => i.date))];
  if (readonly || !used.length) return used;
  const sorted = [event.start_date, ...used].sort();
  const span = daysBetween(sorted[0]!, sorted.at(-1)!);
  return span > 31 ? used : Array.from({ length: span + 1 }, (_, i) => addDays(sorted[0]!, i));
}

export function ItemsPage({ db, user, event, items }: { db: Database; user: User; event: Event; items: ItemRow[] }) {
  const readonly = event.status === "archived";
  const days = planDays(event, items, readonly);
  const subs = subItemsFor(db, event.id);
  const rooms = roomMap(db, event.venue_id);
  const map = mapPage(db);
  return (
    <AdminPage db={db} user={user} title={`Zeitplan: ${event.name}`}>
      <div class="actions">
        {readonly ? (
          <p class="muted">Archiviert – nur lesbar.</p>
        ) : (
          <>
            <a class="btn" href={`/admin/events/${event.id}/items/new`}>+ Neuer Eintrag</a>
            <a class="btn secondary" href={`/admin/events/${event.id}/items/import`}>CSV importieren</a>
          </>
        )}
        {items.length > 0 && (
          <a class="btn secondary" href={`/admin/events/${event.id}/items/export.csv`}>CSV exportieren</a>
        )}
        {event.venue_id !== null && <a class="btn secondary" href={`/admin/events/${event.id}/rooms`}>Raumbelegung</a>}
        <a class="btn secondary" href={`/admin/events/${event.id}/changes`}>Änderungen</a>
      </div>
      {items.length === 0 && <p>Noch keine Einträge.</p>}
      {!readonly && items.length > 0 && (
        <p class="muted">
          Einträge mit <span class="tag">fest</span> behalten ihre Uhrzeit, alle anderen beginnen direkt nach dem vorherigen Eintrag. Zum
          Verschieben am Griff ziehen oder die Pfeile nutzen.
        </p>
      )}
      {days.map((d) => {
        const day = items.filter((i) => i.date === d);
        const clash = clashes(day);
        return (
          <section>
            <h2>{dayLabel(d)}</h2>
            <ol class="planlist card" data-sortable={readonly ? undefined : d}>
              {day.map((i, idx) => {
                const c = clash.get(i.id);
                return (
                  <li class={`planitem ${i.kind}${c ? " clash" : ""}`} data-id={String(i.id)}>
                    {!readonly && (
                      <span class="handle" title="Ziehen zum Verschieben" aria-hidden="true">
                        ⠿
                      </span>
                    )}
                    <span class="c-time">
                      {i.start}
                      <span class="end">–{i.end}</span>
                    </span>
                    <div class="body">
                      {readonly ? itemLabel(i) : <a href={`/admin/items/${i.id}`}>{itemLabel(i)}</a>}
                      {i.kind === "break" && <span class="muted"> (Pause)</span>}
                      {i.fixed ? <span class="tag">fest</span> : null}
                      {(i.location || i.room_id !== null) && (
                        <div class="sub">
                          <Place item={i} rooms={rooms} map={map} />
                        </div>
                      )}
                      <Menu item={i} />
                      {(subs.get(i.id) ?? []).length > 0 && (
                        <ul class="sublist">
                          {subs.get(i.id)!.map((s) => (
                            <li>
                              <span class="c-time">{s.start}–{s.end}</span>{" "}
                              {readonly ? itemLabel(s) : <a href={`/admin/items/${s.id}`}>{itemLabel(s)}</a>}
                              {(s.location || s.room_id !== null) && (
                                <span class="sub">
                                  {" · "}
                                  <Place item={s} rooms={rooms} map={map} />
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {c && (
                        <div class="clashnote">
                          Überschneidet sich um {c.minutes} min mit „{itemLabel(c.with)}“
                        </div>
                      )}
                    </div>
                    {!readonly && (
                      <div class="moves">
                        <form method="post" action={`/admin/items/${i.id}/move`}>
                          <input type="hidden" name="dir" value="up" />
                          <button class="secondary" disabled={idx === 0} aria-label={`${itemLabel(i)} nach oben`}>
                            ↑
                          </button>
                        </form>
                        <form method="post" action={`/admin/items/${i.id}/move`}>
                          <input type="hidden" name="dir" value="down" />
                          <button class="secondary" disabled={idx === day.length - 1} aria-label={`${itemLabel(i)} nach unten`}>
                            ↓
                          </button>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      {!readonly && <script src={assetUrl("vendor/sortable.js")} defer></script>}
    </AdminPage>
  );
}

export type ItemFields = Pick<
  ItemRow,
  "date" | "start" | "end" | "title" | "top_number" | "kind" | "location" | "description" | "responsible" | "show_responsible" | "fixed" | "room_id" | "menu"
>;

/** Room choice with each room's state for the entered time, grouped by floor, plus the overview table. */
function RoomPicker({ db, event, values, selfId }: { db: Database; event: Event; values: ItemFields; selfId?: number }) {
  if (event.venue_id === null)
    return (
      <p class="muted">
        Für Räume aus dem Lageplan der Veranstaltung zuerst einen <a href={`/admin/events/${event.id}`}>Ort zuweisen</a>.
      </p>
    );
  // Without a valid time there is nothing to check yet: rooms are listed without a state.
  const timed = !!values.end;
  const status: RoomStatus[] = timed
    ? roomStatus(db, event, values.date, values.start, values.end, selfId)
    : roomsOf(db, event.venue_id).map((room) => ({ room, conflicts: [] }));
  const floors = floorsOf(db, event.venue_id);
  const state = (s: RoomStatus) =>
    s.room.kind === "area" ? "Bereich" : s.conflicts.length ? `belegt: ${s.conflicts.map((b) => `${itemLabel(b.item)} (${b.item.start}–${b.item.end})`).join(", ")}` : "frei";
  const optionText = (s: RoomStatus) => (timed ? `${roomName(s.room)} – ${state(s)}` : roomName(s.room));
  const groups = [...floors.map((f) => ({ name: f.name, list: status.filter((s) => s.room.floor_id === f.id) })), { name: "Weitere Orte", list: status.filter((s) => s.room.floor_id === null) }].filter((g) => g.list.length);
  const free = status.filter((s) => s.room.kind === "room" && !s.conflicts.length).length;
  return (
    <>
      <label>
        Raum
        <select name="room_id">
          <option value="">– kein Raum aus dem Lageplan –</option>
          {groups.map((g) => (
            <optgroup label={g.name}>
              {g.list.map((s) => (
                <option value={String(s.room.id)} selected={s.room.id === values.room_id}>
                  {optionText(s)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {timed && status.length > 0 && (
        <details class="roomstatus">
          <summary>
            Raumübersicht {values.start}–{values.end}: {free} {free === 1 ? "Raum" : "Räume"} frei
          </summary>
          <table>
            {status.map((s) => (
              <tr class={s.conflicts.length ? "taken" : "free"}>
                <td>{roomName(s.room)}</td>
                <td>{state(s)}</td>
              </tr>
            ))}
          </table>
        </details>
      )}
      <button class="secondary" name="check" value="1" formnovalidate>
        Verfügbarkeit für die eingetragene Zeit prüfen
      </button>
    </>
  );
}

/**
 * `back`: the admin page the user came from (default: the event's schedule); saving and deleting return there.
 * `parent` makes it a sub-point form; `double` asks to confirm a double booking.
 */
export function ItemForm({ db, user, event, action, values, error, itemId, back, parent, double }: {
  db: Database; user: User; event: Event; action: string; values: ItemFields; error?: string; itemId?: number; back?: string;
  parent?: ItemRow; double?: boolean;
}) {
  const backField = back && <input type="hidden" name="back" value={back} />;
  const subs = itemId && !parent ? (subItemsFor(db, event.id).get(itemId) ?? []) : [];
  const rooms = roomMap(db, event.venue_id);
  const readonly = event.status === "archived";
  const title = parent ? (itemId ? "Unterpunkt bearbeiten" : "Neuer Unterpunkt") : itemId ? "Eintrag bearbeiten" : "Neuer Eintrag";
  return (
    <AdminPage db={db} user={user} title={title} error={error}>
      <p>
        {parent ? (
          <a href={back ?? `/admin/items/${parent.id}`}>← {itemLabel(parent)}</a>
        ) : (
          <a href={back ?? `/admin/events/${event.id}/items`}>
            {back === "/admin/live" ? "← Übersicht" : back ? "← Zurück" : `← Zeitplan ${event.name}`}
          </a>
        )}
      </p>
      <form method="post" action={action} class="card">
        {readonly && <p class="muted">Archiviert – nur lesbar.</p>}
        <fieldset class="bare" disabled={readonly}>
          {backField}
          {parent && (
            <p class="muted">
              Unterpunkt von <strong>{itemLabel(parent)}</strong> ({dayLabel(parent.date)}, {parent.start}–{parent.end}). Unterpunkte können parallel
              (z. B. Arbeitskreise in verschiedenen Räumen) oder nacheinander liegen und verschieben sich mit dem Eintrag.
            </p>
          )}
          <label>
            Titel <input name="title" value={values.title} required />
          </label>
          <div class="cols">
            {parent ? (
              <input type="hidden" name="date" value={parent.date} />
            ) : (
              <label>
                Datum <input type="date" name="date" value={values.date} required />
              </label>
            )}
            <label>
              Beginn <input type="time" name="start" value={values.start} required />
            </label>
            <label>
              Dauer (min) <input type="number" name="duration" value={values.start && values.end ? String(duration(values.start, values.end)) : ""} min="1" max="1440" required />
            </label>
          </div>
          {!parent && (
            <>
              <label>
                <input type="checkbox" name="fixed" value="1" checked={!!values.fixed} /> Feste Uhrzeit (z. B. Mittagessen)
              </label>
              <p class="muted">
                Ohne feste Uhrzeit beginnt der Eintrag direkt nach dem vorherigen; der Beginn zählt dann nur für den ersten Eintrag des Tages.
              </p>
            </>
          )}
          <div class="cols">
            {!parent && (
              <label>
                Art
                <select name="kind">
                  <option value="agenda" selected={values.kind === "agenda"}>TO-Punkt</option>
                  <option value="break" selected={values.kind === "break"}>Pause / Essen</option>
                </select>
              </label>
            )}
            <label>
              {parent ? "Nummer" : "TOP-Nummer"} <input name="top_number" value={values.top_number} placeholder={parent ? "z. B. 3.1" : "z. B. TOP 3"} />
            </label>
          </div>
          {!parent && (
            <label class="menufield">
              Essen (nur bei Pause / Essen, ein Gericht pro Zeile)
              <textarea name="menu" rows={3} placeholder={"z. B. Spaghetti mit Linsenbolognese\nDessert: Schokopudding"}>
                {values.menu}
              </textarea>
              <span class="muted">Leer lassen, wenn nichts angezeigt werden soll.</span>
            </label>
          )}
          <RoomPicker db={db} event={event} values={values} selfId={itemId} />
          <label>
            {values.room_id !== null ? "Ergänzung zum Ort" : "Ort (frei, z. B. Wiese)"} <input name="location" value={values.location} />
          </label>
          <label>
            Beschreibung (Markdown) <textarea name="description" rows={4}>{values.description}</textarea>
          </label>
          <label>
            Zuständig <input name="responsible" value={values.responsible} />
          </label>
          <label>
            <input type="checkbox" name="show_responsible" value="1" checked={!!values.show_responsible} /> Zuständigkeit öffentlich anzeigen
          </label>
          {double && (
            <label>
              <input type="checkbox" name="double" value="1" /> Trotzdem speichern – der Raum ist dann doppelt belegt
            </label>
          )}
          {!readonly && <button>Speichern</button>}
        </fieldset>
      </form>
      {itemId && !parent && (
        <section class="card">
          <h2>Unterpunkte</h2>
          {subs.length === 0 && <p class="muted">Z. B. parallele Arbeitskreise in verschiedenen Räumen oder einzelne Abschnitte nacheinander.</p>}
          {subs.length > 0 && (
            <table class="fixed">
              {subs.map((s) => (
                <tr>
                  <td class="c-time">
                    {s.start}
                    <span class="end">–{s.end}</span>
                  </td>
                  <td>
                    {readonly ? itemLabel(s) : <a href={`/admin/items/${s.id}`}>{itemLabel(s)}</a>}
                    {(s.room_id !== null || s.location) && <div class="sub">{placeText(s, rooms)}</div>}
                  </td>
                </tr>
              ))}
            </table>
          )}
          {!readonly && (
            <p>
              <a class="btn secondary" href={`/admin/items/${itemId}/subs/new`}>+ Unterpunkt</a>
            </p>
          )}
        </section>
      )}
      {itemId && !readonly && (
        <form method="post" action={`/admin/items/${itemId}/delete`} class="card">
          {backField}
          <label>
            <input type="checkbox" name="confirm" value="1" required /> Ja, diesen Eintrag{subs.length ? " mit seinen Unterpunkten" : ""} löschen
          </label>
          <button class="danger">Löschen</button>
        </form>
      )}
    </AdminPage>
  );
}

export function EventDetail({ db, user, event, error }: { db: Database; user: User; event: Event; error?: string }) {
  const archived = event.status === "archived";
  return (
    <AdminPage db={db} user={user} title={event.name} error={error}>
      <p>
        <a href="/admin/events">← Alle Veranstaltungen</a>
      </p>
      <p>
        Status: <strong>{statusLabel[event.status]}</strong> · Erster Tag: {dayLabel(event.start_date)}
      </p>
      {!archived && (
        <form method="post" action={`/admin/events/${event.id}`} class="card">
          <h2>Name und Datum</h2>
          <div class="cols">
            <label>
              Name <input name="name" value={event.name} required />
            </label>
            <label>
              Erster Tag <input type="date" name="start_date" value={event.start_date} required />
            </label>
          </div>
          <p class="muted">Ein neuer erster Tag verschiebt alle Einträge im Zeitplan um ebenso viele Tage.</p>
          <button>Speichern</button>
        </form>
      )}
      <p class="links">
        <a class="btn secondary" href={`/admin/events/${event.id}/items`}>Zeitplan</a>
        <a class="btn secondary" href={`/admin/events/${event.id}/intro`}>Einführung & FAQ</a>
        <a class="btn secondary" href={`/admin/events/${event.id}/contacts`}>Kontakte</a>
        <a class="btn secondary" href={`/admin/sicherung?event=${event.id}`}>Exportieren</a>
      </p>
      <form method="post" action={`/admin/events/${event.id}/venue`} class="card">
        <h2>Ort / Lageplan</h2>
        <label>
          Räume im Zeitplan kommen aus diesem Ort
          <select name="venue_id" disabled={archived}>
            <option value="">– kein Ort –</option>
            {venues(db).map((v) => (
              <option value={String(v.id)} selected={v.id === event.venue_id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <p class="muted">
          Beim Wechsel bleiben bisher zugeordnete Räume als Text im Feld „Ort“ erhalten. Orte und Räume werden unter <a href="/admin/venues">Lageplan</a>{" "}
          gepflegt.
        </p>
        {!archived && <button>Speichern</button>}
      </form>
      {!archived && (
        <div class="links">
          {event.status === "draft" && (
            <form method="post" action={`/admin/events/${event.id}/activate`}>
              <button>Aktivieren (öffentlich anzeigen)</button>
            </form>
          )}
          <form method="post" action={`/admin/events/${event.id}/archive`}>
            <button class="secondary">Archivieren</button>
          </form>
        </div>
      )}
      <form method="post" action={`/admin/events/${event.id}/copy`} class="card">
        <h2>Kopieren</h2>
        <p class="muted">Zeitplan (auf neue Daten verschoben), Einführung, FAQ, Kontakte und Links werden übernommen.</p>
        <label>
          Name <input name="name" value={`${event.name} (Kopie)`} required />
        </label>
        <label>
          Erster Tag <input type="date" name="start_date" required />
        </label>
        <button>Kopie anlegen</button>
      </form>
      <form method="post" action={`/admin/events/${event.id}/delete`} class="card">
        <h2>Löschen</h2>
        <label>
          <input type="checkbox" name="confirm" value="1" required /> Ja, diese Veranstaltung mit Zeitplan, FAQ und Kontakten
          endgültig löschen
        </label>
        <button class="danger">Löschen</button>
      </form>
    </AdminPage>
  );
}

/** Upload form, then a preview of the parsed rows; importing replaces the whole schedule. */
export function ImportPage({ db, user, event, existing, text, rows, errors, error }: {
  db: Database; user: User; event: Event; existing: number; text?: string; rows?: ImportRow[]; errors?: string[]; error?: string;
}) {
  const action = `/admin/events/${event.id}/items/import`;
  return (
    <AdminPage db={db} user={user} title="Zeitplan importieren" error={error}>
      <p>
        <a href={`/admin/events/${event.id}/items`}>← Zeitplan {event.name}</a>
      </p>
      <form method="post" action={action} enctype="multipart/form-data" class="card">
        <p>
          CSV-Datei mit den Spalten <code>{CSV_COLUMNS.join(";")}</code>, eine Zeile pro Eintrag in der gewünschten Reihenfolge. Einträge mit{" "}
          <strong>Beginn</strong> bekommen eine feste Uhrzeit, alle anderen folgen direkt auf den vorherigen Eintrag – der erste Eintrag eines Tages
          braucht deshalb einen Beginn. Die Dauer in Minuten (z. B. <code>45</code> oder <code>1:30</code>). Art „Pause“ für Pausen. <strong>Raum</strong>: Name oder Kurzname eines Raums aus dem Lageplan der Veranstaltung (sonst wird er als Ort übernommen). <strong>Unterpunkt</strong> „x“: gehört zum Haupteintrag darüber und beginnt ohne Beginn mit ihm. Tipp: Den
          aktuellen Zeitplan als CSV exportieren und als Vorlage nutzen.
        </p>
        <label>
          CSV-Datei <input type="file" name="csv" accept=".csv,text/csv" required />
        </label>
        <button class="secondary">Vorschau anzeigen</button>
      </form>
      {errors && errors.length > 0 && (
        <section class="card">
          <h2>Fehler in der Datei</h2>
          <ul class="error">
            {errors.map((e) => (
              <li>{e}</li>
            ))}
          </ul>
          <p>Bitte die Datei korrigieren und erneut hochladen.</p>
        </section>
      )}
      {rows && rows.length > 0 && (
        <section class="card">
          <h2>Vorschau: {rows.length} Einträge</h2>
          <div class="preview">
            <table>
              <tr>
                <th>Datum</th>
                <th>Beginn</th>
                <th>Dauer</th>
                <th>Titel</th>
                <th>Art</th>
                <th>Raum / Ort</th>
              </tr>
              {rows.map((r) => (
                <tr class={r.kind}>
                  <td>{dayLabel(r.date)}</td>
                  <td>{r.sub ? (r.start ?? "mit Haupteintrag") : r.start ? `${r.start} (fest)` : "folgt"}</td>
                  <td>{r.minutes} min</td>
                  <td>{r.sub && "↳ "}{itemLabel(r)}</td>
                  <td>{r.sub ? "Unterpunkt" : r.kind === "break" ? "Pause" : "TO-Punkt"}</td>
                  <td>{[r.room, r.location].filter(Boolean).join(", ")}</td>
                </tr>
              ))}
            </table>
          </div>
          {!errors?.length && (
            <form method="post" action={action}>
              <input type="hidden" name="text" value={text} />
              <input type="hidden" name="confirm" value="1" />
              {existing > 0 && (
                <label>
                  <input type="checkbox" name="replace" value="1" required /> Die {existing} vorhandenen Einträge werden ersetzt.
                </label>
              )}
              <button>Importieren</button>
            </form>
          )}
        </section>
      )}
    </AdminPage>
  );
}

/** Rooms × time for one whole day (0–24 Uhr): which rooms are used when, double bookings in red. */
export function OccupancyPage({ db, user, event, days, date }: { db: Database; user: User; event: Event; days: string[]; date: string }) {
  const rooms = event.venue_id === null ? [] : roomsOf(db, event.venue_id);
  const booked = bookings(db, event.id, date);
  const span = 24;
  const pct = (m: number) => `${(Math.min(m, 1440) / 1440) * 100}%`;
  // A label per hour; none at 24, where it would not fit.
  const hours = Array.from({ length: span }, (_, i) => i * 60);
  const base = `/admin/events/${event.id}/rooms`;
  const link = (d: string) => `${base}?date=${d}`;
  return (
    <AdminPage db={db} user={user} title={`Raumbelegung: ${event.name}`}>
      <p>
        <a href={`/admin/events/${event.id}/items`}>← Zeitplan {event.name}</a>
      </p>
      {days.length > 1 && (
        <nav class="links" aria-label="Tage">
          {days.map((d) => (
            <a class={`btn${d === date ? " primary" : " secondary"}`} href={link(d)} aria-current={d === date ? "page" : undefined}>
              {dayLabel(d)}
            </a>
          ))}
        </nav>
      )}
      {rooms.length === 0 ? (
        <p>
          Der Veranstaltung ist noch kein Ort mit Räumen zugewiesen. <a href={`/admin/events/${event.id}`}>Ort wählen</a>
        </p>
      ) : (
        <>
          <div class="preview">
            <table class="occupancy" style={`--hours:${span}`}>
              <tr>
                <th>{dayLabel(date)}</th>
                <th>
                  <div class="track hours">
                    {hours.map((h, i) => (
                      <span class={i === 0 ? "first" : undefined} style={`left:${pct(h)}`}>
                        {fmt(h).slice(0, 2)}
                      </span>
                    ))}
                  </div>
                </th>
              </tr>
              {rooms.map((r) => {
                const list = booked.get(r.id) ?? [];
                const clash = (b: Booking) => r.kind === "room" && list.some((o) => o !== b && o.start < b.end && b.start < o.end);
                return (
                  <tr>
                    <td>
                      {roomName(r)}
                      {r.kind === "area" && <span class="muted"> (Bereich)</span>}
                    </td>
                    <td>
                      <div class="track">
                        {list.map((b) => (
                          <a
                            class={`slot${clash(b) ? " clash" : ""}`}
                            style={`left:${pct(b.start)};width:${pct(Math.min(b.end, 1440) - b.start)}`}
                            href={`/admin/items/${b.item.id}?back=${encodeURIComponent(link(date))}`}
                            title={`${fmt(b.start)}–${fmt(b.end)} ${itemLabel(b.item)}`}
                          >
                            {itemLabel(b.item)}
                          </a>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </table>
          </div>
        </>
      )}
      <p class="muted">Rot: Raum doppelt belegt. Bereiche gelten nie als belegt.</p>
    </AdminPage>
  );
}

/** Ids of the event's entries that still exist, so log lines only link to entries that can be opened. */
const existingItems = (db: Database, eventId: number) =>
  new Set(db.query<{ id: number }, [number]>("SELECT id FROM items WHERE event_id = ?").all(eventId).map((r) => r.id));

/** Log lines: time (with day if not today), who, what; the text links to the entry while it exists. */
export function ChangeList({ db, changes, back }: { db: Database; changes: Change[]; back?: string }) {
  if (changes.length === 0) return null;
  const items = existingItems(db, changes[0]!.event_id);
  const today = berlinNow().date;
  return (
    <ul class="changes">
      {changes.map((ch) => {
        const t = berlinNow(new Date(ch.at));
        return (
          <li>
            <span class="muted">
              {t.date === today ? "" : `${shortDayLabel(t.date)} `}
              {fmt(t.minutes)} · {ch.username}
            </span>{" "}
            {ch.item_id !== null && items.has(ch.item_id) ? (
              <a href={`/admin/items/${ch.item_id}${back ? `?back=${back}` : ""}`}>{ch.text}</a>
            ) : (
              ch.text
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ChangesPage({ db, user, event, changes }: { db: Database; user: User; event: Event; changes: Change[] }) {
  const items = existingItems(db, event.id);
  const days = [...new Set(changes.map((ch) => berlinNow(new Date(ch.at)).date))];
  return (
    <AdminPage db={db} user={user} title={`Änderungen: ${event.name}`}>
      <p>
        <a href={`/admin/events/${event.id}/items`}>← Zeitplan {event.name}</a>
      </p>
      {changes.length === 0 && <p>Noch keine Änderungen.</p>}
      {days.map((d) => (
        <section>
          <h2>{dayLabel(d)}</h2>
          <table class="changelog">
            {changes
              .filter((ch) => berlinNow(new Date(ch.at)).date === d)
              .map((ch) => (
                <tr>
                  <td class="c-time">{fmt(berlinNow(new Date(ch.at)).minutes)}</td>
                  <td>{ch.username}</td>
                  <td>{ch.item_id !== null && items.has(ch.item_id) ? <a href={`/admin/items/${ch.item_id}`}>{ch.text}</a> : ch.text}</td>
                </tr>
              ))}
          </table>
        </section>
      ))}
    </AdminPage>
  );
}
