import type { Database } from "bun:sqlite";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { User } from "../auth";
import { activeEvent, getPages, getSettings, linksFor, type Page, type PageLink } from "../db";

/** A "direct" link page with exactly one link jumps straight to the external site. */
export function pageTarget(p: Page, links: PageLink[]): { href: string; external: boolean } {
  const own = links.filter((l) => l.page_slug === p.slug);
  return p.kind === "link" && p.direct && own.length === 1 ? { href: own[0]!.url, external: true } : { href: `/p/${p.slug}`, external: false };
}

/** Enabled pages for menus, in their configured order. */
export function menuPages(db: Database) {
  const event = activeEvent(db);
  const links = event ? linksFor(db, event.id) : [];
  return getPages(db)
    .filter((p) => p.enabled && p.kind !== "legal")
    .map((p) => ({ page: p, ...pageTarget(p, links) }));
}

/** `active` is "start", "admin" or a page slug; `hero` renders full width between header and content; `user` adds the admin link. */
export function Layout({ db, title, active, hero, user, children }: { db: Database; title?: string; active?: string; hero?: Child; user?: User | null; children?: Child }) {
  const s = getSettings(db);
  const nav = menuPages(db);
  const legal = getPages(db).filter((p) => p.kind === "legal");
  const current = (key: string) => (active === key ? "page" : undefined);
  const navLink = ({ page, href, external }: (typeof nav)[number]) =>
    external ? (
      <a href={href} target="_blank" rel="noopener">
        {page.title} ↗
      </a>
    ) : (
      <a href={href} aria-current={current(page.slug)}>
        {page.title}
      </a>
    );
  const links = (
    <>
      <a href="/" aria-current={current("start")}>
        Start
      </a>
      {nav.map(navLink)}
      {user && (
        <a href="/admin" aria-current={current("admin")}>
          Admin
        </a>
      )}
    </>
  );
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <title>{title ? `${title} – ${s.site_title}` : s.site_title}</title>
          {s.favicon && <link rel="icon" href={`/uploads/${s.favicon}`} />}
          <link rel="stylesheet" href="/static/style.css" />
          <script src="/static/site.js" defer></script>
          <style>{`:root{--primary:${s.color_primary};--secondary:${s.color_secondary}}`}</style>
        </head>
        <body>
          <header>
            <div class="bar">
              <div class="headrow">
                <a class="brand" href="/">
                  {s.logo ? <img src={`/uploads/${s.logo}`} alt="" /> : <span class="logo">{(s.site_title || "D").slice(0, 1)}</span>}
                  <span>{s.site_title}</span>
                </a>
                {(nav.length > 0 || user) && (
                  <details class="menu">
                    <summary>
                      <span class="burger" aria-hidden="true"></span>
                      Menü
                    </summary>
                    <nav class="menu-list" aria-label="Hauptmenü">
                      {links}
                    </nav>
                  </details>
                )}
              </div>
              {(nav.length > 0 || user) && (
                <nav class="tabs" aria-label="Hauptmenü">
                  {links}
                </nav>
              )}
            </div>
          </header>
          {hero}
          <main>{children}</main>
          <footer>
            <div class="bar">
              <div>
                {legal.map((p) => (
                  <a href={`/p/${p.slug}`}>{p.title}</a>
                ))}
              </div>
              <span>
                © {new Date().getFullYear()} {s.copyright || s.org_name}
              </span>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}
