import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth";
import { bump } from "../db";
import {
  deleteRoom, exportVenue, FLOOR_MAX_BYTES, floorsOf, getFloor, getRoom, getVenue, importVenue, parseShape, parseVenueJson, roomsOf,
} from "../rooms";
import { attachment, decode, slug } from "../text";
import { releaseUploads, saveUpload, uploadedFile } from "../uploads";
import { FloorDraw, RoomEdit, VenueEdit, VenuesPage } from "../views/venues";
import { form, requirePerm } from "./util";

type Form = Awaited<ReturnType<typeof form>>;

/** Room form values; the floor must belong to the venue. Throws a German message. */
function roomFields(db: Database, f: Form, venueId: number) {
  const name = f.str("name");
  if (!name) throw new Error("Name fehlt.");
  const floor = f.str("floor_id") ? getFloor(db, f.str("floor_id")) : null;
  if (f.str("floor_id") && floor?.venue_id !== venueId) throw new Error("Unbekannte Etage.");
  const other = roomsOf(db, venueId).find((r) => r.name.toLowerCase() === name.toLowerCase());
  return {
    name, other, short: f.str("short"), description: f.str("description"), kind: f.str("kind") === "area" ? "area" : "room",
    floor_id: floor?.id ?? null, sort: Number.parseInt(f.str("sort"), 10) || 0,
  };
}

export function venueRoutes(db: Database) {
  const r = new Hono<AppEnv>();
  for (const p of ["/venues", "/venues/*", "/floors/*", "/rooms/*"]) r.use(p, requirePerm(db, "map"));
  const user = (c: Context<AppEnv>) => c.get("user");

  r.get("/venues", (c) => c.html(<VenuesPage db={db} user={user(c)} />));
  r.post("/venues", async (c) => {
    const name = (await form(c)).str("name");
    if (!name) return c.html(<VenuesPage db={db} user={user(c)} error="Name fehlt." />, 400);
    const id = db.run("INSERT INTO venues (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM venues))", [name]).lastInsertRowid;
    return c.redirect(`/admin/venues/${id}`);
  });

  r.post("/venues/import", async (c) => {
    const f = await form(c);
    const fail = (error: string) => c.html(<VenuesPage db={db} user={user(c)} error={error} />, 400);
    const file = uploadedFile(f.body.file);
    if (!file) return fail("Bitte eine Lageplan-Datei auswählen.");
    if (file.size > 60 * 1024 * 1024) return fail("Die Datei ist zu groß.");
    const target = f.str("target") ? getVenue(db, f.str("target")) : null;
    if (f.str("target") && !target) return fail("Unbekannter Ort.");
    const { data, errors } = parseVenueJson(decode(new Uint8Array(await file.arrayBuffer())));
    if (!data) return fail(`Import nicht möglich: ${errors.join(" ")}`);
    let id: number;
    try {
      id = await importVenue(db, data, target?.id);
    } catch (e) {
      return fail(`Import nicht möglich: ${(e as Error).message}`);
    }
    bump(db);
    return c.redirect(`/admin/venues/${id}`);
  });

  r.get("/venues/:id", (c) => {
    const venue = getVenue(db, c.req.param("id"));
    return venue ? c.html(<VenueEdit db={db} user={user(c)} venue={venue} />) : c.notFound();
  });
  r.post("/venues/:id", async (c) => {
    const venue = getVenue(db, c.req.param("id"));
    if (!venue) return c.notFound();
    const f = await form(c);
    if (!f.str("name")) return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error="Name fehlt." />, 400);
    db.run("UPDATE venues SET name = ?, sort = ? WHERE id = ?", [f.str("name"), Number.parseInt(f.str("sort"), 10) || 0, venue.id]);
    bump(db);
    return c.redirect(`/admin/venues/${venue.id}`);
  });
  r.post("/venues/:id/delete", async (c) => {
    const venue = getVenue(db, c.req.param("id"));
    if (!venue) return c.notFound();
    if (!(await form(c)).str("confirm"))
      return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error="Bitte das Löschen bestätigen." />, 400);
    const images = floorsOf(db, venue.id).map((f) => f.image);
    db.transaction(() => {
      for (const room of roomsOf(db, venue.id)) deleteRoom(db, room.id);
      db.run("DELETE FROM venues WHERE id = ?", [venue.id]);
    })();
    releaseUploads(db, images);
    bump(db);
    return c.redirect("/admin/venues");
  });
  r.get("/venues/:id/export.json", async (c) => {
    const venue = getVenue(db, c.req.param("id"));
    if (!venue) return c.notFound();
    c.header("Content-Disposition", attachment(`lageplan-${slug(venue.name, "ort")}.json`, `lageplan-${venue.name}.json`));
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.body(JSON.stringify(await exportVenue(db, venue.id)));
  });

  // --- floors ---
  r.post("/venues/:id/floors", async (c) => {
    const venue = getVenue(db, c.req.param("id"));
    if (!venue) return c.notFound();
    const f = await form(c);
    if (!f.str("name")) return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error="Name der Etage fehlt." />, 400);
    try {
      const file = uploadedFile(f.body.image);
      const image = file ? await saveUpload(file, FLOOR_MAX_BYTES) : "";
      db.run("INSERT INTO floors (venue_id, name, image, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM floors WHERE venue_id = ?))", [
        venue.id, f.str("name"), image, venue.id,
      ]);
    } catch (e) {
      return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error={(e as Error).message} />, 400);
    }
    bump(db);
    return c.redirect(`/admin/venues/${venue.id}`);
  });
  r.post("/floors/:id", async (c) => {
    const floor = getFloor(db, c.req.param("id"));
    if (!floor) return c.notFound();
    const venue = getVenue(db, floor.venue_id)!;
    const f = await form(c);
    if (!f.str("name")) return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error="Name der Etage fehlt." />, 400);
    try {
      const file = uploadedFile(f.body.image);
      const image = file ? await saveUpload(file, FLOOR_MAX_BYTES) : floor.image;
      db.run("UPDATE floors SET name = ?, sort = ?, image = ? WHERE id = ?", [f.str("name"), Number.parseInt(f.str("sort"), 10) || 0, image, floor.id]);
      releaseUploads(db, [floor.image]);
    } catch (e) {
      return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error={(e as Error).message} />, 400);
    }
    bump(db);
    return c.redirect(`/admin/venues/${venue.id}`);
  });
  r.post("/floors/:id/delete", async (c) => {
    const floor = getFloor(db, c.req.param("id"));
    if (!floor) return c.notFound();
    const venue = getVenue(db, floor.venue_id)!;
    if (!(await form(c)).str("confirm"))
      return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error="Bitte das Löschen bestätigen." />, 400);
    db.transaction(() => {
      db.run("UPDATE rooms SET shape = '' WHERE floor_id = ?", [floor.id]);
      db.run("DELETE FROM floors WHERE id = ?", [floor.id]);
    })();
    releaseUploads(db, [floor.image]);
    bump(db);
    return c.redirect(`/admin/venues/${venue.id}`);
  });
  r.get("/floors/:id/draw", (c) => {
    const floor = getFloor(db, c.req.param("id"));
    return floor ? c.html(<FloorDraw db={db} user={user(c)} floor={floor} selected={Number(c.req.query("raum")) || undefined} />) : c.notFound();
  });

  // --- rooms ---
  r.post("/venues/:id/rooms", async (c) => {
    const venue = getVenue(db, c.req.param("id"));
    if (!venue) return c.notFound();
    try {
      const v = roomFields(db, await form(c), venue.id);
      if (v.other) throw new Error(`Einen Raum „${v.name}“ gibt es schon.`);
      db.run("INSERT INTO rooms (venue_id, floor_id, name, short, description, kind, sort) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        venue.id, v.floor_id, v.name, v.short, v.description, v.kind, v.sort,
      ]);
    } catch (e) {
      return c.html(<VenueEdit db={db} user={user(c)} venue={venue} error={(e as Error).message} />, 400);
    }
    bump(db);
    return c.redirect(`/admin/venues/${venue.id}`);
  });
  r.get("/rooms/:id", (c) => {
    const room = getRoom(db, c.req.param("id"));
    return room ? c.html(<RoomEdit db={db} user={user(c)} room={room} />) : c.notFound();
  });
  r.post("/rooms/:id", async (c) => {
    const room = getRoom(db, c.req.param("id"));
    if (!room) return c.notFound();
    try {
      const f = await form(c);
      const v = roomFields(db, f, room.venue_id);
      if (v.other && v.other.id !== room.id) throw new Error(`Einen Raum „${v.name}“ gibt es schon.`);
      const shape = f.str("shape") ? parseShape(f.str("shape")) : null;
      if (f.str("shape") && !shape) throw new Error("Der Umriss braucht mindestens 3 Punkte mit Werten von 0 bis 100.");
      // A room moved to another floor loses its outline, which belonged to the old plan.
      const keep = shape && v.floor_id === room.floor_id ? JSON.stringify(shape) : "";
      db.run("UPDATE rooms SET floor_id = ?, name = ?, short = ?, description = ?, kind = ?, sort = ?, shape = ? WHERE id = ?", [
        v.floor_id, v.name, v.short, v.description, v.kind, v.sort, keep, room.id,
      ]);
    } catch (e) {
      return c.html(<RoomEdit db={db} user={user(c)} room={room} error={(e as Error).message} />, 400);
    }
    bump(db);
    return c.redirect(`/admin/venues/${room.venue_id}`);
  });
  r.post("/rooms/:id/delete", async (c) => {
    const room = getRoom(db, c.req.param("id"));
    if (!room) return c.notFound();
    if (!(await form(c)).str("confirm")) return c.html(<RoomEdit db={db} user={user(c)} room={room} error="Bitte das Löschen bestätigen." />, 400);
    deleteRoom(db, room.id);
    bump(db);
    return c.redirect(`/admin/venues/${room.venue_id}`);
  });
  /** From the drawing editor: sets (or with an empty shape clears) the outline and puts the room on that floor. */
  r.post("/rooms/:id/shape", async (c) => {
    const room = getRoom(db, c.req.param("id"));
    if (!room) return c.notFound();
    const f = await form(c);
    const floor = getFloor(db, f.str("floor_id"));
    if (floor?.venue_id !== room.venue_id) return c.text("Unbekannte Etage.", 400);
    const shape = f.str("shape") ? parseShape(f.str("shape")) : null;
    if (f.str("shape") && !shape) return c.text("Ungültiger Umriss.", 400);
    db.run("UPDATE rooms SET shape = ?, floor_id = ? WHERE id = ?", [shape ? JSON.stringify(shape) : "", shape ? floor.id : room.floor_id, room.id]);
    bump(db);
    return c.json({ ok: true, shape });
  });

  return r;
}
