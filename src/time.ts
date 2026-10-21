const berlin = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type BerlinTime = { date: string; minutes: number };

export function berlinNow(d = new Date()): BerlinTime {
  const p = Object.fromEntries(berlin.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * The conference day lasts until 04:00: the night still belongs to the previous day and its minutes run on past
 * 1440, so a party from 22:00 to 01:00 keeps running and nothing resets at midnight.
 */
export const NIGHT_END = 4 * 60;
export function eventNow(d = new Date()): BerlinTime {
  const t = berlinNow(d);
  return t.minutes < NIGHT_END ? { date: addDays(t.date, -1), minutes: t.minutes + 1440 } : t;
}
export const toEventTime = (ms: number) => eventNow(new Date(ms));

/** Start minutes of one day in order; a time far earlier than the previous one counts as after midnight. */
export function unwrapStarts(starts: string[]): number[] {
  let prev = -Infinity;
  return starts.map((start) => {
    let s = toMinutes(start);
    if (s < prev - 720) s += 1440;
    return (prev = s);
  });
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

export function fmt(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function duration(start: string, end: string): number {
  const d = toMinutes(end) - toMinutes(start);
  return d <= 0 ? d + 1440 : d;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", timeZone: "UTC" });
/** "2026-11-13" → "Freitag, 13.11." */
export const dayLabel = (date: string) => dayFmt.format(new Date(`${date}T12:00:00Z`));

const DAY = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
/** Whole days from a to b ("YYYY-MM-DD"). */
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);
export const addDays = (date: string, days: number) => new Date(utc(date) + days * DAY).toISOString().slice(0, 10);
/** A real calendar day "YYYY-MM-DD" (rejects "2026-02-31" and "2026-13-01"). */
export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s)) && addDays(s, 0) === s;
