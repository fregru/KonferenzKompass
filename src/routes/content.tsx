import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import type { AppEnv, User } from "../auth";
import { activeEvent, bump, contactsFor, faqFor, getEvent, getPage, getPages, linksFor, type Contact, type Event, type Page } from "../db";
import { safeUrl } from "../markdown";
import { releaseUploads, saveUpload, uploadedFile } from "../uploads";
import { AdminPage } from "../views/admin";
import { editableEvent } from "./events";
import { form, requirePerm } from "./util";

const BAD_URL = "Nur http(s)-Links erlaubt.";

/** /admin/<area> → the active event's page for that area. */
function toActive(db: Database, area: string, title: string) {
  return (c: Context<AppEnv>) => {
    const ev = activeEvent(db);
    if (ev) return c.redirect(`/admin/events/${ev.id}/${area}`);
    return c.html(
      <AdminPage db={db} user={c.get("user")} title={title}>
        <p>Es ist keine Veranstaltung aktiv.</p>
      </AdminPage>,
    );
  };
}

// ---------- intro & FAQ ----------

function IntroPage({ db, user, event, error }: { db: Database; user: User; event: Event; error?: string }) {
  const readonly = event.status === "archived";
  return (
    <AdminPage db={db} user={user} title={`Einführung & FAQ: ${event.name}`} error={error}>
      <form method="post" action={`/admin/events/${event.id}/intro`} class="card">
        <h2>Begrüßung</h2>
        <label>
          Kurzer Einführungstext auf der Startseite (Markdown)
          <textarea name="intro" rows={4} disabled={readonly}>{event.intro}</textarea>
        </label>
        {!readonly && <button>Speichern</button>}
      </form>
      <h2>Häufige Fragen</h2>
      {faqFor(db, event.id).map((f) => (
        <form method="post" action={`/admin/faq/${f.id}`} class="card">
          <label>
            Frage <input name="question" value={f.question} disabled={readonly} required />
          </label>
          <label>
            Antwort (Markdown) <textarea name="answer" rows={3} disabled={readonly} required>{f.answer}</textarea>
          </label>
          <label>
            Reihenfolge <input type="number" name="sort" value={String(f.sort)} disabled={readonly} />
          </label>
          {!readonly && (
            <p class="actions">
              <button>Speichern</button>
              <button class="danger" formaction={`/admin/faq/${f.id}/delete`} formnovalidate>
                Löschen
              </button>
            </p>
          )}
        </form>
      ))}
      {!readonly && (
        <form method="post" action={`/admin/events/${event.id}/faq`} class="card">
          <h3>Neue Frage</h3>
          <label>
            Frage <input name="question" required />
          </label>
          <label>
            Antwort (Markdown) <textarea name="answer" rows={3} required></textarea>
          </label>
          <button>Hinzufügen</button>
        </form>
      )}
    </AdminPage>
  );
}

// ---------- contacts ----------

function ContactFields({ p }: { p?: Partial<Contact> }) {
  return (
    <>
      <label>
        Name <input name="name" value={p?.name ?? ""} required />
      </label>
      <label>
        Rolle <input name="role" value={p?.role ?? ""} />
      </label>
      <div class="cols">
        <label>
          Telefon <input type="tel" name="phone" value={p?.phone ?? ""} />
        </label>
        <label>
          E-Mail <input type="email" name="email" value={p?.email ?? ""} />
        </label>
      </div>
      <label>
        Messenger-Link (z. B. Signal/WhatsApp, https://…) <input name="messenger" value={p?.messenger ?? ""} />
      </label>
      <label>
        Foto <input type="file" name="photo" accept=".png,.jpg,.jpeg,.webp" />
      </label>
      <p class="muted">Foto nur mit Einverständnis der Person hochladen.</p>
    </>
  );
}

function ContactsPage({ db, user, event, error }: { db: Database; user: User; event: Event; error?: string }) {
  const readonly = event.status === "archived";
  return (
    <AdminPage db={db} user={user} title={`Kontakte: ${event.name}`} error={error}>
      {contactsFor(db, event.id).map((p) => (
        <form method="post" action={`/admin/contacts/${p.id}`} enctype="multipart/form-data" class="card">
          {p.photo && <img src={`/uploads/${p.photo}`} alt="" class="thumb" />}
          <fieldset class="bare" disabled={readonly}>
            <ContactFields p={p} />
            {p.photo && (
              <label>
                <input type="checkbox" name="remove_photo" value="1" /> Foto entfernen
              </label>
            )}
          </fieldset>
          {!readonly && (
            <p>
              <button>Speichern</button>{" "}
              <button class="danger" formaction={`/admin/contacts/${p.id}/delete`}>
                Löschen
              </button>
            </p>
          )}
        </form>
      ))}
      {!readonly && (
        <form method="post" action={`/admin/events/${event.id}/contacts`} enctype="multipart/form-data" class="card">
          <h2>Neuer Kontakt</h2>
          <ContactFields />
          <button>Hinzufügen</button>
        </form>
      )}
    </AdminPage>
  );
}

async function contactFields(c: Context<AppEnv>) {
  const f = await form(c);
  const v = { name: f.str("name"), role: f.str("role"), phone: f.str("phone"), email: f.str("email"), messenger: f.str("messenger") };
  if (!v.name) throw new Error("Name fehlt.");
  if (v.messenger && !safeUrl(v.messenger)) throw new Error(BAD_URL);
  if (v.email && !/^[^\s@<>"]+@[^\s@<>"]+$/.test(v.email)) throw new Error("Ungültige E-Mail-Adresse.");
  const file = uploadedFile(f.body.photo);
  const photo = file ? await saveUpload(file) : f.str("remove_photo") ? "" : null;
  return { ...v, photo };
}

// ---------- pages ----------

function PagesPage({ db, user }: { db: Database; user: User }) {
  return (
    <AdminPage db={db} user={user} title="Seiten">
      <table>
        <tr>
          <th>Seite</th>
          <th>Sichtbar</th>
          <th>Reihenfolge</th>
        </tr>
        {getPages(db).map((p) => (
          <tr>
            <td>
              <a href={`/admin/pages/${p.slug}`}>{p.title}</a>
            </td>
            <td>{p.kind === "legal" ? "immer" : p.enabled ? "ja" : "nein"}</td>
            <td>{p.sort}</td>
          </tr>
        ))}
      </table>
    </AdminPage>
  );
}

function PageEdit({ db, user, page, error }: { db: Database; user: User; page: Page; error?: string }) {
  const event = activeEvent(db);
  const links = page.kind === "link" && event ? linksFor(db, event.id).filter((l) => l.page_slug === page.slug) : [];
  return (
    <AdminPage db={db} user={user} title={`Seite: ${page.title}`} error={error}>
      <p>
        <a href="/admin/pages">← Alle Seiten</a> · <a href={`/p/${page.slug}`}>Ansehen</a>
      </p>
      <form method="post" action={`/admin/pages/${page.slug}`} class="card">
        <label>
          Name im Menü <input name="title" value={page.title} required />
        </label>
        {page.kind !== "legal" && (
          <label>
            <input type="checkbox" name="enabled" value="1" checked={!!page.enabled} /> Seite anzeigen
          </label>
        )}
        <label>
          Reihenfolge <input type="number" name="sort" value={String(page.sort)} />
        </label>
        <label>
          Text (Markdown) <textarea name="body" rows={10}>{page.body}</textarea>
        </label>
        {page.kind === "link" && (
          <label>
            <input type="checkbox" name="direct" value="1" checked={!!page.direct} /> Direkt verlinken (Menüeintrag öffnet den
            Link, wenn es genau einen gibt)
          </label>
        )}
        <button>Speichern</button>
      </form>
      {page.kind === "link" && (
        <section class="card">
          <h2>Links{event ? ` für ${event.name}` : ""}</h2>
          {!event && <p>Es ist keine Veranstaltung aktiv. Links gehören zur aktiven Veranstaltung.</p>}
          {links.map((l) => (
            <form method="post" action={`/admin/links/${l.id}/delete`} class="linkrow">
              <a href={l.url} target="_blank" rel="noopener">
                {l.label}
              </a>
              <button class="secondary">Entfernen</button>
            </form>
          ))}
          {event && (
            <form method="post" action={`/admin/pages/${page.slug}/links`}>
              <div class="cols">
                <label>
                  Beschriftung <input name="label" placeholder="z. B. Zur Nextcloud" required />
                </label>
                <label>
                  URL <input type="url" name="url" placeholder="https://…" required />
                </label>
              </div>
              <button>Link hinzufügen</button>
            </form>
          )}
        </section>
      )}
    </AdminPage>
  );
}

export function contentRoutes(db: Database) {
  const r = new Hono<AppEnv>();
  const eventOf = (table: "faq" | "contacts" | "page_links", id: string) =>
    db.query<{ event_id: number; id: number }, [string]>(`SELECT id, event_id FROM ${table} WHERE id = ?`).get(id);
  const photoOf = (id: number) => db.query<{ photo: string }, [number]>("SELECT photo FROM contacts WHERE id = ?").get(id)?.photo;

  // --- intro & FAQ (perm: intro) ---
  for (const p of ["/intro", "/faq/*", "/events/:id/intro", "/events/:id/faq"]) r.use(p, requirePerm(db, "intro"));
  r.get("/intro", toActive(db, "intro", "Einführung & FAQ"));
  r.get("/events/:id/intro", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    return ev ? c.html(<IntroPage db={db} user={c.get("user")} event={ev} />) : c.notFound();
  });
  r.post("/events/:id/intro", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    db.run("UPDATE events SET intro = ? WHERE id = ?", [(await form(c)).str("intro"), ev.id]);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/intro`);
  });
  const faqValues = async (c: Context<AppEnv>) => {
    const f = await form(c);
    return { question: f.str("question"), answer: f.str("answer"), sort: Number.parseInt(f.str("sort"), 10) || 0 };
  };
  const FAQ_MISSING = "Bitte Frage und Antwort angeben.";
  r.post("/events/:id/faq", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    const v = await faqValues(c);
    if (!v.question || !v.answer) return c.html(<IntroPage db={db} user={c.get("user")} event={ev} error={FAQ_MISSING} />, 400);
    const sort = v.sort || faqFor(db, ev.id).length + 1;
    db.run("INSERT INTO faq (event_id, question, answer, sort) VALUES (?, ?, ?, ?)", [ev.id, v.question, v.answer, sort]);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/intro`);
  });
  r.post("/faq/:id", async (c) => {
    const row = eventOf("faq", c.req.param("id"));
    if (!row) return c.notFound();
    const ev = await editableEvent(db, c, row.event_id);
    if (ev instanceof Response) return ev;
    const v = await faqValues(c);
    if (!v.question || !v.answer) return c.html(<IntroPage db={db} user={c.get("user")} event={ev} error={FAQ_MISSING} />, 400);
    db.run("UPDATE faq SET question = ?, answer = ?, sort = ? WHERE id = ?", [v.question, v.answer, v.sort, row.id]);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/intro`);
  });
  r.post("/faq/:id/delete", async (c) => {
    const row = eventOf("faq", c.req.param("id"));
    if (!row) return c.notFound();
    const ev = await editableEvent(db, c, row.event_id);
    if (ev instanceof Response) return ev;
    db.run("DELETE FROM faq WHERE id = ?", [row.id]);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/intro`);
  });

  // --- contacts (perm: settings) ---
  for (const p of ["/contacts", "/contacts/*", "/events/:id/contacts"]) r.use(p, requirePerm(db, "settings"));
  r.get("/contacts", toActive(db, "contacts", "Kontakte"));
  r.get("/events/:id/contacts", (c) => {
    const ev = getEvent(db, c.req.param("id"));
    return ev ? c.html(<ContactsPage db={db} user={c.get("user")} event={ev} />) : c.notFound();
  });
  r.post("/events/:id/contacts", async (c) => {
    const ev = await editableEvent(db, c, c.req.param("id"));
    if (ev instanceof Response) return ev;
    try {
      const v = await contactFields(c);
      db.run("INSERT INTO contacts (event_id, name, role, phone, email, messenger, photo) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [ev.id, v.name, v.role, v.phone, v.email, v.messenger, v.photo ?? ""]);
    } catch (e) {
      return c.html(<ContactsPage db={db} user={c.get("user")} event={ev} error={(e as Error).message} />, 400);
    }
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/contacts`);
  });
  r.post("/contacts/:id", async (c) => {
    const row = eventOf("contacts", c.req.param("id"));
    if (!row) return c.notFound();
    const ev = await editableEvent(db, c, row.event_id);
    if (ev instanceof Response) return ev;
    try {
      const v = await contactFields(c);
      db.run("UPDATE contacts SET name = ?, role = ?, phone = ?, email = ?, messenger = ? WHERE id = ?",
        [v.name, v.role, v.phone, v.email, v.messenger, row.id]);
      if (v.photo !== null) {
        const old = photoOf(row.id);
        db.run("UPDATE contacts SET photo = ? WHERE id = ?", [v.photo, row.id]);
        releaseUploads(db, [old]);
      }
    } catch (e) {
      return c.html(<ContactsPage db={db} user={c.get("user")} event={ev} error={(e as Error).message} />, 400);
    }
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/contacts`);
  });
  r.post("/contacts/:id/delete", async (c) => {
    const row = eventOf("contacts", c.req.param("id"));
    if (!row) return c.notFound();
    const ev = await editableEvent(db, c, row.event_id);
    if (ev instanceof Response) return ev;
    const photo = photoOf(row.id);
    db.run("DELETE FROM contacts WHERE id = ?", [row.id]);
    releaseUploads(db, [photo]);
    bump(db);
    return c.redirect(`/admin/events/${ev.id}/contacts`);
  });

  // --- pages & links (perm: pages) ---
  for (const p of ["/pages", "/pages/*", "/links/*"]) r.use(p, requirePerm(db, "pages"));
  r.get("/pages", (c) => c.html(<PagesPage db={db} user={c.get("user")} />));
  r.get("/pages/:slug", (c) => {
    const page = getPage(db, c.req.param("slug"));
    return page ? c.html(<PageEdit db={db} user={c.get("user")} page={page} />) : c.notFound();
  });
  r.post("/pages/:slug", async (c) => {
    const page = getPage(db, c.req.param("slug"));
    if (!page) return c.notFound();
    const f = await form(c);
    const title = f.str("title");
    if (!title) return c.html(<PageEdit db={db} user={c.get("user")} page={page} error="Name fehlt." />, 400);
    db.run("UPDATE pages SET title = ?, enabled = ?, sort = ?, body = ?, direct = ? WHERE slug = ?", [
      title,
      page.kind === "legal" || f.str("enabled") ? 1 : 0,
      Number.parseInt(f.str("sort"), 10) || 0,
      f.body.body === undefined ? page.body : f.str("body"),
      f.str("direct") ? 1 : 0,
      page.slug,
    ]);
    bump(db);
    return c.redirect(`/admin/pages/${page.slug}`);
  });
  r.post("/pages/:slug/links", async (c) => {
    const page = getPage(db, c.req.param("slug"));
    if (!page || page.kind !== "link") return c.notFound();
    const ev = activeEvent(db);
    if (!ev) return c.redirect(`/admin/pages/${page.slug}`);
    const f = await form(c);
    const url = safeUrl(f.str("url"));
    const fail = (error: string) => c.html(<PageEdit db={db} user={c.get("user")} page={page} error={error} />, 400);
    if (!f.str("label")) return fail("Beschriftung fehlt.");
    if (!url) return fail(BAD_URL);
    db.run("INSERT INTO page_links (event_id, page_slug, label, url) VALUES (?, ?, ?, ?)", [ev.id, page.slug, f.str("label"), url]);
    bump(db);
    return c.redirect(`/admin/pages/${page.slug}`);
  });
  r.post("/links/:id/delete", async (c) => {
    const row = db.query<{ id: number; page_slug: string; event_id: number }, [string]>("SELECT id, page_slug, event_id FROM page_links WHERE id = ?").get(c.req.param("id"));
    if (!row) return c.notFound();
    const ev = await editableEvent(db, c, row.event_id);
    if (ev instanceof Response) return ev;
    db.run("DELETE FROM page_links WHERE id = ?", [row.id]);
    bump(db);
    return c.redirect(`/admin/pages/${row.page_slug}`);
  });

  return r;
}
