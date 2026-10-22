import type { Database } from "bun:sqlite";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { activeEvent, contactsFor, faqFor, getSettings, itemsForEvent, linksFor, subItemsFor, type ItemRow, type Page } from "../db";
import { mapPage, roomMap, type Room } from "../rooms";
import { liveDay, liveInput } from "../live";
import { renderMarkdown } from "../markdown";
import { computeDay, plannedNowId, type LiveInput, type Row } from "../schedule";
import { addDays, berlinNow, dayLabel, eventNow, fmt, toMinutes } from "../time";
import { Icon } from "./icons";
import { itemLabel } from "./labels";
import { menuPages } from "./layout";
import { Place } from "./map";

/** Visible part of the title image: CSS background position and its name in the settings. */
export const HERO_POSITIONS = [
  ["top", "oben"],
  ["center", "Mitte"],
  ["bottom", "unten"],
] as const;

/** Welcome banner: event name, intro text and the optional title image. */
export function Hero({ db }: { db: Database }) {
  const s = getSettings(db);
  const event = activeEvent(db);
  const position = HERO_POSITIONS.some(([v]) => v === s.hero_position) ? s.hero_position : "center";
  const style = s.hero_image ? `background-image:url(/uploads/${s.hero_image});background-position:center ${position}` : undefined;
  return (
    <section class="hero" style={style}>
      <div class="hero-inner">
        <h1>{event?.name ?? s.site_title}</h1>
        {event && s.show_intro === "1" && event.intro && <div class="lead">{raw(renderMarkdown(event.intro))}</div>}
      </div>
    </section>
  );
}

/** Rooms of the event's venue, the map page (null when off) and the sub-points by parent. */
type Places = { rooms: Map<number, Room>; map: string | null; subs: Map<number, ItemRow[]> };

/** Parts joined with " · ", skipping empty ones. */
const dotted = (parts: (Child | false | null | undefined | "")[]) =>
  parts.filter(Boolean).map((p, i) => (
    <>
      {i > 0 && " · "}
      {p}
    </>
  ));
const hasPlace = (i: ItemRow) => i.room_id !== null || !!i.location;

/** Sub-points with their room, moved by the parent's delay (`shift` minutes). */
function SubList({ subs, places, shift = 0 }: { subs: ItemRow[]; places: Places; shift?: number }) {
  if (!subs.length) return null;
  return (
    <ul class="subs">
      {subs.map((s) => (
        <li>
          <span class="subtime">{fmt(toMinutes(s.start) + shift)}</span>
          <span>
            {itemLabel(s)}
            {hasPlace(s) && (
              <span class="sub">
                {" · "}
                <Place item={s} rooms={places.rooms} map={places.map} from={s.id} />
              </span>
            )}
            {s.show_responsible && s.responsible ? <span class="sub"> · {s.responsible}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What a meal break serves, one dish per line; nothing when no menu is entered. */
export function Menu({ item }: { item: Pick<ItemRow, "kind" | "menu"> }) {
  const dishes = item.kind === "break" ? item.menu.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  if (!dishes.length) return null;
  return (
    <ul class="dishes" aria-label="Essen">
      {dishes.map((d) => (
        <li>{d}</li>
      ))}
    </ul>
  );
}

function ScheduleRow({ item, row, places }: { item: ItemRow; row: Row; places: Places }) {
  const shifted = Math.abs(row.expectedStart - row.plannedStart) >= 5;
  const sub = dotted([
    hasPlace(item) && <Place item={item} rooms={places.rooms} map={places.map} from={item.id} />,
    item.show_responsible && item.responsible ? `Zuständig: ${item.responsible}` : "",
  ]);
  return (
    <li id={`e${item.id}`} class={`row ${row.status} ${item.kind}`}>
      <div class="time">
        {fmt(row.expectedStart)}
        {shifted && <s>{fmt(row.plannedStart)}</s>}
      </div>
      <div>
        <div class="title">
          {item.top_number && <span class="top">{item.top_number}</span>}
          {item.title}
          {row.status === "current" && <span class="tag">läuft</span>}
          {row.status === "current" && row.overrun && <span class="tag warn">überzogen</span>}
        </div>
        {row.status === "interrupted" && <div class="sub">Unterbrochen, geht nach der Pause weiter.</div>}
        {sub.length > 0 && <div class="sub">{sub}</div>}
        <Menu item={item} />
        {item.description && <div class="desc">{raw(renderMarkdown(item.description))}</div>}
        <SubList subs={places.subs.get(item.id) ?? []} places={places} shift={row.expectedStart - row.plannedStart} />
      </div>
    </li>
  );
}

/** "Morgen, 08:00 Uhr" / "Freitag, 13.11. · 09:00 Uhr" for an entry on a later day. */
function laterLabel(date: string, today: string, start: string) {
  return date === addDays(today, 1) ? `Morgen, ${start} Uhr` : `${dayLabel(date)} · ${start} Uhr`;
}

/** "4:59", "1:02:03"; negative values count up with a leading "+". Mirrored in public/site.js. */
const clock = (s: number) => {
  const a = Math.abs(s);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const mm = h ? `${h}:${String(m).padStart(2, "0")}` : String(m);
  return `${s < 0 ? "+" : ""}${mm}:${String(a % 60).padStart(2, "0")}`;
};

/** Whole minutes over, matching the timer (at least 1). */
const overMinutes = (ms: number) => {
  const n = Math.max(1, Math.floor(ms / 60_000));
  return `${n} ${n === 1 ? "Minute" : "Minuten"}`;
};

/** Countdown to the end of a pause, counting up once it is over; site.js ticks it every second. */
export function PauseTimer({ untilMs, nowMs }: { untilMs: number; nowMs: number }) {
  const left = Math.round((untilMs - nowMs) / 1000);
  return (
    <div class={`timer${left < 0 ? " over" : ""}`} role="timer" data-left={String(left)}>
      {clock(left)}
    </div>
  );
}

/**
 * The highlighted card above the schedule: what runs now and what follows. When nothing runs it announces
 * the next open entry (today or on a later day). `showNext` hides every "next" hint.
 */
function NowCard({ items, rows, now, nowMs, today, later, showNext, pause, places }: {
  items: ItemRow[]; rows: Row[]; now: number; nowMs: number; today: string; later: ItemRow | undefined; showNext: boolean; pause: LiveInput["pause"]; places: Places;
}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const current = rows.find((r) => r.status === "current");
  // Breaks are only shown in the schedule, never as "next".
  const ahead = rows
    .filter((r) => (r.status === "upcoming" || r.status === "interrupted") && byId.get(r.id)?.kind === "agenda")
    .sort((a, b) => a.expectedStart - b.expectedStart);
  const after = showNext && ahead[0] ? byId.get(ahead[0].id) : undefined;
  const nextLine = after && (
    <div class="next">
      <span>
        {ahead[0]!.status === "interrupted" ? "Danach geht es weiter mit: " : "Danach: "}
        {itemLabel(after, " · ")}
      </span>
      <b>ca. {fmt(ahead[0]!.expectedStart)}</b>
    </div>
  );
  if (pause) {
    const overMs = nowMs - pause.untilMs;
    return (
      <section class={`card now${overMs > 0 ? " over" : ""}`}>
        <div class="nowhead">
          <div>
            <div class="eyebrow">Gerade Pause</div>
            <h3>{pause.title}</h3>
            <div class="meta">
              seit {fmt(pause.start)} · {overMs > 0 ? "geplant bis" : "bis"} {fmt(pause.until)}
            </div>
          </div>
          <PauseTimer untilMs={pause.untilMs} nowMs={nowMs} />
        </div>
        {overMs > 0 && <div class="status">{overMinutes(overMs)} länger als geplant</div>}
        {nextLine}
      </section>
    );
  }
  if (!current) {
    if (!showNext) return null;
    const nextToday = ahead[0] && byId.get(ahead[0].id);
    const it = nextToday ?? later;
    if (!it) return null;
    const when = nextToday ? `um ${fmt(ahead[0]!.expectedStart)} Uhr` : laterLabel(it.date, today, it.start);
    return (
      <section class="card now">
        <div class="eyebrow">Als Nächstes</div>
        <h3>{itemLabel(it, " · ")}</h3>
        <div class="meta">{dotted([when, hasPlace(it) && <Place item={it} rooms={places.rooms} map={places.map} from={it.id} />])}</div>
        <SubList subs={places.subs.get(it.id) ?? []} places={places} shift={nextToday ? ahead[0]!.expectedStart - ahead[0]!.plannedStart : 0} />
      </section>
    );
  }
  const it = byId.get(current.id)!;
  const over = current.overrun;
  return (
    <section class={`card now${over ? " over" : ""}`}>
      <div class="eyebrow">Jetzt</div>
      <h3>{itemLabel(it, " · ")}</h3>
      <div class="meta">
        {dotted([
          hasPlace(it) && <Place item={it} rooms={places.rooms} map={places.map} from={it.id} />,
          `seit ${fmt(current.expectedStart)}`,
          `${over ? "geplant bis" : "bis ca."} ${fmt(current.dueEnd)}`,
        ])}
      </div>
      {over && <div class="status">{now - current.dueEnd} Minuten länger als geplant</div>}
      <SubList subs={places.subs.get(it.id) ?? []} places={places} shift={current.expectedStart - current.plannedStart} />
      {nextLine}
    </section>
  );
}

/** The part of the start page that /api/live re-renders. */
export function LiveSection({ db, nowMs }: { db: Database; nowMs: number }) {
  const s = getSettings(db);
  const event = activeEvent(db);
  if (!event) return <p class="card empty">Aktuell ist keine Veranstaltung geplant.</p>;
  if (s.show_schedule !== "1") return null;
  const items = itemsForEvent(db, event.id);
  const now = eventNow(new Date(nowMs));
  const days = [...new Set(items.map((i) => i.date))];
  const liveIn = liveInput(db, event.id, nowMs);
  const active = liveDay(items, liveIn, now.date);
  const openDay = days.includes(active) ? active : (days.find((d) => d >= now.date) ?? days.at(-1));
  const computed = days.map((d) => {
    const dayItems = items.filter((i) => i.date === d);
    const input = dayItems.map((i) => ({ ...i, done: !!i.done }));
    const isToday = d === now.date;
    const live = d === active ? liveIn : null;
    const rows = computeDay(input, live, now.minutes);
    const current = rows.find((r) => r.status === "current");
    const planId = isToday ? plannedNowId(input, now.minutes) : null;
    const planItem = planId !== null && planId !== current?.id ? dayItems.find((i) => i.id === planId) : undefined;
    return { d, dayItems, rows, isToday, isActive: d === active, planItem, pause: live?.pause ?? null };
  });
  const today = computed.find((c) => c.isActive);
  const later = items.find((i) => i.date > now.date && !i.done && i.kind === "agenda");
  const places: Places = { rooms: roomMap(db, event.venue_id), map: mapPage(db), subs: subItemsFor(db, event.id) };
  return (
    <>
      <NowCard
        items={today?.dayItems ?? []}
        rows={today?.rows ?? []}
        now={now.minutes}
        nowMs={nowMs}
        today={now.date}
        later={later}
        showNext={s.show_next !== "0"}
        pause={today?.pause ?? null}
        places={places}
      />
      <section>
        <h2>Zeitplan</h2>
        {items.length === 0 && <p class="card empty">Der Zeitplan folgt.</p>}
        {computed.map(({ d, dayItems, rows, planItem }) => (
          <details class="card day" open={d === openDay}>
            <summary>{dayLabel(d)}</summary>
            {planItem && (
              <p class="plan">
                Laut Plan wäre jetzt: <strong>{itemLabel(planItem, " · ")}</strong>
              </p>
            )}
            <ol class="schedule">
              {rows.map((r, idx) => (
                <ScheduleRow item={dayItems[idx]!} row={r} places={places} />
              ))}
            </ol>
          </details>
        ))}
        <p class="stand">Stand {fmt(now.minutes)} Uhr · aktualisiert sich automatisch</p>
      </section>
    </>
  );
}

export const liveEtag = (db: Database, nowMs: number) => {
  const t = berlinNow(new Date(nowMs));
  return `W/"${getSettings(db).version}-${t.date}-${t.minutes}"`;
};

export function Faq({ db }: { db: Database }) {
  const event = activeEvent(db);
  if (!event || getSettings(db).show_intro !== "1") return null;
  const faq = faqFor(db, event.id);
  if (faq.length === 0) return null;
  return (
    <section>
      <h2>Häufige Fragen</h2>
      <div class="card faq">
        {faq.map((f) => (
          <details>
            <summary>{f.question}</summary>
            <div class="answer">{raw(renderMarkdown(f.answer))}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function Contacts({ db }: { db: Database }) {
  const event = activeEvent(db);
  if (!event || getSettings(db).show_contact !== "1") return null;
  const contacts = contactsFor(db, event.id);
  if (contacts.length === 0) return null;
  return (
    <section>
      <h2>{contacts.length > 1 ? "Ansprechpersonen" : "Ansprechperson"}</h2>
      <div class="contacts">
        {contacts.map((p) => (
          <div class="card contact">
            {p.photo ? <img src={`/uploads/${p.photo}`} alt={`Foto von ${p.name}`} class="avatar" /> : <div class="avatar">{initials(p.name)}</div>}
            <div>
              <strong>{p.name}</strong>
              {p.role && <div class="muted">{p.role}</div>}
              {p.phone && (
                <a class="contact-line" href={`tel:${p.phone.replace(/[^+\d]/g, "")}`}>
                  <Icon name="phone" />
                  {p.phone}
                </a>
              )}
              {p.email && (
                <a class="contact-line" href={`mailto:${p.email}`}>
                  <Icon name="mail" />
                  {p.email}
                </a>
              )}
              {p.messenger && (
                <div class="actions">
                  <a class="btn" href={p.messenger} rel="noopener">
                    <Icon name="chat" />
                    Messenger
                  </a>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ContentPage({ db, page }: { db: Database; page: Page }) {
  const event = activeEvent(db);
  const links = page.kind === "link" && event ? linksFor(db, event.id).filter((l) => l.page_slug === page.slug) : [];
  return (
    <article class="card page">
      <h1>{page.title}</h1>
      {page.body && <div class="prose">{raw(renderMarkdown(page.body))}</div>}
      {links.length > 0 && (
        <div class="linklist">
          {links.map((l) => (
            <a class="card linkcard" href={l.url} target="_blank" rel="noopener">
              <span>{l.label}</span>
              <Icon name="external" />
            </a>
          ))}
        </div>
      )}
      {page.kind === "link" && links.length === 0 && !page.body && <p class="muted">Hier gibt es noch nichts.</p>}
    </article>
  );
}

/** "Als App installieren" on the start page; site.js shows it only where the browser can install (or on iOS). */
export function InstallHint() {
  return (
    <section class="card installhint" hidden>
      <p>
        <strong>Als App installieren</strong> – mit eigenem Symbol auf dem Startbildschirm und auch ohne Netz nutzbar.
        <span class="ios" hidden>
          {" "}
          Dazu in Safari auf <Icon name="share" /> <em>Teilen</em> tippen, dann <em>Zum Home-Bildschirm</em>.
        </span>
      </p>
      <div class="actions">
        <button type="button" data-install hidden>
          Installieren
        </button>
        <button type="button" class="secondary" data-dismiss>
          Nicht jetzt
        </button>
      </div>
    </section>
  );
}

/** Desktop sidebar shortcut list to the content pages (hidden on phones, where the menu covers it). */
export function QuickLinks({ db }: { db: Database }) {
  const pages = menuPages(db);
  if (pages.length === 0) return null;
  return (
    <section class="quicklinks">
      <h2>Schnellzugriff</h2>
      <div class="card">
        {pages.map(({ page, href, external }) => (
          <a href={href} {...(external ? { target: "_blank", rel: "noopener" } : {})}>
            <span>{page.title}</span>
            {external ? <Icon name="external" /> : <span aria-hidden="true">›</span>}
          </a>
        ))}
      </div>
    </section>
  );
}
