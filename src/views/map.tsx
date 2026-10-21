import type { Database } from "bun:sqlite";
import { raw } from "hono/html";
import { activeEvent, getItem, itemsForEvent, type ItemRow, type Page } from "../db";
import { renderMarkdown } from "../markdown";
import { itemLabel } from "./labels";
import { bookings, centre, floorsOf, parseShape, publicVenue, roomsOf, type Floor, type Room } from "../rooms";
import { eventNow, fmt } from "../time";

/** Link to a room on the map page (`base` from mapPage); `from`: the schedule entry it was opened from, for the way back. */
export const roomHref = (base: string, id: number, from?: number) => `${base}?raum=${id}${from ? `&von=${from}` : ""}#karte`;

/** Room name for lists: "Seminarraum 2 (S2)". */
export const roomName = (r: Pick<Room, "name" | "short">) => (r.short && r.short !== r.name ? `${r.name} (${r.short})` : r.name);

/** "Saal", linked to the map when it is switched on, plus the free-text place. */
export function Place({ item, rooms, map, from }: {
  item: Pick<ItemRow, "room_id" | "location">; rooms: Map<number, Room>; map: string | null; from?: number;
}) {
  const room = item.room_id === null ? undefined : rooms.get(item.room_id);
  if (!room) return item.location ? <>{item.location}</> : null;
  return (
    <>
      {map ? (
        <a class="roomlink" href={roomHref(map, room.id, from)}>
          {room.name}
        </a>
      ) : (
        room.name
      )}
      {item.location && `, ${item.location}`}
    </>
  );
}

export const placeText = (item: Pick<ItemRow, "room_id" | "location">, rooms: Map<number, Room>) =>
  [item.room_id === null ? "" : (rooms.get(item.room_id)?.name ?? ""), item.location].filter(Boolean).join(", ");

const points = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(" ");

/** Bounding box "x0,y0,x1,y1" of a shape in percent, for public/map.js to test label collisions. */
const bbox = (pts: [number, number][]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].join(",");
};

/**
 * A floor plan with its drawn rooms. The polygons sit in a 0–100 viewBox stretched over the image; labels are HTML
 * on top, so text stays undistorted and readable by screen readers. `href` makes rooms clickable.
 * Labels start with the short name; public/map.js writes the full name out wherever it fits.
 */
export function FloorPlan({ floor, rooms, active, href }: { floor: Floor; rooms: Room[]; active?: number; href?: (r: Room) => string }) {
  const drawn = rooms.flatMap((r) => {
    const pts = r.floor_id === floor.id ? parseShape(r.shape) : null;
    return pts ? [{ r, pts, at: centre(pts) }] : [];
  });
  return (
    <div class={`floorplan${floor.image ? "" : " noimage"}`}>
      {floor.image && <img src={`/uploads/${floor.image}`} alt={`Grundriss ${floor.name}`} />}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {drawn.map(({ r, pts }) => {
          const shape = <polygon class={`${r.kind}${r.id === active ? " active" : ""}`} points={points(pts)} />;
          return href ? (
            <a href={href(r)} tabindex={-1}>
              {shape}
            </a>
          ) : (
            shape
          );
        })}
      </svg>
      {drawn.map(({ r, pts, at }) => {
        const attrs = {
          class: `roomlabel${r.id === active ? " active" : ""}`,
          style: `left:${at[0]}%;top:${at[1]}%`,
          title: r.short && r.short !== r.name ? r.name : undefined,
          "data-full": r.name,
          "data-short": r.short || r.name,
          "data-box": bbox(pts),
        };
        return href ? (
          <a {...attrs} href={href(r)} aria-current={r.id === active ? "location" : undefined}>
            {r.short || r.name}
          </a>
        ) : (
          <span {...attrs}>{r.short || r.name}</span>
        );
      })}
    </div>
  );
}

/** Public Lageplan: floor tabs, the plan, the selected room's details and a searchable room list. */
export function MapPage({ db, page, roomId, floorId, fromItem, nowMs }: {
  db: Database; page: Page; roomId?: number; floorId?: number; fromItem?: number; nowMs: number;
}) {
  const venue = publicVenue(db);
  const base = `/p/${page.slug}`;
  if (!venue)
    return (
      <article class="card page">
        <h1>{page.title}</h1>
        {page.body && <div class="prose">{raw(renderMarkdown(page.body))}</div>}
        <p class="muted">Der Lageplan folgt.</p>
      </article>
    );
  const floors = floorsOf(db, venue.id);
  const rooms = roomsOf(db, venue.id);
  const room = rooms.find((r) => r.id === roomId);
  const floor = floors.find((f) => f.id === (room?.floor_id ?? floorId)) ?? floors[0];
  const href = (r: Room) => roomHref(base, r.id);

  // What happens in the selected room today (active event only).
  const event = activeEvent(db);
  const today = eventNow(new Date(nowMs)).date;
  const todays = room && event ? (bookings(db, event.id, today).get(room.id) ?? []) : [];
  const parents = new Map(todays.some((b) => b.item.parent_id !== null) && event ? itemsForEvent(db, event.id).map((i) => [i.id, i]) : []);
  const label = (it: ItemRow) => {
    const parent = it.parent_id === null ? undefined : parents.get(it.parent_id);
    return [parent && itemLabel(parent), it.top_number, it.title].filter(Boolean).join(" · ");
  };
  // Opened from a schedule entry: offer the way back to it (only for entries of the active event).
  const from = fromItem === undefined ? null : getItem(db, fromItem);
  const back = from && event && from.event_id === event.id ? (from.parent_id ?? from.id) : null;

  return (
    <article class="card page mappage">
      {back !== null && (
        <p class="backlink">
          <a href={`/#e${back}`} data-back>
            ← Zurück zum Zeitplan
          </a>
        </p>
      )}
      <h1>{page.title}</h1>
      {page.body && <div class="prose">{raw(renderMarkdown(page.body))}</div>}
      {/* public/map.js swaps this part in place when a room or floor is picked, so the page does not jump */}
      <div class="mapview" data-mapview>
        {floors.length > 1 && (
          <nav class="floortabs" aria-label="Etagen">
            {floors.map((f) => (
              <a href={`${base}?etage=${f.id}#karte`} aria-current={f.id === floor?.id ? "page" : undefined}>
                {f.name}
              </a>
            ))}
          </nav>
        )}
        <div id="karte">{floor && <FloorPlan floor={floor} rooms={rooms} active={room?.id} href={href} />}</div>
        {room && (
          <section class="roominfo" aria-live="polite">
            <h2>{roomName(room)}</h2>
            <p class="muted">{[floors.find((f) => f.id === room.floor_id)?.name, venue.name].filter(Boolean).join(" · ")}</p>
            {!room.shape && room.floor_id !== null && <p class="muted">Dieser Raum ist im Plan noch nicht eingezeichnet.</p>}
            {room.description && <div class="prose">{raw(renderMarkdown(room.description))}</div>}
            {todays.length > 0 && (
              <>
                <h3>Heute hier</h3>
                <ul class="plain">
                  {todays.map((b) => (
                    <li>
                      <b>
                        {fmt(b.start)}–{fmt(b.end)}
                      </b>{" "}
                      {label(b.item)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
      <section class="roomsearch">
        <h2>Räume</h2>
        <label class="search">
          Raum suchen <input type="search" data-roomfilter placeholder="z. B. Saal" autocomplete="off" />
        </label>
        {[...floors.map((f) => ({ name: f.name, list: rooms.filter((r) => r.floor_id === f.id) })), { name: "Weitere Orte", list: rooms.filter((r) => r.floor_id === null) }]
          .filter((g) => g.list.length > 0)
          .map((g) => (
            <div class="roomgroup">
              <h3>{g.name}</h3>
              <ul class="roomlist">
                {g.list.map((r) => (
                  <li data-name={`${r.name} ${r.short}`.toLowerCase()}>
                    <a href={href(r)} aria-current={r.id === room?.id ? "location" : undefined}>
                      {roomName(r)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        <p class="muted" data-nohits hidden>
          Kein Raum gefunden.
        </p>
      </section>
      <script src="/static/map.js" defer></script>
    </article>
  );
}
