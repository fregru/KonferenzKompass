import type { Database } from "bun:sqlite";
import { raw } from "hono/html";
import { assetUrl } from "../assets";
import type { User } from "../auth";
import type { Event } from "../db";
import { floorsOf, roomsOf, venues, type Floor, type Room, type Venue } from "../rooms";
import { AdminPage } from "./admin";
import { FloorPlan, roomName } from "./map";

const KIND = { room: "Raum", area: "Bereich" };
const usedBy = (db: Database, venueId: number) =>
  db.query<Pick<Event, "id" | "name">, [number]>("SELECT id, name FROM events WHERE venue_id = ? ORDER BY start_date DESC").all(venueId);

export function VenuesPage({ db, user, error }: { db: Database; user: User; error?: string }) {
  const list = venues(db);
  return (
    <AdminPage db={db} user={user} title="Lageplan" error={error}>
      <p class="muted">
        Ein Ort (z. B. ein Tagungshaus) hat Etagen mit Grundriss und Räumen. Jede Veranstaltung wählt ihren Ort; die öffentliche Seite zeigt den Ort
        der aktiven Veranstaltung.
      </p>
      {list.length > 0 && (
        <table>
          <tr>
            <th>Ort</th>
            <th>Etagen</th>
            <th>Räume</th>
            <th>Genutzt von</th>
          </tr>
          {list.map((v) => (
            <tr>
              <td>
                <a href={`/admin/venues/${v.id}`}>{v.name}</a>
              </td>
              <td>{floorsOf(db, v.id).length}</td>
              <td>{roomsOf(db, v.id).length}</td>
              <td>{usedBy(db, v.id).map((e) => e.name).join(", ") || "–"}</td>
            </tr>
          ))}
        </table>
      )}
      <form method="post" action="/admin/venues" class="card">
        <h2>Neuer Ort</h2>
        <label>
          Name <input name="name" placeholder="z. B. Jugendhaus Altenberg" required />
        </label>
        <button>Anlegen</button>
      </form>
      <ImportForm list={list} />
    </AdminPage>
  );
}

function ImportForm({ list }: { list: Venue[] }) {
  return (
    <form method="post" action="/admin/venues/import" enctype="multipart/form-data" class="card">
      <h2>Importieren</h2>
      <p class="muted">Eine zuvor exportierte Lageplan-Datei (JSON, mit Grundrissen und Räumen).</p>
      <label>
        Datei <input type="file" name="file" accept=".json,application/json" required />
      </label>
      <label>
        Ziel
        <select name="target">
          <option value="">Als neuen Ort anlegen</option>
          {list.map((v) => (
            <option value={String(v.id)}>„{v.name}“ ersetzen</option>
          ))}
        </select>
      </label>
      <p class="muted">
        Beim Ersetzen bleiben Räume mit gleichem Namen im Zeitplan verknüpft; Etagen und alle anderen Räume werden durch die Datei ersetzt.
      </p>
      <button>Importieren</button>
    </form>
  );
}

export function VenueEdit({ db, user, venue, error }: { db: Database; user: User; venue: Venue; error?: string }) {
  const floors = floorsOf(db, venue.id);
  const rooms = roomsOf(db, venue.id);
  const events = usedBy(db, venue.id);
  return (
    <AdminPage db={db} user={user} title={`Ort: ${venue.name}`} error={error}>
      <p>
        <a href="/admin/venues">← Alle Orte</a>
      </p>
      <div class="actions">
        <a class="btn secondary" href={`/admin/venues/${venue.id}/export.json`}>Exportieren (JSON)</a>
      </div>
      <form method="post" action={`/admin/venues/${venue.id}`} class="card">
        <label>
          Name <input name="name" value={venue.name} required />
        </label>
        <label>
          Reihenfolge <input type="number" name="sort" value={String(venue.sort)} />
        </label>
        <button>Speichern</button>
      </form>

      <section class="card">
        <h2>Etagen</h2>
        {floors.length === 0 && <p class="muted">Noch keine Etagen. Lege zuerst eine Etage mit Grundriss (SVG) an.</p>}
        {floors.map((f) => (
          <div class="floorrow">
          <form method="post" action={`/admin/floors/${f.id}`} enctype="multipart/form-data">
            <div class="cols">
              <label>
                Name <input name="name" value={f.name} required />
              </label>
              <label>
                Reihenfolge <input type="number" name="sort" value={String(f.sort)} />
              </label>
              <label>
                {f.image ? "Grundriss ersetzen" : "Grundriss"} <input type="file" name="image" accept=".svg,.png,.jpg,.jpeg,.webp" />
              </label>
            </div>
            <div class="links">
              <button class="secondary">Speichern</button>
              <a class="btn primary" href={`/admin/floors/${f.id}/draw`}>
                Räume einzeichnen ({rooms.filter((r) => r.floor_id === f.id).length})
              </a>
            </div>
          </form>
          <details class="floordelete">
            <summary>Etage löschen</summary>
            <form method="post" action={`/admin/floors/${f.id}/delete`}>
              <label>
                <input type="checkbox" name="confirm" value="1" required /> Ja, „{f.name}“ löschen (die Räume bleiben, ihr Umriss wird entfernt)
              </label>
              <button class="danger">Etage löschen</button>
            </form>
          </details>
          </div>
        ))}
        <form method="post" action={`/admin/venues/${venue.id}/floors`} enctype="multipart/form-data">
          <h3>Neue Etage</h3>
          <div class="cols">
            <label>
              Name <input name="name" placeholder="z. B. Erdgeschoss" required />
            </label>
            <label>
              Grundriss (SVG, PNG, JPG; höchstens 10 MB) <input type="file" name="image" accept=".svg,.png,.jpg,.jpeg,.webp" />
            </label>
          </div>
          <button>Etage anlegen</button>
        </form>
      </section>

      <section class="card">
        <h2>Räume und Bereiche</h2>
        <p class="muted">Bereiche (z. B. Foyer, Wiese) erscheinen im Plan und lassen sich zuordnen, gelten aber nie als belegt.</p>
        {rooms.length > 0 && (
          <div class="preview">
            <table>
              <tr>
                <th>Name</th>
                <th>Etage</th>
                <th>Art</th>
                <th>Umriss</th>
              </tr>
              {rooms.map((r) => (
                <tr>
                  <td>
                    <a href={`/admin/rooms/${r.id}`}>{roomName(r)}</a>
                  </td>
                  <td>{floors.find((f) => f.id === r.floor_id)?.name ?? "–"}</td>
                  <td>{KIND[r.kind]}</td>
                  <td>{r.shape ? "eingezeichnet" : r.floor_id === null ? "–" : <span class="muted">fehlt</span>}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
        <form method="post" action={`/admin/venues/${venue.id}/rooms`}>
          <h3>Neuer Raum</h3>
          <RoomFields floors={floors} />
          <button>Raum anlegen</button>
        </form>
      </section>

      <form method="post" action={`/admin/venues/${venue.id}/delete`} class="card">
        <h2>Löschen</h2>
        {events.length > 0 && <p class="muted">Genutzt von: {events.map((e) => e.name).join(", ")}. Die Einträge behalten den Raumnamen als Ort.</p>}
        <label>
          <input type="checkbox" name="confirm" value="1" required /> Ja, diesen Ort mit allen Etagen und Räumen löschen
        </label>
        <button class="danger">Löschen</button>
      </form>
    </AdminPage>
  );
}

function RoomFields({ floors, room, floorId }: { floors: Floor[]; room?: Room; floorId?: number | null }) {
  const selected = room?.floor_id ?? floorId ?? floors[0]?.id ?? null;
  return (
    <>
      <div class="cols">
        <label>
          Name <input name="name" value={room?.name ?? ""} required />
        </label>
        <label>
          Kurzname <input name="short" value={room?.short ?? ""} placeholder="z. B. S2" />
        </label>
      </div>
      <div class="cols">
        <label>
          Etage
          <select name="floor_id">
            {floors.map((f) => (
              <option value={String(f.id)} selected={f.id === selected}>
                {f.name}
              </option>
            ))}
            <option value="" selected={selected === null}>
              Ohne Etage (außerhalb)
            </option>
          </select>
        </label>
        <label>
          Art
          <select name="kind">
            <option value="room" selected={room?.kind !== "area"}>Raum (wird belegt)</option>
            <option value="area" selected={room?.kind === "area"}>Bereich (nie belegt)</option>
          </select>
        </label>
        <label>
          Reihenfolge <input type="number" name="sort" value={String(room?.sort ?? 0)} />
        </label>
      </div>
      <label>
        Beschreibung (Markdown, z. B. Weg dorthin, Ausstattung) <textarea name="description" rows={3}>{room?.description ?? ""}</textarea>
      </label>
    </>
  );
}

export function RoomEdit({ db, user, room, error }: { db: Database; user: User; room: Room; error?: string }) {
  const floors = floorsOf(db, room.venue_id);
  return (
    <AdminPage db={db} user={user} title={`Raum: ${room.name}`} error={error}>
      <p>
        <a href={`/admin/venues/${room.venue_id}`}>← Zurück zum Ort</a>
        {room.floor_id !== null && (
          <>
            {" · "}
            <a href={`/admin/floors/${room.floor_id}/draw?raum=${room.id}`}>Im Plan einzeichnen</a>
          </>
        )}
      </p>
      <form method="post" action={`/admin/rooms/${room.id}`} class="card">
        <RoomFields floors={floors} room={room} />
        <details>
          <summary>Umriss als Koordinaten</summary>
          <label>
            Punkte in Prozent des Grundrisses, z. B. <code>[[10,10],[30,10],[30,25],[10,25]]</code>; leer = nicht eingezeichnet
            <textarea name="shape" rows={3}>{room.shape}</textarea>
          </label>
        </details>
        <button>Speichern</button>
      </form>
      <form method="post" action={`/admin/rooms/${room.id}/delete`} class="card">
        <label>
          <input type="checkbox" name="confirm" value="1" required /> Ja, diesen Raum löschen (Zeitplan-Einträge behalten den Namen als Ort)
        </label>
        <button class="danger">Löschen</button>
      </form>
    </AdminPage>
  );
}

/** Drawing editor; public/map-editor.js does the drawing and saves each room's shape. */
export function FloorDraw({ db, user, floor, selected }: { db: Database; user: User; floor: Floor; selected?: number }) {
  const rooms = roomsOf(db, floor.venue_id);
  const floors = floorsOf(db, floor.venue_id);
  const data = rooms.map((r) => ({ id: r.id, name: roomName(r), floor_id: r.floor_id, shape: r.shape ? JSON.parse(r.shape) : null }));
  return (
    <AdminPage db={db} user={user} title={`Räume einzeichnen: ${floor.name}`}>
      <p>
        <a href={`/admin/venues/${floor.venue_id}`}>← Zurück zum Ort</a>
        {floors.length > 1 && " · Etage: "}
        {floors.length > 1 &&
          floors.map((f, i) => (
            <>
              {i > 0 && " · "}
              {f.id === floor.id ? <strong>{f.name}</strong> : <a href={`/admin/floors/${f.id}/draw`}>{f.name}</a>}
            </>
          ))}
      </p>
      {!floor.image && <p class="error">Diese Etage hat noch keinen Grundriss. Du kannst trotzdem zeichnen, besser ist aber zuerst ein Grundriss.</p>}
      <div class="mapedit" data-floor={String(floor.id)} data-selected={selected ? String(selected) : undefined}>
        <div class="mapcanvas">
          <FloorPlan floor={floor} rooms={rooms} />
        </div>
        <aside class="card mapside">
          <p class="muted noscript-hide">
            Raum wählen, dann in den Plan klicken, um Eckpunkte zu setzen (oder im Modus Rechteck ziehen). Punkte lassen sich verschieben;
            Rücktaste entfernt den letzten Punkt.
          </p>
          <div class="links modes" role="group" aria-label="Werkzeug">
            <button type="button" class="secondary" data-mode="poly" aria-pressed="true">
              Vieleck
            </button>
            <button type="button" class="secondary" data-mode="rect" aria-pressed="false">
              Rechteck
            </button>
          </div>
          <ul class="drawrooms">
            {rooms.map((r) => (
              <li>
                <label>
                  <input type="radio" name="room" value={String(r.id)} />
                  <span>{roomName(r)}</span>
                  <small class="muted" data-state>
                    {r.floor_id === floor.id && r.shape ? "✓" : r.floor_id !== floor.id && r.floor_id !== null ? floors.find((f) => f.id === r.floor_id)?.name : ""}
                  </small>
                </label>
              </li>
            ))}
          </ul>
          {rooms.length === 0 && <p>Noch keine Räume – lege sie beim Ort an.</p>}
          <div class="links">
            <button type="button" data-action="undo" class="secondary">
              Letzten Punkt entfernen
            </button>
            <button type="button" data-action="clear" class="secondary">
              Umriss löschen
            </button>
            <button type="button" data-action="save">
              Speichern
            </button>
          </div>
          <p class="muted" data-status role="status"></p>
        </aside>
      </div>
      <script type="application/json" id="rooms-data">
        {raw(JSON.stringify(data).replace(/</g, "\\u003c"))}
      </script>
      <script src={assetUrl("map-editor.js")} defer></script>
    </AdminPage>
  );
}
