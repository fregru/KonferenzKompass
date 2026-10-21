import type { Database } from "bun:sqlite";
import { can, type User } from "../auth";
import { PART_PERMS, type PreviewRow } from "../backup";
import { type Event } from "../db";
import { venues } from "../rooms";
import { dayLabel } from "../time";
import { AdminPage } from "./admin";

const statusLabel = { draft: "Entwurf", active: "aktiv", archived: "archiviert" };

/**
 * Export form (everything the user may export, all ticked; with `only` just that event and its venue) and the upload
 * for an import. `done` lists what the last import did.
 */
export function BackupPage({ db, user, only, error, done }: { db: Database; user: User; only?: Event; error?: string; done?: string[] }) {
  const may = (part: keyof typeof PART_PERMS) => can(user, PART_PERMS[part]);
  const events = db.query<Event, []>("SELECT * FROM events ORDER BY start_date DESC").all();
  const pick = (part: "settings" | "pages" | "users") => !only && may(part);
  return (
    <AdminPage db={db} user={user} title="Sicherung" error={error}>
      {done && (
        <section class="card">
          <h2>Import abgeschlossen</h2>
          {done.length === 0 ? (
            <p>Es wurde nichts übernommen.</p>
          ) : (
            <ul>
              {done.map((d) => (
                <li>{d}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <form method="get" action="/admin/sicherung/export" class="card backup">
        <h2>Exportieren</h2>
        <p class="muted">
          Eine JSON-Datei mit allem, was du auswählst – als Sicherung oder um Veranstaltungen und Orte in eine andere Installation zu übernehmen. Der
          Live-Stand und Anmeldungen sind nicht enthalten.
        </p>
        <p class="links">
          <button type="button" class="secondary" data-check="1">Alle auswählen</button>
          <button type="button" class="secondary" data-check="0">Keine</button>
        </p>
        {(may("settings") || may("pages") || may("users")) && (
          <fieldset>
            <legend>Allgemein</legend>
            {may("settings") && (
              <label>
                <input type="checkbox" name="settings" value="1" checked={pick("settings")} /> Erscheinungsbild (Titel, Logo, Farben, Startseite)
              </label>
            )}
            {may("pages") && (
              <label>
                <input type="checkbox" name="pages" value="1" checked={pick("pages")} /> Seiten (Namen, Texte, Impressum, Datenschutz)
              </label>
            )}
            {may("users") && (
              <label>
                <input type="checkbox" name="users" value="1" checked={pick("users")} /> Benutzer mit Rechten und Passwort-Hashes
                <span class="muted"> – die Datei dann sicher aufbewahren</span>
              </label>
            )}
          </fieldset>
        )}
        {may("venues") && venues(db).length > 0 && (
          <fieldset>
            <legend>Orte (Lageplan)</legend>
            {venues(db).map((v) => (
              <label>
                <input type="checkbox" name="venue" value={String(v.id)} checked={only ? only.venue_id === v.id : true} /> {v.name}
              </label>
            ))}
          </fieldset>
        )}
        {may("events") && events.length > 0 && (
          <fieldset>
            <legend>Veranstaltungen</legend>
            {events.map((e) => (
              <label>
                <input type="checkbox" name="event" value={String(e.id)} checked={only ? only.id === e.id : true} /> {e.name}
                <span class="muted"> · {dayLabel(e.start_date)} · {statusLabel[e.status]}</span>
              </label>
            ))}
            <label>
              <input type="checkbox" name="changes" value="1" checked /> mit Änderungsprotokoll
            </label>
          </fieldset>
        )}
        <button>Datei herunterladen</button>
      </form>
      <form method="post" action="/admin/sicherung/import" enctype="multipart/form-data" class="card">
        <h2>Importieren</h2>
        <p class="muted">
          Eine Sicherung oder einen Lageplan-Export hochladen. Danach siehst du, was in der Datei steckt, und wählst für jeden Teil aus, ob er
          angelegt, ersetzt oder übersprungen wird.
        </p>
        <label>
          Datei <input type="file" name="file" accept=".json,application/json" required />
        </label>
        <button>Hochladen und prüfen</button>
      </form>
    </AdminPage>
  );
}

/** What the file contains, with an action per part; posts the choices back with the file's token. */
export function ImportPreview({ db, user, rows, token, created }: { db: Database; user: User; rows: PreviewRow[]; token: string; created: string }) {
  const groups = [...new Set(rows.map((r) => r.group))];
  const when = created && !Number.isNaN(Date.parse(created)) ? new Date(created).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "";
  return (
    <AdminPage db={db} user={user} title="Import prüfen">
      <p>
        <a href="/admin/sicherung">← Sicherung</a>
      </p>
      {when && <p class="muted">Datei erstellt am {when}.</p>}
      {rows.length === 0 && <p>Die Datei enthält nichts, was sich importieren lässt.</p>}
      <form method="post" action={`/admin/sicherung/import/${token}`}>
        {groups.map((g) => (
          <section>
            <h2>{g}</h2>
            <table class="importplan">
              {rows
                .filter((r) => r.group === g)
                .map((r) => (
                  <tr>
                    <td>
                      <strong>{r.label}</strong>
                      <div class="muted">{r.state}</div>
                      {r.notes.map((n) => (
                        <div class="note">{n}</div>
                      ))}
                    </td>
                    <td class="c-actions">
                      {r.perm ? (
                        <select name={r.key} aria-label={`Aktion für ${r.label}`}>
                          {r.choices.map((ch) => (
                            <option value={ch.value}>{ch.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span class="muted">Keine Berechtigung</span>
                      )}
                    </td>
                  </tr>
                ))}
            </table>
          </section>
        ))}
        {rows.length > 0 && <button>Importieren</button>}
      </form>
    </AdminPage>
  );
}
