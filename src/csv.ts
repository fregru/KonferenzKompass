import type { ItemRow } from "./db";
import { duration, fmt, isDate, toMinutes } from "./time";

/** UTF-8 (with or without BOM), otherwise Windows-1252 as written by German Excel. */
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** RFC 4180 records; the separator (; tab ,) is taken from the header line. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].reduce((best, s) => (header.split(s).length > header.split(best).length ? s : best));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

const cell = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Semicolon-separated with BOM, so German Excel opens it with umlauts intact. */
export const toCsv = (rows: string[][]) => "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";

/**
 * `room`: name or short name of a room of the event's venue (matched on import, otherwise kept as free-text place).
 * `sub`: a sub-point of the previous main entry; without a Beginn it starts with its parent.
 */
export type ImportRow = {
  line: number; date: string; start: string | null; minutes: number; title: string; kind: "agenda" | "break";
  top_number: string; location: string; room: string; responsible: string; description: string; sub: boolean;
  /** Breaks only: dishes, one per line. */
  menu: string;
};

const HEADERS: Record<string, keyof ImportRow | "end"> = {
  datum: "date", beginn: "start", start: "start", uhrzeit: "start", dauer: "minutes", ende: "end", titel: "title",
  art: "kind", typ: "kind", top: "top_number", topnummer: "top_number", ort: "location", raum: "room",
  zuständig: "responsible", zustaendig: "responsible", verantwortlich: "responsible", beschreibung: "description",
  unterpunkt: "sub", essen: "menu", speiseplan: "menu", menü: "menu", menue: "menu",
};
export const CSV_COLUMNS = ["Datum", "Beginn", "Dauer", "Titel", "Art", "TOP", "Raum", "Ort", "Zuständig", "Beschreibung", "Unterpunkt", "Essen"];

/** "2026-11-13", "13.11.2026" or "13.11.26" → ISO date. */
function parseDate(v: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(v);
  const iso = m ? `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : v;
  return isDate(iso) ? iso : null;
}
/** "9:00", "09:00" or "09:00:00" → "09:00". */
function parseTime(v: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(:\d{2})?$/.exec(v);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]!.padStart(2, "0")}:${m[2]}` : null;
}
/** "90" or "1:30" → 90. */
function parseMinutes(v: string): number | null {
  const m = /^(\d+)(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const n = m[2] === undefined ? Number(m[1]) : Number(m[1]) * 60 + Number(m[2]);
  return n >= 1 && n <= 1440 ? n : null;
}

/**
 * Reads a schedule: one entry per row, in the order of the file within each day. "Beginn" makes an entry fixed;
 * without it the entry follows the previous one, so the first entry of every day needs one.
 */
export function scheduleFromCsv(text: string): { rows: ImportRow[]; errors: string[] } {
  const [header, ...records] = parseCsv(text);
  if (!header) return { rows: [], errors: ["Die Datei ist leer."] };
  const cols = header.map((h) => HEADERS[h.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-zäöüß]/g, "")]);
  const missing = [["Datum", "date"], ["Titel", "title"]].filter(([, k]) => !cols.includes(k as keyof ImportRow)).map(([n]) => n);
  if (!cols.includes("minutes") && !cols.includes("end")) missing.push("Dauer");
  if (missing.length) return { rows: [], errors: [`Spalte fehlt: ${missing.join(", ")}. Erwartet werden ${CSV_COLUMNS.join(";")}.`] };

  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const seenDays = new Set<string>();
  let parentDate: string | null = null;
  records.forEach((rec, i) => {
    const line = i + 2;
    const get = (k: keyof ImportRow | "end") => (rec[cols.indexOf(k)] ?? "").trim();
    const fail = (msg: string) => errors.push(`Zeile ${line}: ${msg}`);
    const date = parseDate(get("date"));
    const start = get("start") ? parseTime(get("start")) : null;
    const end = get("end") ? parseTime(get("end")) : null;
    let minutes = get("minutes") ? parseMinutes(get("minutes")) : null;
    if (!date) return fail(`Datum „${get("date")}“ ist ungültig (z. B. 13.11.2026).`);
    if (!get("title")) return fail("Titel fehlt.");
    if (get("start") && !start) return fail(`Beginn „${get("start")}“ ist ungültig (z. B. 09:30).`);
    if (get("minutes") && minutes === null) return fail(`Dauer „${get("minutes")}“ ist ungültig (Minuten, z. B. 45 oder 1:30).`);
    if (minutes === null && end && start) minutes = duration(start, end);
    if (minutes === null) return fail(get("end") && !start ? "Ende geht nur zusammen mit Beginn – sonst bitte die Dauer angeben." : "Dauer fehlt.");
    const sub = /^(x|ja|j|1|yes|true)$/i.test(get("sub"));
    if (sub) {
      if (parentDate !== date) return fail("Ein Unterpunkt braucht einen Haupteintrag am selben Tag direkt darüber.");
    } else {
      if (!seenDays.has(date) && !start) fail("Der erste Eintrag eines Tages braucht einen Beginn.");
      seenDays.add(date);
      parentDate = date;
    }
    rows.push({
      line, date, start, minutes, title: get("title"), kind: /pause|essen|break|kaffee/i.test(get("kind")) ? "break" : "agenda",
      top_number: get("top_number"), location: get("location"), room: get("room"), responsible: get("responsible"), description: get("description"), sub,
      menu: get("menu"),
    });
  });
  if (!records.length) errors.push("Die Datei enthält keine Einträge.");
  return { rows: rows.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line), errors };
}

/**
 * Export in the import format: "Beginn" only for fixed entries and each day's first. Sub-points follow their parent;
 * they get a Beginn unless they start with it.
 */
export function scheduleToCsv(items: ItemRow[], subs = new Map<number, ItemRow[]>(), rooms = new Map<number, { name: string }>()): string {
  const line = (it: ItemRow, start: string, sub: boolean) => {
    const [y, m, d] = it.date.split("-");
    return [
      `${d}.${m}.${y}`, start, String(duration(it.start, it.end)), it.title, it.kind === "break" ? "Pause" : "TO-Punkt", it.top_number,
      (it.room_id !== null && rooms.get(it.room_id)?.name) || "", it.location, it.responsible, it.description, sub ? "x" : "", it.menu,
    ];
  };
  const rows = items.flatMap((it, i) => [
    line(it, it.fixed || items[i - 1]?.date !== it.date ? it.start : "", false),
    ...(subs.get(it.id) ?? []).map((s) => line(s, s.start === it.start ? "" : s.start, true)),
  ]);
  return toCsv([CSV_COLUMNS, ...rows]);
}

/** End time for an imported row placed at `start`. */
export const endOf = (start: string, minutes: number) => fmt(toMinutes(start) + minutes);
