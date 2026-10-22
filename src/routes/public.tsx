import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { assetUrl } from "../assets";
import { sessionUser } from "../auth";
import { Layout } from "../views/layout";
import { getPage } from "../db";
import { MapPage } from "../views/map";
import { ContentPage, Contacts, Faq, Hero, LiveSection, liveEtag, QuickLinks } from "../views/public";

export function publicRoutes(db: Database, clock: () => number) {
  const r = new Hono();

  r.get("/", (c) => {
    const nowMs = clock();
    return c.html(
      <Layout db={db} active="start" hero={<Hero db={db} />} user={sessionUser(db, getCookie(c, "sid"))}>
        <div class="layout">
          <div class="maincol">
            <div id="live" data-etag={liveEtag(db, nowMs)}>
              <LiveSection db={db} nowMs={nowMs} />
            </div>
            <Faq db={db} />
          </div>
          <aside class="side">
            <Contacts db={db} />
            <QuickLinks db={db} />
          </aside>
        </div>
        <script src={assetUrl("live.js")} defer></script>
      </Layout>,
    );
  });

  r.get("/api/live", (c) => {
    const nowMs = clock();
    const etag = liveEtag(db, nowMs);
    c.header("ETag", etag);
    c.header("Cache-Control", "no-cache");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.html(<LiveSection db={db} nowMs={nowMs} />);
  });

  r.get("/p/:slug", (c) => {
    const page = getPage(db, c.req.param("slug"));
    if (!page || (!page.enabled && page.kind !== "legal")) return c.notFound();
    return c.html(
      <Layout db={db} title={page.title} active={page.slug} user={sessionUser(db, getCookie(c, "sid"))}>
        <div class="layout">
          <div class="maincol">
            {page.kind === "map" ? (
              <MapPage db={db} page={page} roomId={Number(c.req.query("raum")) || undefined} floorId={Number(c.req.query("etage")) || undefined}
                fromItem={Number(c.req.query("von")) || undefined}
                nowMs={clock()}
              />
            ) : (
              <ContentPage db={db} page={page} />
            )}
          </div>
          <aside class="side">
            <Contacts db={db} />
            <QuickLinks db={db} />
          </aside>
        </div>
      </Layout>,
    );
  });

  return r;
}
