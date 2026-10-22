import type { Database } from "bun:sqlite";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { assetUrl, serviceWorkerOff } from "../assets";
import type { User } from "../auth";
import { darkColor } from "../color";
import { activeEvent, getPages, getSettings, linksFor, type Page, type PageLink } from "../db";
import { Icon } from "./icons";

/** Darkmode switch in the footer; "auto" follows the device. */
const THEMES = [
  ["light", "Hell", "sun"],
  ["auto", "Automatisch", null],
  ["dark", "Dunkel", "moon"],
] as const;

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
      {/* data-stand: when this page was built; a copy from the service worker's cache shows its real age offline */}
      <html lang="de" data-stand={String(Date.now())} data-sw={serviceWorkerOff() ? "off" : undefined}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <title>{title ? `${title} – ${s.site_title}` : s.site_title}</title>
          {s.favicon && <link rel="icon" href={`/uploads/${s.favicon}`} />}
          <link rel="manifest" href="/manifest.webmanifest" />
          {/* iOS takes the home screen icon from here (PNG only), not from the manifest; else a PNG tab icon */}
          {(s.app_icon || s.favicon?.endsWith(".png")) && <link rel="apple-touch-icon" href={`/uploads/${s.app_icon || s.favicon}`} />}
          {/* browser bar in the header's colour */}
          <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content="#0e1215" media="(prefers-color-scheme: dark)" />
          <script src={assetUrl("theme.js")}></script>
          <link rel="stylesheet" href={assetUrl("style.css")} />
          <script src={assetUrl("site.js")} defer></script>
          <style>
            {`:root{--primary-l:${s.color_primary};--secondary-l:${s.color_secondary};` +
              `--primary-d:${darkColor(s.color_primary!, s.color_primary_dark)};--secondary-d:${darkColor(s.color_secondary!, s.color_secondary_dark)}}`}
          </style>
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
            {/* filled and shown by site.js; inside the sticky header so it stays in view */}
            <div class="offlinebar" hidden>
              <p role="status"></p>
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
              {/* shown and wired up by theme.js */}
              <fieldset class="themeswitch" hidden>
                <legend>Design</legend>
                {THEMES.map(([value, label, icon]) => (
                  <label>
                    <input type="radio" name="theme" value={value} />
                    {icon && <Icon name={icon} />}
                    {label}
                  </label>
                ))}
              </fieldset>
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
