import type { Database } from "bun:sqlite";
import { can, cleanPerms, type Perm, type User } from "./auth";
import { logChange } from "./changelog";
import { contactsFor, faqFor, getEvent, getPages, getSettings, itemsForEvent, linksFor, setSetting, subItemsFor, type ItemRow } from "./db";
import { safeUrl } from "./markdown";
import { checkVenue, exportVenue, floorsOf, roomMap, roomsOf, saveVenueImages, venues, VENUE_FORMAT, writeVenue, type VenueJson } from "./rooms";
import { isDate } from "./time";
import { fromDataUri, releaseUploads, saveData, uploadDataUri } from "./uploads";

/**
 * Sicherung: one JSON file with any selection of appearance settings, pages, users, venues and events. Uploads
 * (logo, photos) are embedded once in `files` and referenced by key; floor plans stay inside the venues, which are
 * exactly Lageplan exports. Live state, sessions and the undo history are never part of it.
 */
export const BACKUP_FORMAT = "konferenzkompass-sicherung";

/** Appearance settings; internal counters and flags (version, example_seeded, perm_*) stay out. */
const SETTING_KEYS = [
  "site_title", "org_name", "copyright", "logo", "favicon", "color_primary", "color_secondary", "color_primary_dark", "color_secondary_dark",
  "hero_image", "hero_position",
  "show_intro", "show_schedule", "show_next", "show_contact",
] as const;
const IMAGE_KEYS = ["logo", "favicon", "hero_image"];

export type ItemJson = {
  date: string; start: string; end: string; title: string; top_number: string; kind: "agenda" | "break"; location: string;
  /** Room name in the event's venue, or "". */
  room: string;
  responsible: string; show_responsible: boolean; description: string; menu: string; fixed: boolean; done: boolean;
  /** Sub-points (top-level entries only). */
  subs?: ItemJson[];
};
export type EventJson = {
  name: string; start_date: string; status: "draft" | "active" | "archived"; intro: string;
  /** Venue by name: one in the same file, or one already on the server. */
  venue: string | null;
  items: ItemJson[];
  faq: { question: string; answer: string }[];
  /** `photo`: key into `files`, or "". */
  contacts: { name: string; role: string; photo: string; phone: string; email: string; messenger: string }[];
  links: { page: string; label: string; url: string }[];
  changes?: { at: number; username: string; text: string }[];
};
export type PageJson = { slug: string; title: string; enabled: boolean; sort: number; body: string; direct: boolean };
export type UserJson = { username: string; hash: string; perms: Perm[] };
export type Backup = {
  format: typeof BACKUP_FORMAT; version: 1; created: string;
  /** Upload key → data URI. */
  files: Record<string, string>;
  settings?: Record<string, string>;
  pages?: PageJson[];
  users?: UserJson[];
  venues?: VenueJson[];
  events?: EventJson[];
};

/** Which part needs which permission, for export as well as import. */
export const PART_PERMS = { settings: "settings", pages: "pages", users: "users", venues: "map", events: "events" } as const satisfies Record<string, Perm>;
export const canBackup = (user: User) => Object.values(PART_PERMS).some((p) => can(user, p));

export type Selection = { settings: boolean; pages: boolean; users: boolean; venues: number[]; events: number[]; changes: boolean };

// ---------- export ----------

export async function exportBackup(db: Database, sel: Selection): Promise<Backup> {
  const files: Record<string, string> = {};
  /** Embeds an upload once and returns its key ("" when there is none). */
  const embed = async (name: string) => {
    if (!name) return "";
    if (!(name in files)) {
      const uri = await uploadDataUri(name);
      if (!uri) return ""; // file gone: exported without image
      files[name] = uri;
    }
    return name;
  };
  const out: Backup = { format: BACKUP_FORMAT, version: 1, created: new Date().toISOString(), files };

  if (sel.settings) {
    const s = getSettings(db);
    out.settings = {};
    for (const key of SETTING_KEYS) out.settings[key] = IMAGE_KEYS.includes(key) ? await embed(s[key] ?? "") : (s[key] ?? "");
  }
  if (sel.pages)
    out.pages = getPages(db).map((p) => ({ slug: p.slug, title: p.title, enabled: !!p.enabled, sort: p.sort, body: p.body, direct: !!p.direct }));
  if (sel.users)
    out.users = db
      .query<{ username: string; hash: string; perms: string }, []>("SELECT username, hash, perms FROM users ORDER BY username")
      .all()
      .map((u) => ({ username: u.username, hash: u.hash, perms: cleanPerms(JSON.parse(u.perms)) }));
  if (sel.venues.length) {
    out.venues = [];
    for (const v of venues(db)) if (sel.venues.includes(v.id)) out.venues.push(await exportVenue(db, v.id));
  }
  if (sel.events.length) {
    out.events = [];
    for (const id of sel.events) {
      const ev = getEvent(db, id);
      if (ev) out.events.push(await exportEvent(db, ev.id, sel.changes, embed));
    }
  }
  return out;
}

async function exportEvent(db: Database, id: number, withChanges: boolean, embed: (name: string) => Promise<string>): Promise<EventJson> {
  const ev = getEvent(db, id)!;
  const rooms = roomMap(db, ev.venue_id);
  const subs = subItemsFor(db, id);
  const item = (it: ItemRow): ItemJson => ({
    date: it.date, start: it.start, end: it.end, title: it.title, top_number: it.top_number, kind: it.kind, location: it.location,
    room: it.room_id === null ? "" : (rooms.get(it.room_id)?.name ?? ""), responsible: it.responsible, show_responsible: !!it.show_responsible,
    description: it.description, menu: it.menu, fixed: !!it.fixed, done: !!it.done,
  });
  const contacts = [];
  for (const c of contactsFor(db, id))
    contacts.push({ name: c.name, role: c.role, photo: await embed(c.photo), phone: c.phone, email: c.email, messenger: c.messenger });
  return {
    name: ev.name, start_date: ev.start_date, status: ev.status, intro: ev.intro,
    venue: ev.venue_id === null ? null : (venues(db).find((v) => v.id === ev.venue_id)?.name ?? null),
    items: itemsForEvent(db, id).map((it) => ({ ...item(it), subs: (subs.get(it.id) ?? []).map(item) })),
    faq: faqFor(db, id).map((f) => ({ question: f.question, answer: f.answer })),
    contacts,
    links: linksFor(db, id).map((l) => ({ page: l.page_slug, label: l.label, url: l.url })),
    ...(withChanges && {
      changes: db
        .query<{ at: number; username: string; text: string }, [number]>("SELECT at, username, text FROM changes WHERE event_id = ? ORDER BY id")
        .all(id),
    }),
  };
}

// ---------- parse ----------

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const TIME = /^\d{2}:\d{2}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE_MAX = 2 * 1024 * 1024;

/**
 * Validates a Sicherung (or a plain Lageplan export, read as a Sicherung with one venue). Errors are German and name
 * the part; nothing is written.
 */
export function parseBackup(text: string): { data: Backup | null; errors: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { data: null, errors: ["Die Datei ist kein gültiges JSON."] };
  }
  if (raw?.format === VENUE_FORMAT && raw.version === 1) {
    const { data, errors } = checkVenue(raw);
    return { data: data && { format: BACKUP_FORMAT, version: 1, created: "", files: {}, venues: [data] }, errors };
  }
  if (raw?.format !== BACKUP_FORMAT || raw.version !== 1) return { data: null, errors: ["Die Datei ist keine KonferenzKompass-Sicherung (Version 1)."] };
  const errors: string[] = [];
  const out: Backup = { format: BACKUP_FORMAT, version: 1, created: str(raw.created, 40), files: {} };

  for (const [key, uri] of Object.entries(raw.files && typeof raw.files === "object" ? raw.files : {})) {
    const file = typeof uri === "string" ? fromDataUri(uri) : null;
    if (!file) errors.push(`Datei „${key}“: kein gültiges Bild (PNG, JPG, WebP, ICO, SVG).`);
    else if (file.bytes.byteLength > IMAGE_MAX) errors.push(`Datei „${key}“: größer als 2 MB.`);
    else out.files[key] = uri as string;
  }
  /** A reference into `files`; unknown keys become "" (no image). */
  const fileRef = (v: unknown) => (typeof v === "string" && v in out.files ? v : "");

  if (raw.settings != null) {
    const s: Record<string, string> = {};
    for (const key of SETTING_KEYS) {
      const v = raw.settings[key];
      if (v === undefined) continue;
      if (IMAGE_KEYS.includes(key)) s[key] = fileRef(v);
      else if (key.startsWith("show_")) s[key] = v === "0" || v === 0 || v === false ? "0" : "1";
      else if (key.startsWith("color_")) {
        // darkmode colours may be "" (derived from the light colour)
        if (key.endsWith("_dark") && str(v) === "") s[key] = "";
        else if (!COLOR.test(str(v))) errors.push(`Erscheinungsbild: ungültige Farbe „${str(v, 20)}“.`);
        else s[key] = str(v).toLowerCase();
      } else s[key] = str(v, 200);
    }
    if (s.site_title === "") errors.push("Erscheinungsbild: Seitentitel fehlt.");
    out.settings = s;
  }

  if (raw.pages != null)
    out.pages = list(raw.pages).flatMap((p: any, i): PageJson[] => {
      const slug = str(p?.slug, 50);
      const title = str(p?.title, 200);
      if (!slug || !title) return errors.push(`Seite ${i + 1}: Kennung oder Name fehlt.`), [];
      return [{ slug, title, enabled: p.enabled !== false, sort: Number.isInteger(p.sort) ? p.sort : 0, body: str(p.body, 100_000), direct: !!p.direct }];
    });

  if (raw.users != null) {
    const seen = new Set<string>();
    out.users = list(raw.users).flatMap((u: any, i): UserJson[] => {
      const username = str(u?.username, 100);
      const hash = str(u?.hash, 500);
      if (!username) return errors.push(`Benutzer ${i + 1}: Name fehlt.`), [];
      if (!hash.startsWith("$")) return errors.push(`Benutzer „${username}“: Passwort-Hash fehlt oder ist ungültig.`), [];
      if (seen.has(username)) return errors.push(`Benutzer „${username}“ kommt doppelt vor.`), [];
      seen.add(username);
      return [{ username, hash, perms: cleanPerms(list(u.perms)) }];
    });
  }

  if (raw.venues != null)
    out.venues = list(raw.venues).flatMap((v, i) => {
      const { data, errors: e } = checkVenue(v);
      errors.push(...e.map((m) => `Ort ${str(v?.name, 200) ? `„${str(v.name, 200)}“` : i + 1}: ${m}`));
      return data ? [data] : [];
    });

  if (raw.events != null) out.events = list(raw.events).flatMap((e, i) => parseEvent(e, i, fileRef, errors));

  return { data: errors.length ? null : out, errors };
}

function parseEvent(e: any, i: number, fileRef: (v: unknown) => string, errors: string[]): EventJson[] {
  const name = str(e?.name, 200);
  const where = `Veranstaltung ${name ? `„${name}“` : i + 1}`;
  const before = errors.length;
  if (!name) errors.push(`${where}: Name fehlt.`);
  if (!isDate(str(e?.start_date, 10))) errors.push(`${where}: erster Tag fehlt oder ist ungültig.`);
  const item = (it: any, n: string, parent?: ItemJson): ItemJson | null => {
    const title = str(it?.title, 300);
    const date = parent?.date ?? str(it?.date, 10);
    const start = str(it?.start, 5);
    const end = str(it?.end, 5);
    if (!title) return errors.push(`${where}, Eintrag ${n}: Titel fehlt.`), null;
    if (!isDate(date)) return errors.push(`${where}, „${title}“: Datum ungültig.`), null;
    if (!TIME.test(start) || !TIME.test(end)) return errors.push(`${where}, „${title}“: Beginn oder Ende ungültig.`), null;
    const kind = parent ? "agenda" : it.kind === "break" ? "break" : "agenda";
    return {
      date, start, end, title, top_number: str(it.top_number, 50), kind, location: str(it.location, 300), room: str(it.room, 200),
      responsible: str(it.responsible, 300), show_responsible: !!it.show_responsible, description: str(it.description, 20_000),
      menu: kind === "break" ? str(it.menu, 5000) : "", fixed: !parent && !!it.fixed, done: !!it.done,
    };
  };
  const items = list(e?.items).flatMap((it, n): ItemJson[] => {
    const main = item(it, String(n + 1));
    if (!main) return [];
    main.subs = list(it.subs).flatMap((s, m) => item(s, `${n + 1}.${m + 1}`, main) ?? []);
    return [main];
  });
  const contacts = list(e?.contacts).flatMap((c: any, n) => {
    const cname = str(c?.name, 200);
    if (!cname) return errors.push(`${where}, Kontakt ${n + 1}: Name fehlt.`), [];
    const messenger = str(c.messenger, 500);
    if (messenger && !safeUrl(messenger)) return errors.push(`${where}, Kontakt „${cname}“: Messenger-Link ungültig.`), [];
    return [{ name: cname, role: str(c.role, 200), photo: fileRef(c.photo), phone: str(c.phone, 100), email: str(c.email, 200), messenger }];
  });
  const links = list(e?.links).flatMap((l: any) => {
    const url = safeUrl(str(l?.url, 2000));
    const label = str(l?.label, 200);
    if (!url || !label) return errors.push(`${where}: Link „${label || "?"}“ ist ungültig (nur http(s)).`), [];
    return [{ page: str(l.page, 50), label, url }];
  });
  if (errors.length > before) return [];
  return [{
    name, start_date: str(e.start_date, 10), status: e.status === "archived" ? "archived" : e.status === "active" ? "active" : "draft",
    intro: str(e.intro, 100_000), venue: str(e.venue, 200) || null, items,
    faq: list(e.faq).flatMap((f: any) => (str(f?.question, 1000) ? [{ question: str(f.question, 1000), answer: str(f.answer, 20_000) }] : [])),
    contacts, links,
    ...(Array.isArray(e.changes) && {
      changes: list(e.changes).flatMap((c: any) =>
        Number.isFinite(c?.at) && str(c.text, 2000) ? [{ at: c.at, username: str(c.username, 100) || "?", text: str(c.text, 2000) }] : [],
      ),
    }),
  }];
}

// ---------- preview ----------

export type Choice = { value: string; label: string };
/** One part of the file with its possible actions (first = default); `perm` false: shown, never applied. */
export type PreviewRow = { key: string; group: string; label: string; state: string; choices: Choice[]; notes: string[]; perm: boolean };

const SKIP: Choice = { value: "skip", label: "Überspringen" };
const lower = (s: string) => s.toLowerCase();

/** What the import would do with each part, matched against the current data. */
export function previewImport(db: Database, data: Backup, user: User): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const allowed = (part: keyof typeof PART_PERMS) => can(user, PART_PERMS[part]);
  if (data.settings)
    rows.push({ key: "settings", group: "Erscheinungsbild", label: data.settings.site_title ?? "Erscheinungsbild", state: "ersetzt die aktuellen Einstellungen",
      choices: [{ value: "replace", label: "Übernehmen" }, SKIP], notes: [], perm: allowed("settings") });
  const pages = new Map(getPages(db).map((p) => [p.slug, p]));
  data.pages?.forEach((p, i) => {
    const known = pages.get(p.slug);
    rows.push({ key: `page:${i}`, group: "Seiten", label: p.title, state: known ? `ersetzt „${known.title}“` : "unbekannte Seite",
      choices: known ? [{ value: "replace", label: "Übernehmen" }, SKIP] : [SKIP], notes: [], perm: allowed("pages") });
  });
  const users = new Set(db.query<{ username: string }, []>("SELECT username FROM users").all().map((u) => u.username));
  data.users?.forEach((u, i) => {
    const own = u.username === user.username;
    const exists = users.has(u.username);
    rows.push({ key: `user:${i}`, group: "Benutzer", label: u.username, state: own ? "dein eigenes Konto" : exists ? "gibt es schon" : "neu",
      choices: own ? [SKIP] : exists ? [SKIP, { value: "replace", label: "Ersetzen (Rechte und Passwort)" }] : [{ value: "new", label: "Anlegen" }, SKIP],
      notes: own ? ["Das eigene Konto wird nie überschrieben."] : [], perm: allowed("users") });
  });
  const serverVenues = venues(db);
  data.venues?.forEach((v, i) => {
    const match = serverVenues.find((x) => lower(x.name) === lower(v.name));
    rows.push({ key: `venue:${i}`, group: "Orte", label: v.name, state: match ? "gibt es schon" : "neu",
      choices: match
        ? [{ value: "replace", label: "Ersetzen (Räume bleiben zugeordnet)" }, { value: "new", label: "Als neuen Ort anlegen" }, SKIP]
        : [{ value: "new", label: "Anlegen" }, SKIP],
      notes: [], perm: allowed("venues") });
  });
  const events = db.query<{ id: number; name: string; start_date: string; status: string }, []>("SELECT id, name, start_date, status FROM events").all();
  data.events?.forEach((e, i) => {
    const match = events.find((x) => x.name === e.name && x.start_date === e.start_date);
    const notes: string[] = [];
    if (e.venue && !data.venues?.some((v) => lower(v.name) === lower(e.venue!)) && !serverVenues.some((v) => lower(v.name) === lower(e.venue!)))
      notes.push(`Ort „${e.venue}“ fehlt: Räume werden als Text im Feld „Ort“ übernommen.`);
    if (e.status === "active" && !match) notes.push("Wird als Entwurf angelegt (aktiv ist immer nur eine Veranstaltung).");
    if (match?.status === "archived") notes.push("Die vorhandene ist archiviert und bleibt es beim Ersetzen.");
    const count = e.items.length + e.items.reduce((n, it) => n + (it.subs?.length ?? 0), 0);
    rows.push({ key: `event:${i}`, group: "Veranstaltungen", label: e.name, state: `${match ? "gibt es schon" : "neu"} · ${count} Einträge`,
      choices: match
        ? [SKIP, { value: "replace", label: "Ersetzen (Inhalt neu, Status bleibt)" }, { value: "new", label: "Als Entwurf neu anlegen" }]
        : [{ value: "new", label: "Als Entwurf anlegen" }, SKIP],
      notes, perm: allowed("events") });
  });
  return rows;
}

// ---------- apply ----------

export type ImportResult = { done: string[] };

/**
 * Applies the chosen actions (key → value from the preview; anything not offered there counts as skip). Images are
 * saved first, then everything is written in one transaction; on failure the new images are removed again.
 */
export async function applyImport(db: Database, data: Backup, choices: Record<string, string>, user: User): Promise<ImportResult> {
  const rows = previewImport(db, data, user);
  const action = (key: string) => {
    const row = rows.find((r) => r.key === key);
    const v = choices[key] ?? row?.choices[0]?.value;
    return row?.perm && row.choices.some((c) => c.value === v) ? v! : "skip";
  };
  const settings = data.settings && action("settings") === "replace" ? data.settings : null;
  const venueActs = (data.venues ?? []).map((v, i) => ({ v, act: action(`venue:${i}`) })).filter((x) => x.act !== "skip");
  const eventActs = (data.events ?? []).map((e, i) => ({ e, act: action(`event:${i}`) })).filter((x) => x.act !== "skip");

  // Files first: settings images and contact photos by key, floor plans per venue.
  const saved = new Map<string, string>();
  const venueImages: string[][] = [];
  const created = () => [...saved.values(), ...venueImages.flat()];
  try {
    const keys = new Set([
      ...(settings ? IMAGE_KEYS.map((k) => settings[k] ?? "") : []),
      ...eventActs.flatMap(({ e }) => e.contacts.map((c) => c.photo)),
    ]);
    for (const key of keys) {
      const file = key && data.files[key] ? fromDataUri(data.files[key]!) : null;
      if (file) saved.set(key, await saveData(file.bytes, file.ext, IMAGE_MAX));
    }
    for (const { v } of venueActs) venueImages.push(await saveVenueImages(v));
  } catch (e) {
    releaseUploads(db, created());
    throw e;
  }

  const old: string[] = [];
  const done: string[] = [];
  try {
    db.transaction(() => {
      if (settings) {
        const before = getSettings(db);
        for (const [key, value] of Object.entries(settings)) {
          if (IMAGE_KEYS.includes(key)) {
            old.push(before[key] ?? "");
            setSetting(db, key, saved.get(value) ?? "");
          } else setSetting(db, key, value);
        }
        done.push("Erscheinungsbild übernommen");
      }
      data.pages?.forEach((p, i) => {
        if (action(`page:${i}`) !== "replace") return;
        db.run("UPDATE pages SET title = ?, enabled = CASE WHEN kind = 'legal' THEN 1 ELSE ? END, sort = ?, body = ?, direct = ? WHERE slug = ?",
          [p.title, p.enabled ? 1 : 0, p.sort, p.body, p.direct ? 1 : 0, p.slug]);
        done.push(`Seite „${p.title}“ übernommen`);
      });
      data.users?.forEach((u, i) => {
        const act = action(`user:${i}`);
        if (act === "new") db.run("INSERT INTO users (username, hash, perms) VALUES (?, ?, ?)", [u.username, u.hash, JSON.stringify(u.perms)]);
        else if (act === "replace") {
          const id = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(u.username)!.id;
          db.run("UPDATE users SET hash = ?, perms = ? WHERE id = ?", [u.hash, JSON.stringify(u.perms), id]);
          db.run("DELETE FROM sessions WHERE user_id = ?", [id]); // the password may have changed
        } else return;
        done.push(`Benutzer „${u.username}“ ${act === "new" ? "angelegt" : "ersetzt"}`);
      });
      // Venues imported now win over same-named ones already there when events look up their venue.
      const venueIds = new Map<string, number>();
      venueActs.forEach(({ v, act }, n) => {
        const target = act === "replace" ? venues(db).find((x) => lower(x.name) === lower(v.name)) : undefined;
        if (target) old.push(...floorsOf(db, target.id).map((f) => f.image));
        venueIds.set(lower(v.name), writeVenue(db, v, venueImages[n]!, target?.id));
        done.push(`Ort „${v.name}“ ${target ? "ersetzt" : "angelegt"}`);
      });
      const venueId = (name: string | null) =>
        name === null ? null : (venueIds.get(lower(name)) ?? venues(db).find((x) => lower(x.name) === lower(name))?.id ?? null);
      for (const { e, act } of eventActs) {
        const target = act === "replace"
          ? db.query<{ id: number }, [string, string]>("SELECT id FROM events WHERE name = ? AND start_date = ?").get(e.name, e.start_date)
          : null;
        const id = writeEvent(db, e, venueId(e.venue), saved, target?.id, old);
        logChange(db, id, user.username, target ? "Veranstaltung aus Sicherung ersetzt" : "Veranstaltung aus Sicherung angelegt");
        done.push(`Veranstaltung „${e.name}“ ${target ? "ersetzt" : "angelegt"}`);
      }
    })();
  } catch (e) {
    releaseUploads(db, created());
    throw e;
  }
  releaseUploads(db, old);
  return { done };
}

/** Writes one event (new as draft or archived, or over `targetId` keeping its status); returns its id. */
function writeEvent(db: Database, e: EventJson, venueId: number | null, files: Map<string, string>, targetId: number | undefined, old: string[]): number {
  let id: number;
  if (targetId !== undefined) {
    id = targetId;
    old.push(...contactsFor(db, id).map((c) => c.photo));
    for (const table of ["items", "faq", "contacts", "page_links", "live", "live_history"]) db.run(`DELETE FROM ${table} WHERE event_id = ?`, [id]);
    if (e.changes) db.run("DELETE FROM changes WHERE event_id = ?", [id]);
    db.run("UPDATE events SET name = ?, start_date = ?, intro = ?, venue_id = ? WHERE id = ?", [e.name, e.start_date, e.intro, venueId, id]);
  } else
    id = Number(db.run("INSERT INTO events (name, start_date, status, intro, venue_id) VALUES (?, ?, ?, ?, ?)",
      [e.name, e.start_date, e.status === "archived" ? "archived" : "draft", e.intro, venueId]).lastInsertRowid);

  const rooms = new Map(venueId === null ? [] : roomsOf(db, venueId).map((r) => [lower(r.name), r.id]));
  const insert = (it: ItemJson, sort: number, parentId: number | null) => {
    const roomId = it.room ? (rooms.get(lower(it.room)) ?? null) : null;
    // A room that does not exist here stays readable as free-text place.
    const location = it.room && roomId === null ? [it.room, it.location].filter(Boolean).join(", ") : it.location;
    return Number(db.run(
      `INSERT INTO items (event_id, date, start, "end", title, description, location, responsible, show_responsible, kind, top_number, done, fixed, sort, room_id, parent_id, menu)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, it.date, it.start, it.end, it.title, it.description, location, it.responsible, it.show_responsible ? 1 : 0, it.kind, it.top_number,
        it.done ? 1 : 0, it.fixed ? 1 : 0, sort, roomId, parentId, it.menu],
    ).lastInsertRowid);
  };
  // Sort counts per day, as the schedule keeps it.
  const perDay = new Map<string, number>();
  for (const it of e.items) {
    const sort = perDay.get(it.date) ?? 0;
    perDay.set(it.date, sort + 1);
    const parent = insert(it, sort, null);
    it.subs?.forEach((s, n) => insert({ ...s, date: it.date }, n, parent));
  }
  e.faq.forEach((f, n) => db.run("INSERT INTO faq (event_id, question, answer, sort) VALUES (?, ?, ?, ?)", [id, f.question, f.answer, n + 1]));
  e.contacts.forEach((c, n) =>
    db.run("INSERT INTO contacts (event_id, name, role, photo, phone, email, messenger, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, c.name, c.role, files.get(c.photo) ?? "", c.phone, c.email, c.messenger, n + 1]));
  const slugs = new Set(getPages(db).map((p) => p.slug));
  e.links.forEach((l, n) => {
    if (slugs.has(l.page)) db.run("INSERT INTO page_links (event_id, page_slug, label, url, sort) VALUES (?, ?, ?, ?, ?)", [id, l.page, l.label, l.url, n + 1]);
  });
  for (const c of e.changes ?? []) db.run("INSERT INTO changes (event_id, at, username, item_id, text) VALUES (?, ?, ?, NULL, ?)", [id, c.at, c.username, c.text]);
  return id;
}
