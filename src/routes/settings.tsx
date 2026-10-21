import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AppEnv, User } from "../auth";
import { bump, getSettings, setSetting } from "../db";
import { releaseUploads, saveUpload, uploadedFile } from "../uploads";
import { AdminPage } from "../views/admin";
import { HERO_POSITIONS } from "../views/public";
import { form, requirePerm } from "./util";

const COLOR = /^#[0-9a-f]{6}$/i;
const IMAGES = ["logo", "favicon", "hero_image"] as const;
const IMAGE_LABELS = { logo: "Logo", favicon: "Favicon", hero_image: "Titelbild (Startseite)" };
const TEXTS = ["site_title", "org_name", "copyright"] as const;
const BLOCKS = [
  ["show_intro", "Einführung & FAQ"],
  ["show_schedule", "Zeitplan"],
  ["show_contact", "Kontakt"],
] as const;

function SettingsPage({ db, user, error }: { db: Database; user: User; error?: string }) {
  const s = getSettings(db);
  return (
    <AdminPage db={db} user={user} title="Einstellungen" error={error}>
      <form method="post" action="/admin/settings" enctype="multipart/form-data" class="card">
        <label>
          Seitentitel <input name="site_title" value={s.site_title} required />
        </label>
        <label>
          Organisation <input name="org_name" value={s.org_name} />
        </label>
        <label>
          Copyright-Text (leer = Organisation) <input name="copyright" value={s.copyright} />
        </label>
        <div class="cols">
          <label>
            Primärfarbe <input type="color" name="color_primary" value={s.color_primary} />
          </label>
          <label>
            Sekundärfarbe <input type="color" name="color_secondary" value={s.color_secondary} />
          </label>
        </div>
        <fieldset>
          <legend>Startseite</legend>
          {BLOCKS.map(([key, label]) => (
            <label>
              <input type="checkbox" name={key} value="1" checked={s[key] === "1"} /> {label} anzeigen
            </label>
          ))}
        </fieldset>
        {IMAGES.map((key) => (
          <fieldset>
            <legend>{IMAGE_LABELS[key]}</legend>
            {key === "hero_image" && (
              <p class="muted">Querformat, ca. 1600 px breit, JPG oder WebP, möglichst unter 300 KB. Ohne Bild erscheint eine Fläche in der Primärfarbe.</p>
            )}
            {s[key] && (
              <p>
                <img src={`/uploads/${s[key]}`} alt="" class="thumb" />
                <label>
                  <input type="checkbox" name={`remove_${key}`} value="1" /> entfernen
                </label>
              </p>
            )}
            <input type="file" name={key} accept=".png,.jpg,.jpeg,.webp,.ico,.svg" />
            {key === "hero_image" && (
              <label>
                Sichtbarer Bildausschnitt
                <select name="hero_position">
                  {HERO_POSITIONS.map(([value, text]) => (
                    <option value={value} selected={s.hero_position === value}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        ))}
        <button>Speichern</button>
      </form>
    </AdminPage>
  );
}

export function settingsRoutes(db: Database) {
  const r = new Hono<AppEnv>();
  r.use("/settings", requirePerm(db, "settings"));

  r.get("/settings", (c) => c.html(<SettingsPage db={db} user={c.get("user")} />));
  r.post("/settings", async (c) => {
    const f = await form(c);
    const fail = (error: string) => c.html(<SettingsPage db={db} user={c.get("user")} error={error} />, 400);
    if (!f.str("site_title")) return fail("Seitentitel fehlt.");
    for (const key of ["color_primary", "color_secondary"]) if (!COLOR.test(f.str(key))) return fail("Ungültige Farbe.");
    const heroPosition = f.str("hero_position") || "center";
    if (!HERO_POSITIONS.some(([v]) => v === heroPosition)) return fail("Ungültiger Bildausschnitt.");
    const files: Record<string, string> = {};
    try {
      for (const key of IMAGES) {
        const file = uploadedFile(f.body[key]);
        if (file) files[key] = await saveUpload(file);
      }
    } catch (e) {
      return fail((e as Error).message);
    }
    const before = getSettings(db);
    db.transaction(() => {
      for (const key of TEXTS) setSetting(db, key, f.str(key));
      for (const key of ["color_primary", "color_secondary"]) setSetting(db, key, f.str(key).toLowerCase());
      for (const [key] of BLOCKS) setSetting(db, key, f.str(key) ? "1" : "0");
      setSetting(db, "hero_position", heroPosition);
      for (const key of IMAGES) {
        if (files[key]) setSetting(db, key, files[key]);
        else if (f.str(`remove_${key}`)) setSetting(db, key, "");
      }
    })();
    releaseUploads(db, IMAGES.map((key) => before[key]));
    bump(db);
    return c.redirect("/admin/settings");
  });
  return r;
}
