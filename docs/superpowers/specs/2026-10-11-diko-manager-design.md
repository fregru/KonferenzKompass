# Diko Manager – Design & Plan

> **Historical document.** This is the original design from 2026-10-11. Since then the Lageplan (§9) was built, news were replaced by intro and FAQ, and the code layout differs from §10 (`src/app.tsx`, `src/routes/`, `src/views/`). The README describes the current behaviour; open ideas are in [ROADMAP.md](../../../ROADMAP.md).

Status: decisions settled, awaiting final review (2026-10-11). Source of requirements: [README.md](../../../README.md).

## 1. Goal

A light, mobile-first website for one event (Diözesankonferenz / Mitgliederversammlung) that links all documents and tools and shows a **live schedule**. One installation per organization, branded via the admin area. German only. Must work on weak Wi-Fi (Haus Altenberg) and be trivial to run and maintain.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun** (TypeScript, no build step) | Runs TS directly, built-in SQLite + password hashing → almost no dependencies |
| Server | **Hono** with server-rendered JSX | Tiny, standard Web APIs, HTML from the server = fast on slow networks |
| Database | **SQLite** (`bun:sqlite`), one file in `data/` | No DB server; backup = copy `data/` |
| Client JS | Small plain JS file for live polling + admin conveniences | No frontend framework needed |
| Styling | One hand-written CSS file, theme colors as CSS variables (from settings) | KjG-Köln look by default, recolorable per org |
| Markdown | `marked` with raw HTML **disabled/escaped** | Editable texts without XSS |
| Deploy | `docker compose up -d` (one container + `data/` volume) **or** `bun run start` directly | Docker optional |

Dependencies: `hono`, `marked`. That's it.

Alternatives considered: SvelteKit (more tooling, build step), PocketBase (its generic admin UI is too technical for non-technical editors and doesn't map well to "this account may only edit the schedule").

## 3. Pages (public)

All pages: on/off toggle + editable menu name + order. Menu hides disabled pages; if only the start page remains, the menu is hidden.

| Page | Content |
|---|---|
| Startseite | News (top) → live schedule → contact card. Each block toggleable. |
| Unterlagen, Anträge, Wahlen | Generic **link page**: title, short Markdown text, button(s) to external URL (Nextcloud, Antragsgrün, OpenSlides/VotesUp). Per-page option: show this page, or let the menu entry link directly to the external site. |
| Hilfe & Service | Free Markdown page |
| Impressum, Datenschutz | Markdown pages, linked in footer (always on, legally required) |
| Lageplan | **Out of scope for now** (see §9) |

Footer: Impressum · Datenschutz · © year + organization name (editable).

## 4. Live schedule

### Data per item
`date`, `planned_start`, `planned_end`, `title`, `description?` (Markdown), `location` (free text for now; later a room reference for the Lageplan), `responsible?` + `show_responsible` flag (per item), `kind` (`agenda` / `break` — breaks include short pauses, lunch, dinner), `top_number?` (e.g. "TOP 3"). Planned duration = `planned_end − planned_start`.

### Live state (one row per event)
`current_item_id`, `current_started_at`, and if an agenda item was interrupted by a break: `interrupted_item_id` + `interrupted_elapsed` (minutes already spent on it).

### Admin controls (mobile-first, big buttons)
- **Weiter** – next item starts now. If a break is current and an item was interrupted, *Weiter* resumes the interrupted item.
- **Zurück** – undo the last step (correct mistakes).
- **Pause jetzt** – interrupt the current agenda item and start the next scheduled break now.
- **Unplanmäßige Pause** – interrupt the current item with an ad-hoc break of a given length (e.g. 15 min). It is inserted into today's schedule (marked "unplanmäßig").
- Any entry (agenda or break) can be current.

### Expected times (one pure function, unit-tested)
Input: today's items in order, live state, server `now`. Walk forward with a `cursor`:
1. **Current item end:**
   - agenda: `max(now, current_started_at + remaining_duration)` (`remaining` = planned duration − `interrupted_elapsed` if resumed). If `now` is past that, the item shows "überzogen" and keeps pushing everything back.
   - break: `current_started_at + break duration`; then the interrupted item (if any) continues with its remaining duration.
2. **Each following item:**
   - agenda: `expected_start = cursor` → shifts **later on delay and earlier on early finish** (pull-forward).
   - break: `expected_start = max(cursor, planned_start)` → delays push breaks back, but early finishes never pull a break forward (kitchen/meal times).
   - `cursor = expected_start + planned duration`.
3. **Daily reset:** only today is computed; other days show planned times. Before today's first item starts, everything is as planned.

Display: expected time in front, planned time struck through when they differ by ≥ 5 min. Public view shows what is *actually* running and, if different, what *should* run per plan ("Laut Plan: TOP 5"); an interrupted item shows "unterbrochen, geht nach der Pause weiter".

Assumption: the plan has no deliberate gaps between items (pull-forward closes them). If gaps occur, add them as breaks.

### General
- **Time comes from the server** (Europe/Berlin), sent with every update, so wrong phone clocks don't matter.
- Days shown as tabs/sections with weekday + date; today's day auto-selected.

### Auto-refresh
Public page polls `GET /api/live` every **20 s** (pauses when tab is hidden). Response is a small JSON with a version number; unchanged → `304`, nearly zero bytes. No WebSockets/SSE – simpler, robust on flaky Wi-Fi. Page still works without JS (just not live).

## 5. Admin area (`/admin`)

- Login with username + password. Hashes via `Bun.password` (argon2). Session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`). Login rate-limit (e.g. 5 tries/min/IP). Origin check on all POSTs.
- First start: CLI command / env var creates the first full admin.
- **Permissions** = checkboxes per account (no role system):
  `schedule` (incl. current item) · `news` · `pages` (content, links, help, legal) · `settings` (branding, contact, page toggles) · `events` (create/archive/copy) · `users`.
- No e-mail; the admin sets/resets passwords and hands them over.
- Plain HTML forms, mobile-friendly. The "current item" control is the prominent first screen for schedule users.
- Concurrent edits: last write wins (acceptable at this scale).

## 6. Events, archive, copy

- Multiple events in one DB; exactly **one active** event shown publicly.
- Event owns: schedule, news, contact person(s), link-page URLs. Global (per installation): branding, page names/toggles, help text, legal texts, users.
- **Copy event**: new name + new start date → schedule copied and shifted by the date offset; links/contacts copied; news not copied.
- Archive = inactive, read-only in admin. Archived events are not publicly visible.
- Delete with confirmation.

## 7. Branding & uploads

Settings: site title, organization name, logo, favicon, primary/secondary colors, copyright text.
Uploads: PNG/JPEG/WebP/ICO/SVG, max 2 MB, stored in `data/uploads/` with random names. SVG served with `Content-Security-Policy: default-src 'none'` so embedded scripts can't run.

Contact card: name, role, photo, phone, e-mail, messenger link. Several contacts per event possible (usually one).

## 8. Privacy (DSGVO)

- No external requests: fonts, icons, scripts all self-hosted.
- No analytics; only the admin session cookie → no cookie banner needed.
- Hosting location is up to the installing org; documented in README.

## 9. Not in scope (later)

- **Lageplan** (floor plans, room search, "show room" from schedule). Prepared only by keeping `location` a field that can later become a room reference.
- Multiple languages, PWA/offline mode, push notifications, multi-tenant hosting.

## 10. Project layout

```
src/
  server.ts        # Hono app, routes
  db.ts            # schema + queries (SQLite)
  schedule.ts      # delay/expected-time logic (pure) + schedule.test.ts
  auth.ts          # sessions, permissions, rate-limit
  views/           # JSX: layout, public pages, admin pages
public/
  style.css  live.js
data/              # SQLite file + uploads (gitignored, the only thing to back up)
Dockerfile  compose.yaml
```

## 11. Implementation phases

1. **Skeleton** – Bun + Hono, SQLite schema, layout, theme CSS, footer, settings table, Dockerfile.
2. **Auth** – users, login, sessions, permission checks, first-admin bootstrap.
3. **Schedule** – CRUD per event, delay logic with tests, public live view, `/api/live` polling, mobile "current item" control.
4. **News & contact** on start page.
5. **Pages** – link pages, help, Impressum/Datenschutz, toggles, renaming, ordering.
6. **Branding & uploads.**
7. **Events** – create, activate, archive, copy, delete.
8. **Ops** – README section: install, run, backup, update.

## 12. Decisions (settled 2026-10-11)

1. Delays: breaks can interrupt an agenda item, which resumes afterwards; break times shift with delays; daily reset; pull-forward on early finish; unscheduled breaks possible (§4).
2. Any schedule entry can be "current".
3. Link pages: per-page option (own page or direct external link).
4. Archived events are not publicly visible.
5. Several contacts per event possible.
6. Responsible person visibility is set per item.
