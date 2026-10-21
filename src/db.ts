import { Database } from "bun:sqlite";
import { addDays, daysBetween, toMinutes } from "./time";

const schema = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','archived')) DEFAULT 'draft', intro TEXT NOT NULL DEFAULT '',
  venue_id INTEGER REFERENCES venues ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', responsible TEXT NOT NULL DEFAULT '', show_responsible INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('agenda','break')), top_number TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0, fixed INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  room_id INTEGER REFERENCES rooms ON DELETE SET NULL, parent_id INTEGER REFERENCES items ON DELETE CASCADE,
  menu TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS live (event_id INTEGER PRIMARY KEY REFERENCES events ON DELETE CASCADE,
  current_item_id INTEGER, started_at INTEGER, elapsed_before INTEGER NOT NULL DEFAULT 0,
  pause_title TEXT, pause_started_at INTEGER, pause_until INTEGER);
CREATE TABLE IF NOT EXISTS live_history (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS faq (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  question TEXT NOT NULL, answer TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', messenger TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('link','markdown','legal','map')),
  title TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL DEFAULT '',
  direct INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS page_links (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  page_slug TEXT NOT NULL REFERENCES pages, label TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
  perms TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS venues (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS floors (id INTEGER PRIMARY KEY, venue_id INTEGER NOT NULL REFERENCES venues ON DELETE CASCADE,
  name TEXT NOT NULL, image TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY, venue_id INTEGER NOT NULL REFERENCES venues ON DELETE CASCADE,
  floor_id INTEGER REFERENCES floors ON DELETE SET NULL, name TEXT NOT NULL, short TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK (kind IN ('room','area')) DEFAULT 'room',
  shape TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
`;

const seedPages: [string, string, string, number][] = [
  ["unterlagen", "link", "Unterlagen", 1],
  ["antraege", "link", "Anträge", 2],
  ["wahlen", "link", "Wahlen", 3],
  ["hilfe", "markdown", "Hilfe & Service", 4],
  ["lageplan", "map", "Lageplan", 5],
  ["impressum", "legal", "Impressum", 90],
  ["datenschutz", "legal", "Datenschutz", 91],
];

const seedSettings: Record<string, string> = {
  site_title: "KonferenzKompass",
  org_name: "",
  copyright: "",
  logo: "",
  favicon: "",
  color_primary: "#00b6be", // kjg-koeln.de
  color_secondary: "#006d84",
  hero_image: "",
  hero_position: "center",
  show_intro: "1",
  show_schedule: "1",
  show_next: "1",
  show_contact: "1",
  version: "0",
};

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  migratePages(db);
  db.exec(schema);
  migrate(db);
  for (const [slug, kind, title, sort] of seedPages)
    db.run("INSERT OR IGNORE INTO pages (slug, kind, title, sort) VALUES (?, ?, ?, ?)", [slug, kind, title, sort]);
  for (const [k, v] of Object.entries(seedSettings))
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, v]);
  return db;
}

/**
 * Changes for databases created by older versions, in order; `PRAGMA user_version` counts the steps applied. Append
 * new steps and never change old ones. Step 1 covers everything from before the counter and checks each change itself.
 */
const MIGRATIONS: ((db: Database) => void)[] = [
  (db) => {
    // Databases created before intro/FAQ existed.
    if (!db.query("SELECT 1 FROM pragma_table_info('events') WHERE name = 'intro'").get())
      db.run("ALTER TABLE events ADD COLUMN intro TEXT NOT NULL DEFAULT ''");
    // Databases from before the pause rework: breaks no longer run as items, unplanned breaks are no schedule entries.
    if (!db.query("SELECT 1 FROM pragma_table_info('live') WHERE name = 'pause_until'").get())
      db.exec(`ALTER TABLE live ADD COLUMN pause_title TEXT; ALTER TABLE live ADD COLUMN pause_started_at INTEGER;
        ALTER TABLE live ADD COLUMN pause_until INTEGER;
        UPDATE live SET current_item_id = NULL, started_at = NULL, elapsed_before = 0
          WHERE current_item_id IN (SELECT id FROM items WHERE kind = 'break');`);
    if (db.query("SELECT 1 FROM pragma_table_info('items') WHERE name = 'unplanned'").get()) db.run("DELETE FROM items WHERE unplanned = 1");
    // Databases from before fixed/flowing entries: order and anchors are derived once so all times stay as they are.
    if (!db.query("SELECT 1 FROM pragma_table_info('items') WHERE name = 'fixed'").get()) {
      db.exec("ALTER TABLE items ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0; ALTER TABLE items ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;");
      initOrder(db);
    }
    // Databases from before the Lageplan: a venue per event, a room and sub-points per entry.
    if (!db.query("SELECT 1 FROM pragma_table_info('events') WHERE name = 'venue_id'").get())
      db.run("ALTER TABLE events ADD COLUMN venue_id INTEGER REFERENCES venues ON DELETE SET NULL");
    if (!db.query("SELECT 1 FROM pragma_table_info('items') WHERE name = 'room_id'").get())
      db.exec(`ALTER TABLE items ADD COLUMN room_id INTEGER REFERENCES rooms ON DELETE SET NULL;
        ALTER TABLE items ADD COLUMN parent_id INTEGER REFERENCES items ON DELETE CASCADE;`);
    // Databases from before the menu of meal breaks.
    if (!db.query("SELECT 1 FROM pragma_table_info('items') WHERE name = 'menu'").get()) db.run("ALTER TABLE items ADD COLUMN menu TEXT NOT NULL DEFAULT ''");
    // The Lageplan permission is new: user managers (the admins) get it once, everyone else via the user settings.
    if (!db.query("SELECT 1 FROM settings WHERE key = 'perm_map_granted'").get()) {
      for (const u of db.query<{ id: number; perms: string }, []>("SELECT id, perms FROM users").all()) {
        const perms: string[] = JSON.parse(u.perms);
        if (perms.includes("users") && !perms.includes("map")) db.run("UPDATE users SET perms = ? WHERE id = ?", [JSON.stringify([...perms, "map"]), u.id]);
      }
      db.run("INSERT INTO settings (key, value) VALUES ('perm_map_granted', '1')");
    }
  },
];

function migrate(db: Database) {
  const done = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  MIGRATIONS.slice(done).forEach((step, i) =>
    db.transaction(() => {
      step(db);
      db.run(`PRAGMA user_version = ${done + i + 1}`);
    })(),
  );
}

/** Databases from before the Lageplan only allow the old page kinds; SQLite cannot alter a CHECK, so the table is rebuilt. */
function migratePages(db: Database) {
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages'").get()?.sql;
  if (!sql || sql.includes("'map'")) return;
  db.run("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`CREATE TABLE pages_new (slug TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('link','markdown','legal','map')),
        title TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL DEFAULT '',
        direct INTEGER NOT NULL DEFAULT 0);
      INSERT INTO pages_new (slug, kind, title, enabled, sort, body, direct) SELECT slug, kind, title, enabled, sort, body, direct FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_new RENAME TO pages;`);
  })();
  db.run("PRAGMA foreign_keys = ON");
}

export function getSettings(db: Database): Record<string, string> {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export const getSetting = (db: Database, key: string): string =>
  db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "";

export function setSetting(db: Database, key: string, value: string): void {
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

export function bump(db: Database): void {
  db.run("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
}

export type Page = { slug: string; kind: "link" | "markdown" | "legal" | "map"; title: string; enabled: number; sort: number; body: string; direct: number };

export const getPages = (db: Database): Page[] => db.query<Page, []>("SELECT * FROM pages ORDER BY sort, slug").all();

export type Event = { id: number; name: string; start_date: string; status: "draft" | "active" | "archived"; intro: string; venue_id: number | null };
export type ItemRow = {
  id: number; event_id: number; date: string; start: string; end: string; title: string; description: string;
  location: string; responsible: string; show_responsible: number; kind: "agenda" | "break"; top_number: string;
  done: number;
  /** Breaks only: what there is to eat, one dish per line; empty shows nothing. */
  menu: string;
  /** 1: keeps its start time; 0: starts when the previous entry of the day ends. */
  fixed: number;
  /** Position within its day (sub-points: within their parent). */
  sort: number;
  room_id: number | null;
  /** Sub-points belong to a top-level entry, share its day and move with it; they never nest further. */
  parent_id: number | null;
};

export const activeEvent = (db: Database): Event | null =>
  db.query<Event, []>("SELECT * FROM events WHERE status = 'active'").get();
export const getEvent = (db: Database, id: number | string): Event | null =>
  db.query<Event, [number | string]>("SELECT * FROM events WHERE id = ?").get(id);
export const getItem = (db: Database, id: number | string): ItemRow | null =>
  db.query<ItemRow, [number | string]>("SELECT * FROM items WHERE id = ?").get(id);
/** Top-level entries; sub-points come from `subItemsFor`. */
export const itemsForEvent = (db: Database, eventId: number): ItemRow[] =>
  db.query<ItemRow, [number]>("SELECT * FROM items WHERE event_id = ? AND parent_id IS NULL ORDER BY date, sort, start, id").all(eventId);
/** Sub-points by parent id, in their order. */
export function subItemsFor(db: Database, eventId: number): Map<number, ItemRow[]> {
  const out = new Map<number, ItemRow[]>();
  for (const it of db
    .query<ItemRow, [number]>("SELECT * FROM items WHERE event_id = ? AND parent_id IS NOT NULL ORDER BY sort, start, id")
    .all(eventId))
    out.set(it.parent_id!, [...(out.get(it.parent_id!) ?? []), it]);
  return out;
}

export type Faq = { id: number; event_id: number; question: string; answer: string; sort: number };
export type Contact = { id: number; event_id: number; name: string; role: string; photo: string; phone: string; email: string; messenger: string; sort: number };
export type PageLink = { id: number; event_id: number; page_slug: string; label: string; url: string; sort: number };

export const faqFor = (db: Database, eventId: number): Faq[] =>
  db.query<Faq, [number]>("SELECT * FROM faq WHERE event_id = ? ORDER BY sort, id").all(eventId);
export const contactsFor = (db: Database, eventId: number): Contact[] =>
  db.query<Contact, [number]>("SELECT * FROM contacts WHERE event_id = ? ORDER BY sort, id").all(eventId);
export const linksFor = (db: Database, eventId: number): PageLink[] =>
  db.query<PageLink, [number]>("SELECT * FROM page_links WHERE event_id = ? ORDER BY sort, id").all(eventId);
export const getPage = (db: Database, slug: string): Page | null =>
  db.query<Page, [string]>("SELECT * FROM pages WHERE slug = ?").get(slug);

/** Renames an event and moves it to a new first day; its entries move by the same number of days. */
export function updateEvent(db: Database, id: number, name: string, startDate: string): void {
  const shift = daysBetween(getEvent(db, id)!.start_date, startDate);
  db.transaction(() => {
    db.run("UPDATE events SET name = ?, start_date = ? WHERE id = ?", [name, startDate, id]);
    if (shift === 0) return;
    for (const it of db.query<{ id: number; date: string }, [number]>("SELECT id, date FROM items WHERE event_id = ?").all(id))
      db.run("UPDATE items SET date = ? WHERE id = ?", [addDays(it.date, shift), it.id]);
  })();
}

/** Copies an event as a new draft: schedule shifted to the new start date (progress dropped); intro, FAQ, contacts and links kept; live state not copied. */
export function copyEvent(db: Database, id: number, name: string, startDate: string): number {
  const src = getEvent(db, id)!;
  const shift = daysBetween(src.start_date, startDate);
  return db.transaction(() => {
    const newId = Number(
      db.run("INSERT INTO events (name, start_date, intro, venue_id) VALUES (?, ?, ?, ?)", [name, startDate, src.intro, src.venue_id]).lastInsertRowid,
    );
    // Parents first, so sub-points can point at their copied parent.
    const ids = new Map<number, number>();
    for (const it of db.query<ItemRow, [number]>("SELECT * FROM items WHERE event_id = ? ORDER BY parent_id IS NOT NULL, id").all(id)) {
      const res = db.run(
        `INSERT INTO items (event_id, date, start, "end", title, description, location, responsible, show_responsible, kind, top_number, fixed, sort, room_id, parent_id, menu)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, addDays(it.date, shift), it.start, it.end, it.title, it.description, it.location, it.responsible, it.show_responsible, it.kind,
          it.top_number, it.fixed, it.sort, it.room_id, it.parent_id === null ? null : ids.get(it.parent_id)!, it.menu],
      );
      ids.set(it.id, Number(res.lastInsertRowid));
    }
    db.run(`INSERT INTO contacts (event_id, name, role, photo, phone, email, messenger, sort)
            SELECT ?, name, role, photo, phone, email, messenger, sort FROM contacts WHERE event_id = ?`, [newId, id]);
    db.run("INSERT INTO faq (event_id, question, answer, sort) SELECT ?, question, answer, sort FROM faq WHERE event_id = ?", [newId, id]);
    db.run(`INSERT INTO page_links (event_id, page_slug, label, url, sort)
            SELECT ?, page_slug, label, url, sort FROM page_links WHERE event_id = ?`, [newId, id]);
    return newId;
  })();
}

/**
 * Derives day order and anchors from the stored times (for `eventId`, or all events): breaks and every entry that
 * does not start right where the previous one ends are fixed, so recalculating a day changes no time.
 */
export function initOrder(db: Database, eventId?: number): void {
  const rows = db
    .query<ItemRow, [number | null, number | null]>("SELECT * FROM items WHERE (? IS NULL OR event_id = ?) AND parent_id IS NULL ORDER BY event_id, date, start, id")
    .all(eventId ?? null, eventId ?? null);
  let prev: ItemRow | undefined;
  let sort = 0;
  for (const it of rows) {
    const sameDay = prev?.event_id === it.event_id && prev.date === it.date;
    sort = sameDay ? sort + 1 : 0;
    const fixed = it.kind === "break" || (sameDay && toMinutes(prev!.end) !== toMinutes(it.start)) ? 1 : 0;
    db.run("UPDATE items SET fixed = ?, sort = ? WHERE id = ?", [fixed, sort, it.id]);
    prev = it;
  }
}
