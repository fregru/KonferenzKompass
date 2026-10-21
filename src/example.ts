import type { Database } from "bun:sqlite";
import { bump, getSetting, initOrder, setSetting } from "./db";
import { importVenue, parseVenueJson, roomsOf } from "./rooms";
import { addDays, berlinNow } from "./time";

/**
 * `location`: a room of the example venue by name, otherwise free text. `sub`: parallel sub-items [title, room].
 * `menu`: what a meal break serves, one dish per line.
 */
type Entry = [
  start: string, end: string, title: string, kind?: "agenda" | "break", top?: string, location?: string,
  extra?: { description?: string; responsible?: string; sub?: [string, string][]; menu?: string },
];

// Entries follow each other without gaps (the schedule pulls agenda items forward into gaps).
const DAYS: Entry[][] = [
  [
    ["16:00", "18:00", "Anreise und Akkreditierung", "agenda", "", "Empfang", { description: "Bitte bei der Akkreditierung deinen Stimmzettel und die Zugangsdaten für die Wahlen abholen." }],
    ["18:00", "19:30", "Abendessen", "break", "", "Speisesaal", { menu: "Kartoffelsuppe mit Würstchen\nvegetarisch: Kartoffelsuppe mit Croûtons" }],
    ["19:30", "20:00", "Eröffnung, Begrüßung und Formalia", "agenda", "TOP 1", "Goldener Saal", { responsible: "Diözesanleitung" }],
    ["20:00", "21:30", "Berichte des Diözesanvorstands", "agenda", "TOP 2", "Goldener Saal", { description: "Die Berichte findest du vorab unter **Unterlagen**." }],
    ["21:30", "23:30", "Abendprogramm", "agenda", "", "Keller"],
  ],
  [
    ["08:00", "09:00", "Frühstück", "break", "", "Speisesaal"],
    ["09:00", "09:15", "Morgenimpuls", "agenda", "", "Christkönigskapelle"],
    ["09:15", "10:45", "Anträge (Teil 1)", "agenda", "TOP 3", "Goldener Saal", { responsible: "Präsidium" }],
    ["10:45", "11:15", "Kaffeepause", "break", "", "Foyer"],
    ["11:15", "12:30", "Anträge (Teil 2)", "agenda", "TOP 4", "Goldener Saal", { responsible: "Präsidium" }],
    ["12:30", "14:00", "Mittagessen", "break", "", "Speisesaal", { menu: "Spaghetti Bolognese\nvegetarisch: Gemüselasagne\nDessert: Vanillepudding" }],
    ["14:00", "15:30", "Wahlen", "agenda", "TOP 5", "Goldener Saal", { description: "Abgestimmt wird digital. Bitte Handy oder Laptop mitbringen." }],
    ["15:30", "16:00", "Kaffeepause", "break", "", "Foyer"],
    [
      "16:00", "18:00", "Studienteil in Arbeitsgruppen", "agenda", "TOP 6", "",
      {
        description: "Vier Arbeitsgruppen parallel. Die Räume findest du im **Lageplan**.",
        sub: [
          ["AG 1: Jugendpolitik", "Thomas Morus"],
          ["AG 2: Glaube und Spiritualität", "Ursula von Köln"],
          ["AG 3: Nachhaltigkeit", "Sophie Scholl"],
          ["AG 4: Verbandsentwicklung", "Franz von Assisi"],
        ],
      },
    ],
    ["18:00", "19:00", "Abendessen", "break", "", "Speisesaal", { menu: "Grillabend: Bratwurst und Grillgemüse\nvegan: Falafel mit Hummus" }],
    ["19:00", "20:00", "Freizeit", "break"],
    ["20:00", "23:30", "Konferenzparty", "agenda", "", "Keller"],
  ],
  [
    ["08:00", "09:00", "Frühstück", "break", "", "Speisesaal"],
    ["09:00", "10:30", "Verschiedenes", "agenda", "TOP 7", "Goldener Saal"],
    ["10:30", "11:00", "Kaffeepause", "break", "", "Foyer"],
    ["11:00", "12:00", "Gottesdienst", "agenda", "", "Altenberger Dom"],
    ["12:00", "12:30", "Abschluss und Reisesegen", "agenda", "TOP 8", "Goldener Saal"],
    ["12:30", "13:30", "Mittagessen und Abreise", "break", "", "Speisesaal"],
  ],
];

const INTRO =
  "Hier findest du den aktuellen Zeitplan, alle Unterlagen und die Links zu Anträgen und Wahlen. Die Seite aktualisiert sich während der Konferenz von selbst.";

const FAQ: [string, string][] = [
  ["Was ist diese Seite?", "Die zentrale Infoseite zur Konferenz: Zeitplan, Unterlagen, Anträge und Wahlen an einem Ort. Verschiebt sich etwas im Ablauf, siehst du es hier sofort."],
  ["Wo finde ich die Unterlagen?", "Unter [Unterlagen](/p/unterlagen). Von dort geht es direkt zur Nextcloud mit allen Dokumenten."],
  ["Wie stelle ich einen Antrag oder Änderungsantrag?", "Über [Anträge](/p/antraege) (Antragsgrün). Die Zugangsdaten stehen in deiner Einladung."],
  ["Wie funktionieren die Wahlen?", "Abgestimmt wird digital über [Wahlen](/p/wahlen). Deinen Zugang bekommst du bei der Akkreditierung."],
  ["Wo gibt es WLAN?", "Im Netz „Altenberg-Gast“. Das Passwort hängt am Empfang aus."],
  ["An wen wende ich mich bei Fragen?", "An die Ansprechperson unten auf dieser Seite oder an das Team am Empfang. Weitere Hinweise unter [Hilfe & Service](/p/hilfe)."],
];

const LINKS: [slug: string, label: string, url: string][] = [
  ["unterlagen", "Zur Nextcloud", "https://cloud.example.org/s/diko"],
  ["antraege", "Zu Antragsgrün", "https://antraege.example.org"],
  ["wahlen", "Zu OpenSlides", "https://wahlen.example.org"],
];

const PAGE_TEXTS: Record<string, string> = {
  unterlagen: "Alle Berichte, Anträge und Protokolle liegen in der Nextcloud.",
  antraege: "Anträge und Änderungsanträge stellst du über Antragsgrün.",
  wahlen: "Die Wahlen und Abstimmungen laufen digital. Den Zugang bekommst du bei der Akkreditierung.",
  hilfe:
    "## Vor Ort\n\n- **Empfang:** im Eingangsbereich, durchgehend besetzt\n- **Erste Hilfe:** am Empfang melden\n- **Fundsachen:** am Empfang abgeben\n\n## Technik\n\nProbleme mit Antragsgrün oder den Wahlen? Sprich das Technik-Team am Präsidiumstisch an.",
  impressum: "**Bitte ausfüllen:** Name und Anschrift des Verbands, vertretungsberechtigte Person, Kontakt.",
  datenschutz: "**Bitte ausfüllen:** Wer verantwortlich ist, welche Daten verarbeitet werden und wo die Seite gehostet wird.",
};

/** Haus Altenberg with its floor plans and drawn rooms, as exported from the Lageplan admin. */
async function seedVenue(db: Database): Promise<number | null> {
  if (db.query("SELECT 1 FROM venues LIMIT 1").get()) return null;
  try {
    const { data, errors } = parseVenueJson(await Bun.file(new URL("./example-venue.json", import.meta.url)).text());
    if (!data) throw new Error(errors.join(" "));
    return await importVenue(db, data);
  } catch (e) {
    console.error("Beispiel-Lageplan konnte nicht angelegt werden:", e);
    return null;
  }
}

/**
 * Adds the example schedule to an event, from `startDate` on. Places that name a room of `venueId` become that room,
 * the rest stay free text. Call initOrder() afterwards.
 */
export function addExampleSchedule(db: Database, eventId: number, startDate: string, venueId: number | null) {
  const rooms = new Map(venueId === null ? [] : roomsOf(db, venueId).map((r) => [r.name, r.id]));
  const add = (date: string, start: string, end: string, title: string, kind: string, top: string, place: string, extra: Entry[6] = {}, parent: number | null = null) => {
    const room = rooms.get(place) ?? null;
    return Number(
      db.run(
        `INSERT INTO items (event_id, date, start, "end", title, kind, top_number, location, room_id, description, responsible, show_responsible, parent_id, menu)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, date, start, end, title, kind, top, room === null ? place : "", room, extra.description ?? "", extra.responsible ?? "", extra.responsible ? 1 : 0, parent, extra.menu ?? ""],
      ).lastInsertRowid,
    );
  };
  DAYS.forEach((entries, day) => {
    const date = addDays(startDate, day);
    for (const [start, end, title, kind = "agenda", top = "", place = "", extra = {}] of entries) {
      const id = add(date, start, end, title, kind, top, place, extra);
      extra.sub?.forEach(([t, p], i) => {
        const sub = add(date, start, end, t, "agenda", "", p, {}, id);
        db.run("UPDATE items SET sort = ? WHERE id = ?", [i, sub]);
      });
    }
  });
}

/**
 * Creates a three-day example conference starting today on the very first start (empty database), held in the
 * example venue. Runs at most once per installation, so deleting the example does not bring it back.
 */
export async function seedExample(db: Database, nowMs = Date.now()): Promise<boolean> {
  if (getSetting(db, "example_seeded") === "1") return false;
  setSetting(db, "example_seeded", "1");
  if (db.query("SELECT 1 FROM events LIMIT 1").get()) return false;

  const venue = await seedVenue(db);
  const today = berlinNow(new Date(nowMs)).date;
  db.transaction(() => {
    const ev = Number(
      db.run("INSERT INTO events (name, start_date, status, intro, venue_id) VALUES (?, ?, 'active', ?, ?)", [
        "Diözesankonferenz (Beispiel)",
        today,
        INTRO,
        venue,
      ]).lastInsertRowid,
    );
    addExampleSchedule(db, ev, today, venue);
    FAQ.forEach(([q, a], i) => db.run("INSERT INTO faq (event_id, question, answer, sort) VALUES (?, ?, ?, ?)", [ev, q, a, i + 1]));
    db.run("INSERT INTO contacts (event_id, name, role, phone, email) VALUES (?, ?, ?, ?, ?)", [
      ev,
      "Anna Beispiel",
      "Diözesanleitung",
      "+49 221 0000000",
      "kontakt@example.org",
    ]);
    LINKS.forEach(([slug, label, url]) => db.run("INSERT INTO page_links (event_id, page_slug, label, url) VALUES (?, ?, ?, ?)", [ev, slug, label, url]));
    for (const [slug, body] of Object.entries(PAGE_TEXTS)) db.run("UPDATE pages SET body = ? WHERE slug = ? AND body = ''", [body, slug]);
    initOrder(db, ev);
  })();
  bump(db);
  return true;
}
