import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth";
import { releaseUploads } from "../uploads";
import { changesFor, itemDiff, logChange, quoted, shortDayLabel } from "../changelog";
import { activeEvent, bump, contactsFor, copyEvent, getEvent, getItem, itemsForEvent, subItemsFor, updateEvent, type Event, type ItemRow } from "../db";
import { forgetItem } from "../live";
import { decode, scheduleFromCsv, scheduleToCsv } from "../csv";
import { dayItems, deleteItem, importSchedule, moveItem, shiftSubItems, subSlot } from "../plan";
import { getRoom, getVenue, roomMap, roomStatus } from "../rooms";
import { berlinNow, duration, fmt, isDate, toMinutes } from "../time";
import { AdminPage } from "../views/admin";
import { itemLabel } from "../views/labels";
import { ChangesPage, EventDetail, EventsPage, ImportPage, ItemForm, ItemsPage, OccupancyPage, type ItemFields } from "../views/events";
import { form, requirePerm } from "./util";

/** Loads an event for writing: 404 if missing, 403 if archived. */
export async function editableEvent(db: Database, c: Context<AppEnv>, id: number | string): Promise<Event | Response> {
  const event = getEvent(db, id);
  if (!event) return c.notFound();
  if (event.status === "archived")
    return await c.html(
      <AdminPage db={db} user={c.get("user")} title="Archiviert">
        <p>Archiviert – nur lesbar.</p>
      </AdminPage>,
      403,
    );
  return event;
}

const TIME = /^\d{2}:\d{2}$/;

/** Where an item page returns to: only admin paths, so the parameter cannot redirect off-site. */
const backTo = (v: string | undefined) => (v && /^\/admin\/[\w/-]*(\?[\w=&-]*)?$/.test(v) ? v : undefined);

/** Form values; `end` is derived from start + duration and stays empty when the duration is invalid. */
function itemFields(f: Awaited<ReturnType<typeof form>>): ItemFields {
  const start = f.str("start");
  const minutes = Number(f.str("duration"));
  const ok = TIME.test(start) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  return {
    date: f.str("date"),
    start,
    end: ok ? fmt(toMinutes(start) + minutes) : "",
    fixed: f.str("fixed") ? 1 : 0,
    title: f.str("title"),
    top_number: f.str("top_number"),
    kind: f.str("kind") === "break" ? "break" : "agenda",
    location: f.str("location"),
    description: f.str("description"),
    // only breaks have a menu; switching an entry to TO-Punkt drops it
    menu: f.str("kind") === "break" ? f.str("menu") : "",
    responsible: f.str("responsible"),
    show_responsible: f.str("show_responsible") ? 1 : 0,
    room_id: Number(f.str("room_id")) || null,
  };
}

function validateItem(db: Database, ev: Event, v: ItemFields, parent?: ItemRow): string | null {
  if (!v.title) return "Titel fehlt.";
  if (!isDate(v.date)) return "Datum fehlt oder ist ungültig.";
  if (!TIME.test(v.start)) return "Bitte einen Beginn angeben.";
  if (!v.end) return "Die Dauer muss zwischen 1 und 1440 Minuten liegen.";
  if (v.room_id !== null && (ev.venue_id === null || getRoom(db, v.room_id)?.venue_id !== ev.venue_id)) return "Unbekannter Raum.";
  return parent ? subSlot(parent, v.start, v.end) : null;
}

/** A main entry's new length must still hold its sub-points (they move along with its start). */
function subsFit(db: Database, item: ItemRow, v: ItemFields): string | null {
  const resized = { start: item.start, end: fmt(toMinutes(item.start) + duration(v.start, v.end)) };
  const out = db.query<ItemRow, [number]>("SELECT * FROM items WHERE parent_id = ?").all(item.id).find((s) => subSlot(resized, s.start, s.end));
  return out ? `Der Unterpunkt „${out.title}“ passt nicht mehr in die Dauer des Eintrags. Bitte zuerst die Unterpunkte anpassen.` : null;
}

/** Everything but `date`, which moveItem sets together with the position. */
const ITEM_COLS = ["start", "end", "title", "top_number", "kind", "location", "description", "responsible", "show_responsible", "fixed", "room_id", "menu"] as const;
const itemValues = (v: ItemFields) => ITEM_COLS.map((k) => v[k]);

/** Sub-points share the parent's day, never anchor themselves and are agenda items. */
const asSub = (v: ItemFields, parent: ItemRow): ItemFields => ({ ...v, date: parent.date, fixed: 0, kind: "agenda" });

/** "Saal 1 ist um diese Zeit schon belegt: TOP 3 Wahlen (10:00–11:00)." when the chosen room clashes, else null. */
function doubleBooking(db: Database, ev: Event, v: ItemFields, selfId?: number): string | null {
  if (v.room_id === null || !v.end) return null;
  const st = roomStatus(db, ev, v.date, v.start, v.end, selfId).find((s) => s.room.id === v.room_id);
  if (!st?.conflicts.length) return null;
  const list = st.conflicts.map((b) => `${itemLabel(b.item)} (${b.item.start}–${b.item.end})`);
  return `${st.room.name} ist um diese Zeit schon belegt: ${list.join(", ")}.`;
}

export function eventRoutes(db: Database) {
  const r = new Hono<AppEnv>();

  // --- events (perm: events) ---
  r.use("/events", requirePerm(db, "events"));
  for (const p of ["/events/:id", "/events/:id/activate", "/events/:id/archive", "/events/:id/copy", "/events/:id/delete"])
    r.use(p, requirePerm(db, "events"));
  const allEvents = () => db.query<Event, []>("SELECT * FROM events ORDER BY start_date DESC").all();

  r.get("/events", (c) => c.html(<EventsPage db={db} user={c.get("user")} events={allEvents()} />));
  r.post("/events", async (c) => {
    const f = await form(c);
    const name = f.str("name");
    const start = f.str("start_date");
    if (!name || !isDate(start))
      return c.html(<EventsPage db={db} user={c.get("user")} events={allEvents()} error="Name und ersten Tag angeben." />, 400);
    db.run("INSERT INTO events (name, start_date) VALUES (?, ?)", [name, start]);
    return c.redirect("/admin/events");
  });
  r.get("/events/:id", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    return ev ? c.html(<EventDetail db={db} user={c.get("user")} event={ev} />) : c.notFound();
  });
  r.post("/events/:id", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    const f = await form(c);
    if (!f.str("name") || !isDate(f.str("start_date")))
      return c.html(<EventDetail db={db} user={c.get("user")} event={ev} error="Name und ersten Tag angeben." />, 400);
    updateEvent(db, ev.id, f.str("name"), f.str("start_date"));
    bump(db);
    return c.redirect(`/admin/events/${ev.id}`);
  });
  r.post("/events/:id/archive", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    db.run("UPDATE events SET status = 'archived' WHERE id = ?", [ev.id]);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}`);
  });
  r.post("/events/:id/copy", async (c) => {
    const ev = getEvent(db, c.req.param("id"));
    if (!ev) return c.notFound();
    const f = await form(c);
    if (!f.str("name") || !isDate(f.str("start_date")))
      return c.html(<EventDetail db={db} user={c.get("user")} event={ev} error="Name und ersten Tag angeben." />, 400);
    const id = copyEvent(db, ev.id, f.str("name"), f.str("start_date"));
    return c.redirect(`/admin/events/${id}`);
  });
  r.post("/events/:id/delete", async (c) => {
    const ev = getEvent(db, c.req.param("id"));
    if (!ev) return c.notFound();
    if (!(await form(c)).str("confirm"))
      return c.html(<EventDetail db={db} user={c.get("user")} event={ev} error="Bitte das Löschen bestätigen." />, 400);
    const photos = contactsFor(db, ev.id).map((p) => p.photo);
    db.run("DELETE FROM events WHERE id = ?", [ev.id]);
    releaseUploads(db, photos);
    bump(db);
    return c.redirect("/admin/events");
  });
  r.use("/events/:id/venue", requirePerm(db, "events"));
  r.post("/events/:id/venue", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    const id = (await form(c)).str("venue_id");
    const venue = id ? getVenue(db, id) : null;
    if (id && !venue) return c.html(<EventDetail db={db} user={c.get("user")} event={ev} error="Unbekannter Ort." />, 400);
    db.transaction(() => {
      // Rooms of the old venue mean nothing in the new one: their names stay as free-text place.
      if (venue?.id !== ev.venue_id)
        db.run(
          `UPDATE items SET location = CASE WHEN location = '' THEN (SELECT name FROM rooms WHERE id = room_id)
             ELSE (SELECT name FROM rooms WHERE id = room_id) || ', ' || location END, room_id = NULL
           WHERE event_id = ? AND room_id IS NOT NULL`,
          [ev.id],
        );
      db.run("UPDATE events SET venue_id = ? WHERE id = ?", [venue?.id ?? null, ev.id]);
    })();
    bump(db);
    return c.redirect(`/admin/events/${ev.id}`);
  });
  r.post("/events/:id/activate", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    db.transaction(() => {
      db.run("UPDATE events SET status = 'draft' WHERE status = 'active'");
      db.run("UPDATE events SET status = 'active' WHERE id = ?", [ev.id]);
    })();
    bump(db);
    return c.redirect("/admin/events");
  });

  // --- schedule items (perm: schedule) ---
  r.use("/schedule", requirePerm(db, "schedule"));
  r.use("/events/:id/items/*", requirePerm(db, "schedule"));
  r.use("/events/:id/items", requirePerm(db, "schedule"));
  r.use("/items/*", requirePerm(db, "schedule"));

  r.get("/schedule", (c) => {
    const ev = activeEvent(db);
    if (ev) return c.redirect(`/admin/events/${ev.id}/items`);
    return c.html(
      <AdminPage db={db} user={c.get("user")} title="Zeitplan">
        <p>Es ist keine Veranstaltung aktiv.</p>
      </AdminPage>,
    );
  });

  r.get("/events/:id/items", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    return ev ? c.html(<ItemsPage db={db} user={c.get("user")} event={ev} items={itemsForEvent(db, ev.id)} />) : c.notFound();
  });

  r.get("/events/:id/items/new", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    const last = itemsForEvent(db, ev.id).at(-1);
    const values: ItemFields = {
      date: last?.date ?? ev.start_date, start: last?.end ?? "", end: "", title: "", top_number: "", kind: "agenda",
      location: last?.location ?? "", description: "", responsible: "", show_responsible: 0, fixed: 0, room_id: last?.room_id ?? null, menu: "",
    };
    return c.html(<ItemForm db={db} user={c.get("user")} event={ev} action={`/admin/events/${ev.id}/items/new`} values={values} />);
  });
  r.post("/events/:id/items/new", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    const f = await form(c);
    const values = itemFields(f);
    const page = (props: { error?: string; double?: boolean }, status: 200 | 400 = 400) =>
      c.html(<ItemForm db={db} user={c.get("user")} event={ev} action={c.req.path} values={values} {...props} />, status);
    if (f.str("check")) return page({}, 200);
    const error = validateItem(db, ev, values);
    if (error) return page({ error });
    const double = f.str("double") ? null : doubleBooking(db, ev, values);
    if (double) return page({ error: double, double: true });
    db.transaction(() => {
      const id = Number(db.run(
        `INSERT INTO items (event_id, date, sort, ${ITEM_COLS.map((k) => `"${k}"`).join(", ")}) VALUES (?, ?, 1e9, ${ITEM_COLS.map(() => "?").join(", ")})`,
        [ev.id, values.date, ...itemValues(values)],
      ).lastInsertRowid);
      moveItem(db, id, values.date);
      const it = getItem(db, id)!;
      logChange(db, ev.id, c.get("user").username, `${quoted(it)} angelegt (${shortDayLabel(it.date)} ${it.start})`, id);
    })();
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/items`);
  });

  r.get("/items/:id", (c) => {
    const item = getItem(db, c.req.param("id"));
    if (!item) return c.notFound();
    const ev = getEvent(db, item.event_id)!;
    const parent = item.parent_id === null ? undefined : getItem(db, item.parent_id)!;
    return c.html(
      <ItemForm db={db} user={c.get("user")} event={ev} action={`/admin/items/${item.id}`} values={item} itemId={item.id} parent={parent} back={backTo(c.req.query("back"))} />,
    );
  });
  r.post("/items/:id", async (c) => {
    const item = getItem(db, c.req.param("id"));
    if (!item) return c.notFound();
    const ev = await editableEvent(db, c, item.event_id);
    if (ev instanceof Response) return ev;
    const parent = item.parent_id === null ? undefined : getItem(db, item.parent_id)!;
    const f = await form(c);
    const back = backTo(f.str("back"));
    const values = parent ? asSub(itemFields(f), parent) : itemFields(f);
    const page = (props: { error?: string; double?: boolean }, status: 200 | 400 = 400) =>
      c.html(<ItemForm db={db} user={c.get("user")} event={ev} action={c.req.path} values={values} itemId={item.id} parent={parent} back={back} {...props} />, status);
    if (f.str("check")) return page({}, 200);
    const error = validateItem(db, ev, values, parent) ?? (parent ? null : subsFit(db, item, values));
    if (error) return page({ error });
    const double = f.str("double") ? null : doubleBooking(db, ev, values, item.id);
    if (double) return page({ error: double, double: true });
    db.transaction(() => {
      db.run(`UPDATE items SET ${ITEM_COLS.map((k) => `"${k}" = ?`).join(", ")} WHERE id = ?`, [...itemValues(values), item.id]);
      if (parent) return;
      const idx = dayItems(db, ev.id, item.date).findIndex((x) => x.id === item.id);
      shiftSubItems(db, item.id, toMinutes(values.start) - toMinutes(item.start));
      // Same day keeps the position, unless a fixed entry got a (new) time: then it is placed by its time.
      const byTime = values.fixed && (!item.fixed || values.start !== item.start);
      const index = values.date === item.date && !byTime ? idx : undefined;
      moveItem(db, item.id, values.date, index, index === 0 && !values.fixed ? values.start : undefined);
    })();
    const diff = itemDiff(item, values, roomMap(db, ev.venue_id));
    if (diff) logChange(db, ev.id, c.get("user").username, `${parent ? "Unterpunkt " : ""}${quoted(item)} geändert: ${diff}`, item.id);
    bump(db);
    return c.redirect(back ?? (parent ? `/admin/items/${parent.id}` : `/admin/events/${ev.id}/items`));
  });
  r.post("/items/:id/delete", async (c) => {
    const item = getItem(db, c.req.param("id"));
    if (!item) return c.notFound();
    const ev = await editableEvent(db, c, item.event_id);
    if (ev instanceof Response) return ev;
    const back = backTo((await form(c)).str("back"));
    db.transaction(() => {
      forgetItem(db, item.id);
      deleteItem(db, item.id);
      logChange(db, ev.id, c.get("user").username, `${item.parent_id === null ? "" : "Unterpunkt "}${quoted(item)} gelöscht (${shortDayLabel(item.date)} ${item.start})`);
    })();
    bump(db);
    return c.redirect(back ?? (item.parent_id === null ? `/admin/events/${ev.id}/items` : `/admin/items/${item.parent_id}`));
  });

  // --- sub-points ---
  const parentOf = (id: string) => {
    const p = getItem(db, id);
    return p && p.parent_id === null ? p : null;
  };
  r.get("/items/:id/subs/new", async (c) => {
    const parent = parentOf(c.req.param("id"));
    if (!parent) return c.notFound();
    const ev = await editableEvent(db, c, parent.event_id);
    if (ev instanceof Response) return ev;
    const values: ItemFields = {
      date: parent.date, start: parent.start, end: parent.end, title: "", top_number: "", kind: "agenda", location: "",
      description: "", responsible: "", show_responsible: 0, fixed: 0, room_id: null, menu: "",
    };
    return c.html(<ItemForm db={db} user={c.get("user")} event={ev} action={c.req.path} values={values} parent={parent} />);
  });
  r.post("/items/:id/subs/new", async (c) => {
    const parent = parentOf(c.req.param("id"));
    if (!parent) return c.notFound();
    const ev = await editableEvent(db, c, parent.event_id);
    if (ev instanceof Response) return ev;
    const f = await form(c);
    const values = asSub(itemFields(f), parent);
    const page = (props: { error?: string; double?: boolean }, status: 200 | 400 = 400) =>
      c.html(<ItemForm db={db} user={c.get("user")} event={ev} action={c.req.path} values={values} parent={parent} {...props} />, status);
    if (f.str("check")) return page({}, 200);
    const error = validateItem(db, ev, values, parent);
    if (error) return page({ error });
    const double = f.str("double") ? null : doubleBooking(db, ev, values);
    if (double) return page({ error: double, double: true });
    const id = db.run(
      `INSERT INTO items (event_id, date, parent_id, sort, ${ITEM_COLS.map((k) => `"${k}"`).join(", ")})
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM items WHERE parent_id = ?), ${ITEM_COLS.map(() => "?").join(", ")})`,
      [ev.id, parent.date, parent.id, parent.id, ...itemValues(values)],
    ).lastInsertRowid;
    logChange(db, ev.id, c.get("user").username, `Unterpunkt ${quoted(values)} zu ${quoted(parent)} angelegt`, Number(id));
    bump(db);
    return c.redirect(`/admin/items/${parent.id}`);
  });

  // --- room occupancy ---
  r.use("/events/:id/rooms", requirePerm(db, "schedule"));
  r.get("/events/:id/rooms", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    if (!ev) return c.notFound();
    const days = [...new Set(itemsForEvent(db, ev.id).map((i) => i.date))];
    const q = c.req.query("date");
    const date = q && isDate(q) ? q : (days.find((d) => d >= berlinNow().date) ?? days[0] ?? ev.start_date);
    return c.html(<OccupancyPage db={db} user={c.get("user")} event={ev} days={days} date={date} />);
  });

  // --- change log ---
  r.use("/events/:id/changes", requirePerm(db, "schedule"));
  r.get("/events/:id/changes", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    return ev ? c.html(<ChangesPage db={db} user={c.get("user")} event={ev} changes={changesFor(db, ev.id, 500)} />) : c.notFound();
  });

  // --- CSV ---
  r.get("/events/:id/items/export.csv", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    if (!ev) return c.notFound();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="zeitplan-${ev.start_date}.csv"`);
    return c.body(scheduleToCsv(itemsForEvent(db, ev.id), subItemsFor(db, ev.id), roomMap(db, ev.venue_id)));
  });
  r.get("/events/:id/items/import", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    return c.html(<ImportPage db={db} user={c.get("user")} event={ev} existing={itemsForEvent(db, ev.id).length} />);
  });
  // Upload shows a preview; the preview posts the decoded text back with confirm=1.
  r.post("/events/:id/items/import", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    const f = await form(c);
    const existing = itemsForEvent(db, ev.id).length;
    const page = (props: { text?: string; error?: string }, status: 200 | 400 = 200) => {
      const parsed = props.text === undefined ? undefined : scheduleFromCsv(props.text);
      return c.html(<ImportPage db={db} user={c.get("user")} event={ev} existing={existing} {...props} {...parsed} />, status);
    };
    if (f.str("confirm")) {
      const text = typeof f.body.text === "string" ? f.body.text : "";
      const { rows, errors } = scheduleFromCsv(text);
      if (errors.length) return page({ text }, 400);
      if (existing > 0 && !f.str("replace")) return page({ text, error: "Bitte bestätigen, dass der Zeitplan ersetzt wird." }, 400);
      try {
        importSchedule(db, ev.id, rows);
        logChange(db, ev.id, c.get("user").username, `Zeitplan aus CSV importiert (${rows.length} Einträge)`);
      } catch (e) {
        return page({ text, error: (e as Error).message }, 400);
      }
      bump(db);
      return c.redirect(`/admin/events/${ev.id}/items`);
    }
    const file = f.body.csv;
    if (!(file instanceof File) || file.size === 0) return page({ error: "Bitte eine CSV-Datei auswählen." }, 400);
    if (file.size > 1_000_000) return page({ error: "Die Datei ist zu groß (höchstens 1 MB)." }, 400);
    return page({ text: decode(new Uint8Array(await file.arrayBuffer())) });
  });

  // ↑/↓ (dir) or drag and drop (date + index within that day).
  r.post("/items/:id/move", async (c) => {
    const item = getItem(db, c.req.param("id"));
    if (!item || item.parent_id !== null) return c.notFound();
    const ev = await editableEvent(db, c, item.event_id);
    if (ev instanceof Response) return ev;
    const f = await form(c);
    const dir = f.str("dir");
    const date = dir ? item.date : f.str("date");
    if (!isDate(date)) return c.text("Ungültiges Datum.", 400);
    const idx = dayItems(db, ev.id, item.date).findIndex((x) => x.id === item.id);
    const index = dir === "up" ? idx - 1 : dir === "down" ? idx + 1 : Number(f.str("index"));
    if (!Number.isInteger(index)) return c.text("Ungültige Position.", 400);
    moveItem(db, item.id, date, index);
    const moved = getItem(db, item.id)!;
    if (moved.date !== item.date || moved.sort !== item.sort)
      logChange(db, ev.id, c.get("user").username, `${quoted(item)} verschoben (${shortDayLabel(moved.date)}, ${moved.sort + 1}. Eintrag, jetzt ${moved.start})`, item.id);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/items`);
  });

  return r;
}
