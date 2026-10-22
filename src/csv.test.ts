import { test, expect } from "bun:test";
import { decode, parseCsv, scheduleFromCsv } from "./csv";
import { dayItems } from "./plan";
import { loginAs, post, testApp } from "./test-helpers";

const CSV = `Datum;Beginn;Dauer (min);Titel;Art;TOP;Ort;Zuständig;Beschreibung
13.11.2026;09:00;30;Begrüßung;;TOP 1;Saal;Anna;
13.11.2026;;1:30;"Anträge; Teil 1";;TOP 2;;;"Zeile 1
Zeile 2"
13.11.2026;12:00;60;Mittagessen;Pause;;Mensa;;
13.11.2026;;45;Wahlen;;TOP 3;;;
2026-11-14;08:30;30;Morgenimpuls;;;;;
`;

test("parseCsv handles quotes, separators inside quotes, line breaks and comma files", () => {
  expect(parseCsv('a;b\r\n"x;y";"say ""hi"""\r\n')).toEqual([["a", "b"], ["x;y", 'say "hi"']]);
  expect(parseCsv("a,b\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
});

test("decode reads UTF-8 with BOM and falls back to Windows-1252", () => {
  expect(decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa4]))).toBe("Aä");
  expect(decode(new Uint8Array([0x41, 0xe4]))).toBe("Aä");
});

test("scheduleFromCsv: Beginn makes entries fixed, others follow; quoted fields survive", () => {
  const { rows, errors } = scheduleFromCsv(CSV);
  expect(errors).toEqual([]);
  expect(rows.map((r) => [r.date, r.start, r.minutes, r.kind])).toEqual([
    ["2026-11-13", "09:00", 30, "agenda"], ["2026-11-13", null, 90, "agenda"], ["2026-11-13", "12:00", 60, "break"],
    ["2026-11-13", null, 45, "agenda"], ["2026-11-14", "08:30", 30, "agenda"],
  ]);
  expect(rows[1]).toMatchObject({ title: "Anträge; Teil 1", description: "Zeile 1\nZeile 2" });
});

test("scheduleFromCsv reports errors per line", () => {
  const { errors } = scheduleFromCsv(`Datum;Beginn;Dauer;Titel
32.11.2026;09:00;30;A
13.11.2026;;30;Ohne Beginn
13.11.2026;9:00;abc;B
13.11.2026;09:00;30;
`);
  expect(errors).toEqual([
    "Zeile 2: Datum „32.11.2026“ ist ungültig (z. B. 13.11.2026).",
    "Zeile 3: Der erste Eintrag eines Tages braucht einen Beginn.",
    "Zeile 4: Dauer „abc“ ist ungültig (Minuten, z. B. 45 oder 1:30).",
    "Zeile 5: Titel fehlt.",
  ]);
  expect(scheduleFromCsv("Name;Zeit\nx;y").errors[0]).toContain("Spalte fehlt: Datum, Titel, Dauer");
});

async function setup() {
  const t = testApp();
  const ev = Number(t.db.run("INSERT INTO events (name, start_date) VALUES ('Diko', '2026-11-13')").lastInsertRowid);
  const cookie = await loginAs(t.app, t.db, ["schedule"]);
  return { ...t, ev, cookie };
}
const upload = (csv: string) => {
  const body = new FormData();
  body.set("csv", new File([csv], "plan.csv", { type: "text/csv" }));
  return body;
};

test("upload shows a preview, confirm imports and recalculates; export round-trips", async () => {
  const { app, db, ev, cookie } = await setup();
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind) VALUES (?, '2026-11-13', '10:00', '11:00', 'Alt', 'agenda')`, [ev]);
  const preview = await app.request(`/admin/events/${ev}/items/import`, { method: "POST", body: upload(CSV), headers: { cookie, origin: "http://localhost" } });
  const html = await preview.text();
  expect(html).toContain("Vorschau: 5 Einträge");
  expect(html).toContain("Die 1 vorhandenen Einträge werden ersetzt.");
  expect(db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 }); // nothing saved yet

  expect((await post(app, `/admin/events/${ev}/items/import`, { confirm: "1", text: CSV }, cookie)).status).toBe(400); // replace not confirmed
  expect((await post(app, `/admin/events/${ev}/items/import`, { confirm: "1", replace: "1", text: CSV }, cookie)).status).toBe(302);
  expect(dayItems(db, ev, "2026-11-13").map((i) => `${i.title} ${i.start}-${i.end}${i.fixed ? " fest" : ""}`)).toEqual([
    "Begrüßung 09:00-09:30 fest", "Anträge; Teil 1 09:30-11:00", "Mittagessen 12:00-13:00 fest", "Wahlen 13:00-13:45",
  ]);

  const res = await app.request(`/admin/events/${ev}/items/export.csv`, { headers: { cookie } });
  expect(res.headers.get("content-type")).toContain("text/csv");
  // the raw bytes: res.text() drops a leading BOM, as the Fetch spec says
  const exported = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  expect(exported.startsWith("﻿Datum;Beginn;Dauer;Titel;Art;TOP;Raum;Ort;Zuständig;Beschreibung;Unterpunkt")).toBe(true);
  const again = scheduleFromCsv(exported.replace(/^﻿/, ""));
  expect(again.errors).toEqual([]);
  expect(again.rows.map((r) => [r.title, r.start, r.minutes])).toEqual(scheduleFromCsv(CSV).rows.map((r) => [r.title, r.start, r.minutes]));
});

test("import is refused once entries are done, and errors block the import", async () => {
  const { app, db, ev, cookie } = await setup();
  const bad = await app.request(`/admin/events/${ev}/items/import`, { method: "POST", body: upload("Datum;Dauer;Titel\nx;1;A"), headers: { cookie, origin: "http://localhost" } });
  expect(await bad.text()).toContain("Fehler in der Datei");
  db.run(`INSERT INTO items (event_id, date, start, "end", title, kind, done) VALUES (?, '2026-11-13', '10:00', '11:00', 'Alt', 'agenda', 1)`, [ev]);
  const res = await post(app, `/admin/events/${ev}/items/import`, { confirm: "1", replace: "1", text: CSV }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("schon erledigt");
  expect(db.query("SELECT title FROM items").all()).toEqual([{ title: "Alt" }]);
});

test("the Essen column carries a break's menu (several lines) through import and export; agenda rows ignore it", async () => {
  const { app, db, ev, cookie } = await setup();
  const csv = `Datum;Beginn;Dauer;Titel;Art;Essen\n13.11.2026;09:00;60;Begrüßung;;Kuchen\n13.11.2026;12:00;60;Mittagessen;Pause;"Spaghetti\nvegetarisch: Lasagne"\n`;
  expect((await post(app, `/admin/events/${ev}/items/import`, { confirm: "1", replace: "1", text: csv }, cookie)).status).toBe(302);
  expect(db.query("SELECT title, menu FROM items ORDER BY start").all()).toEqual([
    { title: "Begrüßung", menu: "" }, { title: "Mittagessen", menu: "Spaghetti\nvegetarisch: Lasagne" },
  ]);
  const exported = await (await app.request(`/admin/events/${ev}/items/export.csv`, { headers: { cookie } })).text();
  expect(scheduleFromCsv(exported.replace(/^﻿/, "")).rows.map((r) => r.menu)).toEqual(["", "Spaghetti\nvegetarisch: Lasagne"]);
});

test("impossible dates are rejected instead of crashing the schedule later", () => {
  const { errors } = scheduleFromCsv("Datum;Beginn;Dauer;Titel\n2026-13-45;09:00;30;A\n31.02.2026;09:00;30;B\n");
  expect(errors).toEqual([
    "Zeile 2: Datum „2026-13-45“ ist ungültig (z. B. 13.11.2026).",
    "Zeile 3: Datum „31.02.2026“ ist ungültig (z. B. 13.11.2026).",
  ]);
});
