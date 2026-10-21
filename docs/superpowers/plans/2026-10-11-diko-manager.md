# Diko Manager Implementation Plan

> **Historical document:** the original build plan from 2026-10-11, fully carried out. See the README for the current state and [ROADMAP.md](../../../ROADMAP.md) for what's next.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A light, mobile-first event website with a live schedule (delays, breaks, interruptions), link/content pages and a permission-based admin area.

**Architecture:** One Bun process running a Hono app that renders HTML on the server with Hono JSX and stores everything in one SQLite file. The live schedule is a pure function (`computeDay`) fed by a small "live state" row that admin buttons mutate. The public page polls an HTML fragment endpoint with ETags.

**Tech Stack:** Bun (TypeScript, `bun:sqlite`, `Bun.password`, `bun test`), Hono 4 (`hono/jsx`, `hono/cookie`, `hono/csrf`, `hono/bun`), marked.

**Spec:** [docs/superpowers/specs/2026-10-11-diko-manager-design.md](../specs/2026-10-11-diko-manager-design.md)

## Global Constraints

- Runtime dependencies: `hono`, `marked` only. Dev: `@types/bun` only. No frontend framework, no build step.
- No external requests from any page: no CDN, no Google Fonts, no analytics. System font stack.
- All UI copy in German.
- Server time zone for all "now" logic: `Europe/Berlin` (via `src/time.ts`, never `new Date().getHours()`).
- Mobile-first: every page usable at 360 px width; admin live control buttons ≥ 48 px tall.
- Markdown is rendered only through `renderMarkdown()` (raw HTML escaped, unsafe link schemes dropped).
- URLs entered in the admin area (links, contact messenger) must be `http:`/`https:` (`mailto:`/`tel:` allowed for contact fields).
- Data lives only in `data/` (`data/diko.db`, `data/uploads/`), which is gitignored.
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when served over HTTPS (direct or `x-forwarded-proto: https`).
- Every DB write that changes public content calls `bump(db)`.
- Permissions: exactly `schedule`, `news`, `pages`, `settings`, `events`, `users`.

## Review Focus

1. **Day change / restart mid-event:** live state started on a previous day → today shows planned times (daily reset), no crash. Test in Task 7.
2. **Injection via editable content:** `<script>` in Markdown and `javascript:` in Markdown links or admin URL fields → rendered inert or rejected. Tests in Tasks 2 and 9.
3. **Deleting or editing the current/interrupted item** → live state is cleared or stays consistent, the start page still renders. Test in Task 6.
4. **No active event, empty schedule, all items done** → friendly German message, never 500. Test in Task 7.
5. **Items past midnight** (evening program 21:00–01:00) → duration = 4 h, not negative. Test in Task 1 (`duration`).

---

## Step 0 (once, before Task 1): install Bun

Run (PowerShell): `powershell -c "irm bun.sh/install.ps1 | iex"`, open a new shell.
Run: `bun --version` → Expected: `1.x` (≥ 1.2).

## File Structure

```
package.json  tsconfig.json  .gitignore  Dockerfile  compose.yaml  README.md
src/
  index.ts            # entry: open data/diko.db, bootstrap admin, export Bun server
  app.tsx             # createApp(db): Hono app, mounts route modules
  db.ts               # openDb(), schema, seed, bump(), getSetting()/setSetting()
  time.ts             # berlinNow(), toBerlin(), toMinutes(), fmt(), duration()
  markdown.ts         # renderMarkdown(), safeUrl()
  schedule.ts         # computeDay(), plannedNowId()   (pure)
  live.ts             # live-state mutations: next/back/pauseNow/unplannedPause/startItem
  auth.ts             # sessions, login rate-limit, requireLogin, requirePerm, bootstrapAdmin
  uploads.ts          # saveUpload(), serve route
  views/layout.tsx    # Layout (header, nav, footer, theme vars)
  views/public.tsx    # StartPage, LiveSection, ContentPage, LinkPage
  views/admin.tsx     # admin forms/pages (split into views/admin/*.tsx if > ~400 lines)
  routes/public.tsx   # /, /p/:slug, /api/live
  routes/admin.tsx    # /admin/** (split per area if > ~400 lines)
  test-helpers.ts     # testApp(), loginAs()
  *.test.ts(x)        # next to the module they test
public/style.css  public/live.js
```

---

### Task 1: Skeleton, database, time helpers, layout

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts`, `src/app.tsx`, `src/db.ts`, `src/time.ts`, `src/views/layout.tsx`, `src/routes/public.tsx`, `src/test-helpers.ts`, `public/style.css`
- Test: `src/time.test.ts`, `src/app.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): Database` (`":memory:"` for tests). Runs schema + seed idempotently (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`).
  - `bump(db): void` (increments setting `version`), `getSetting(db, key): string`, `setSetting(db, key, value): void`, `getSettings(db): Record<string,string>`
  - `createApp(db: Database): Hono`
  - `berlinNow(d = new Date()): { date: string /*YYYY-MM-DD*/; minutes: number }`, `toBerlin(ms: number)` (same shape), `toMinutes("HH:MM"): number`, `fmt(minutes): "HH:MM"` (wraps at 24 h), `duration(start: "HH:MM", end: "HH:MM"): number` (end ≤ start ⇒ +1440)
  - `testApp(): { app: Hono; db: Database }`
  - `Layout({ db, title, children })` JSX component

- [ ] **Step 1: Set up the project**

`bun init -y`, then `bun add hono marked`, `bun add -d @types/bun`. tsconfig: `"jsx": "react-jsx", "jsxImportSource": "hono/jsx", "strict": true`. Scripts: `"start": "bun run src/index.ts"`, `"dev": "bun --watch run src/index.ts"`, `"test": "bun test"`. `.gitignore`: `node_modules/`, `data/`.

- [ ] **Step 2: Write failing tests**

```ts
// src/time.test.ts
test("toMinutes/fmt", () => { expect(toMinutes("09:30")).toBe(570); expect(fmt(570)).toBe("09:30"); expect(fmt(1500)).toBe("01:00"); });
test("duration past midnight", () => { expect(duration("21:00", "01:00")).toBe(240); expect(duration("09:00", "10:00")).toBe(60); });
test("berlinNow uses Europe/Berlin", () => {
  expect(berlinNow(new Date("2026-10-11T22:30:00Z"))).toEqual({ date: "2026-10-12", minutes: 30 }); // CEST, UTC+2
  expect(berlinNow(new Date("2026-12-01T08:00:00Z"))).toEqual({ date: "2026-12-01", minutes: 540 }); // CET, UTC+1
});
// src/app.test.ts
test("start page renders with site title and footer", async () => {
  const { app, db } = testApp(); setSetting(db, "site_title", "Diko 2026");
  const html = await (await app.request("/")).text();
  expect(html).toContain("<title>Diko 2026</title>");
  expect(html).toContain('href="/p/impressum"'); expect(html).toContain('href="/p/datenschutz"');
});
test("nav hides disabled pages, hidden entirely when none enabled", async () => {
  const { app, db } = testApp();
  db.run("UPDATE pages SET enabled = 0 WHERE kind != 'legal'");
  expect(await (await app.request("/")).text()).not.toContain("<nav");
  db.run("UPDATE pages SET enabled = 1, title = 'OpenSlides' WHERE slug = 'wahlen'");
  expect(await (await app.request("/")).text()).toContain("OpenSlides");
});
```

- [ ] **Step 3: Run** `bun test` → Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `src/db.ts` schema + seed**

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','archived')) DEFAULT 'draft');
CREATE TABLE items (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', responsible TEXT NOT NULL DEFAULT '', show_responsible INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('agenda','break')), top_number TEXT NOT NULL DEFAULT '',
  unplanned INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE live (event_id INTEGER PRIMARY KEY REFERENCES events ON DELETE CASCADE,
  current_item_id INTEGER, started_at INTEGER /*epoch ms*/, elapsed_before INTEGER NOT NULL DEFAULT 0,
  interrupted_item_id INTEGER, interrupted_elapsed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE live_history (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE, snapshot TEXT NOT NULL);
CREATE TABLE news (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE contacts (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  messenger TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pages (slug TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('link','markdown','legal')), title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL DEFAULT '', direct INTEGER NOT NULL DEFAULT 0);
CREATE TABLE page_links (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events ON DELETE CASCADE,
  page_slug TEXT NOT NULL REFERENCES pages, label TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]');
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE, expires INTEGER NOT NULL);
```
Enable `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`.
Seed pages: `unterlagen`/"Unterlagen" (link, sort 1), `antraege`/"Anträge" (link, 2), `wahlen`/"Wahlen" (link, 3), `hilfe`/"Hilfe & Service" (markdown, 4), `impressum`/"Impressum" (legal, 90), `datenschutz`/"Datenschutz" (legal, 91).
Seed settings: `site_title`="Diko Manager", `org_name`="", `copyright`="", `logo`="", `favicon`="", `color_primary`, `color_secondary` (take both from kjg-koeln.de's stylesheet), `show_news`="1", `show_schedule`="1", `show_contact`="1", `version`="0".

- [ ] **Step 5: Implement `time.ts`, `Layout`, `createApp`, `GET /`, `index.ts`, `style.css`**

`berlinNow` via `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year, month, day, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts`. Layout: `<title>` = site title, logo + title in header, `<nav>` with enabled non-legal pages ordered by `sort` (omit `<nav>` if none), footer `Impressum · Datenschutz · © {year} {copyright || org_name}`, `<style>:root{--primary:…;--secondary:…}</style>` from settings. `GET /` renders Layout with a placeholder body for now. Static files: `serveStatic({ root: "./public" })` from `hono/bun` under `/static/*`. `index.ts`: `export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch }`.

- [ ] **Step 6: Run** `bun test` → PASS. Run `bun run dev`, open http://localhost:3000 → page with header/footer renders at phone width.

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat: project skeleton, schema, layout"`

---

### Task 2: Safe Markdown

**Files:** Create `src/markdown.ts`; Test `src/markdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(md: string): string` (HTML string), `safeUrl(url: string, allowContact = false): string | null` (returns the URL if scheme is http/https, or mailto/tel when `allowContact`; otherwise `null`)

- [ ] **Step 1: Write failing tests**

```ts
test("raw HTML is escaped", () => { const h = renderMarkdown("<script>alert(1)</script> **fett**");
  expect(h).not.toContain("<script>"); expect(h).toContain("&lt;script&gt;"); expect(h).toContain("<strong>fett</strong>"); });
test("unsafe link schemes dropped", () => { expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
  expect(renderMarkdown("[x](https://a.de)")).toContain('href="https://a.de"'); });
test("safeUrl", () => { expect(safeUrl("https://a.de")).toBe("https://a.de"); expect(safeUrl("javascript:x")).toBeNull();
  expect(safeUrl("mailto:a@b.de")).toBeNull(); expect(safeUrl("mailto:a@b.de", true)).toBe("mailto:a@b.de"); });
```

- [ ] **Step 2: Run** `bun test src/markdown.test.ts` → FAIL.
- [ ] **Step 3: Implement** with a dedicated `new Marked()` instance: renderer `html` returns the escaped token text; renderer `link` renders plain text when `safeUrl(href, true)` is null. External links get `rel="noopener"`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: safe markdown rendering`

---

### Task 3: Auth, sessions, permissions, user management

**Files:** Create `src/auth.ts`, admin login/users views + routes (`src/routes/admin.tsx`, `src/views/admin.tsx`); Modify `src/app.tsx`, `src/index.ts`, `src/test-helpers.ts`; Test `src/auth.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Layout`
- Produces:
  - `PERMS = ["schedule","news","pages","settings","events","users"] as const; type Perm = typeof PERMS[number]`
  - `requireLogin` middleware (sets `c.get("user"): { id: number; username: string; perms: Perm[] }`, otherwise redirect `/admin/login`)
  - `requirePerm(p: Perm)` middleware → 403 page "Keine Berechtigung"
  - `bootstrapAdmin(db, env)`: if `users` empty and `ADMIN_USER` + `ADMIN_PASSWORD` set → create user with all perms; if empty and unset → `console.warn` how to set them
  - `loginAs(app, db, perms: Perm[]): Promise<string>` (test helper; returns `Cookie` header value)
  - Routes: `GET/POST /admin/login`, `POST /admin/logout`, `GET /admin` (dashboard: links per permission; redirect to `/admin/live` if user has `schedule`), `/admin/users` (list, create, edit perms, reset password, delete)

- [ ] **Step 1: Write failing tests**

```ts
test("login with correct password sets HttpOnly session cookie", …) // POST /admin/login → 302 to /admin, set-cookie contains HttpOnly and SameSite=Lax
test("wrong password shows 'Benutzername oder Passwort falsch'", …)
test("6th failed login within a minute from same IP → 429 'Zu viele Versuche'", …) // header x-forwarded-for: 1.2.3.4
test("/admin/users without users perm → 403; with → 200", …)
test("cross-origin POST is rejected", …) // Origin: https://evil.example → 403
test("user cannot delete themselves or remove their own users perm", …) // → error message, DB unchanged
test("bootstrapAdmin creates admin with all perms only when table empty", …)
test("logout deletes session", …)
```

- [ ] **Step 2: Run** `bun test src/auth.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Hashes: `Bun.password.hash/verify` (argon2id default). Token: `crypto.randomUUID()`, 14-day expiry, stored in `sessions`. Rate limit: in-memory `Map<ip, number[]>` of failure timestamps, 5 per 60 s; IP = first `x-forwarded-for` entry, else `getConnInfo(c).remote.address`, else `"unknown"` (`// ponytail: in-memory, resets on restart; fine for one process`). CSRF: `csrf()` from `hono/csrf` on `/admin/*`. Minimum password length 12 ("langes Passwort"). Perms stored as JSON array; user form uses one checkbox per perm with German labels: Zeitplan, Neuigkeiten, Seiten, Einstellungen, Veranstaltungen, Benutzer.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: admin auth, permissions, user management`

---

### Task 4: Schedule computation (pure)

**Files:** Create `src/schedule.ts`; Test `src/schedule.test.ts`

**Interfaces:**
- Consumes: `toMinutes`, `duration` from `time.ts`
- Produces:
```ts
type Item = { id: number; start: string; end: string; kind: "agenda" | "break"; done: boolean }; // one day, sorted by start, id
type LiveInput = { currentItemId: number; startedAt: number /*minutes of today*/; elapsedBefore: number;
                   interruptedItemId: number | null; interruptedElapsed: number };
type Row = { id: number; plannedStart: number; expectedStart: number; expectedEnd: number;
             status: "done" | "current" | "interrupted" | "upcoming"; overrun: boolean };
computeDay(items: Item[], live: LiveInput | null, now: number): Row[]   // rows in display order = items order
plannedNowId(items: Item[], now: number): number | null                // item whose planned window contains now
```

Algorithm (the spec's §4, made exact):
- `live === null` → every row `expectedStart = plannedStart`, status `done` if `item.done` else `upcoming`.
- Current item: `plannedEnd = startedAt + max(0, dur − elapsedBefore)`; `expectedEnd = max(now, plannedEnd)`; `overrun = now > plannedEnd`. `cursor = expectedEnd`.
- If current is a break and `interruptedItemId` set: interrupted row `status "interrupted"`, `expectedStart = cursor`, `cursor += max(0, dur − interruptedElapsed)`.
- Remaining items in list order, excluding current/interrupted/done: agenda `expectedStart = cursor`; break `expectedStart = max(cursor, plannedStart)`; `cursor = expectedStart + dur`. Status `upcoming`.
- Done items: `status "done"`, `expectedStart = plannedStart`.

- [ ] **Step 1: Write failing tests** with this day (minutes shown as HH:MM via `toMinutes`):
`A 09:00–10:00 agenda`, `B 10:00–11:00 agenda`, `C 11:00–12:00 agenda`, `M 12:00–13:00 break`, `D 13:00–14:00 agenda`.

```ts
test("no live → planned times", …)                         // expectedStart of all = planned, all upcoming
test("overrun pushes everything incl. breaks", …)           // A current from 09:00, now 10:20 → A overrun, B 10:20, C 11:20, M 12:20, D 13:20
test("early finish pulls agenda forward, not breaks", …)    // A done, B current from 09:50, now 10:00 → C 10:50, M 12:00, D 13:00
test("break interrupts agenda item, remainder after break", …)
  // A,B done; M current from 12:15; interrupted C with elapsed 45; now 12:30 → M end 13:15; C interrupted, expectedStart 13:15; D 13:30
test("resumed item uses remaining duration", …)             // A,B,M done; C current from 13:15, elapsedBefore 45, now 13:20 → C expectedEnd 13:30, D 13:30
test("skipped item stays upcoming", …)                      // A done, C current from 10:00 (B skipped), now 10:10 → B expectedStart 11:00, M 12:00 (max), D 13:00 (B ends 12:00, M 12–13, D 13:00)
test("plannedNowId", …)                                     // now 10:30 → B.id; now 14:30 → null
test("item past midnight has positive duration", …)         // E 21:00–01:00 current from 21:00, now 22:00 → overrun false, expectedEnd 25:00 (1500)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: schedule expected-time computation`

---

### Task 5: Events (create/activate) and schedule item CRUD

**Files:** Modify `src/routes/admin.tsx`, `src/views/admin.tsx`, `src/db.ts` (query helpers); Test `src/events.test.ts`

**Interfaces:**
- Produces:
  - `activeEvent(db): Event | null` (`status = 'active'`), `getEvent(db, id)`, `editableEvent(c, id)` (404 if missing, 403 "Archiviert – nur lesbar" if archived)
  - `itemsForEvent(db, eventId): ItemRow[]` sorted by `date, start, id`
  - Routes (perm `events`): `GET/POST /admin/events` (list, create with name + start date), `POST /admin/events/:id/activate` (sets this `active`, previous active → `draft`, `bump`)
  - Routes (perm `schedule`): `GET /admin/events/:id/items`, `GET/POST /admin/events/:id/items/new`, `GET/POST /admin/items/:id`, `POST /admin/items/:id/delete`
- Item form fields: Datum (`type=date`), Beginn/Ende (`type=time`), Titel, TOP-Nummer, Art (TO-Punkt/Pause), Ort, Beschreibung (Markdown), Zuständig + "Zuständigkeit öffentlich anzeigen". Validation: title, date, start, end required; `end ≠ start`.

- [ ] **Step 1: Failing tests:** activate leaves exactly one active event; item create → appears in list sorted by date/start; missing title → form re-rendered with "Titel fehlt" and nothing inserted; POST on archived event's items → 403; every write increments `version`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: events and schedule item management`

---

### Task 6: Live control (state mutations + mobile admin screen)

**Files:** Create `src/live.ts`; Modify admin routes/views; Test `src/live.test.ts`

**Interfaces:**
- Consumes: `activeEvent`, `itemsForEvent`, `berlinNow`, `toBerlin`, `bump`
- Produces (all take `db, eventId, nowMs = Date.now()`; each writes a `live_history` snapshot first, then `bump`):
  - `next()` – if current is a break and an item is interrupted: mark break done, resume interrupted (`elapsed_before = interrupted_elapsed`, clear interrupted). Else mark current done (if any) and start first today item that is not done (list order). None left → `current_item_id = NULL`.
  - `pauseNow()` – current must be agenda; `interrupted_elapsed = elapsed_before + minutes since started_at`; start first not-done break of today. No break left → throws `"Keine Pause mehr geplant"`.
  - `unplannedPause(minutes: number)` – insert item `{ kind: "break", unplanned: 1, title: "Pause (unplanmäßig)", date: today, start: now, end: now + minutes }`, then like `pauseNow` with that item (no current → just start it). `minutes` 1–180.
  - `startItem(itemId)` – mark current done, start `itemId`, clear interruption.
  - `back()` – pop latest snapshot: restore live row, un-mark the item it marked done, delete the item it inserted. No history → no-op.
  - Snapshot JSON: `{ live: LiveRow | null, markedDone: number | null, insertedItem: number | null }`
  - `liveInput(db, eventId, nowMs): LiveInput | null` – converts row to `LiveInput` (minutes of today); returns `null` if no current item or `started_at` is not today (daily reset).
- Admin `/admin/live` (perm `schedule`, active event): big buttons Weiter / Pause jetzt / Unplanmäßige Pause (minutes input, default 15) / Zurück; shows current item, elapsed, overrun, next 3 items with expected times; per-item "Jetzt starten" in the item list.
- Deleting an item (Task 5 route) that is `current_item_id` or `interrupted_item_id` → clear those fields in the same transaction.

- [ ] **Step 1: Failing tests** (fixed `nowMs` via `new Date("2026-10-11T07:00:00Z")` etc.):
  - `next` from nothing starts first item; again marks it done and starts the second
  - `pauseNow` 45 min into C → M current, C interrupted with elapsed 45; `next` → C current with `elapsed_before` 45, M done
  - `unplannedPause(15)` inserts unplanned break and interrupts; `back` deletes it and restores previous live row
  - `back` after `next` un-marks the done item
  - `pauseNow` with no break left → throws "Keine Pause mehr geplant"
  - deleting the current item clears `current_item_id`; `GET /` still 200
  - `liveInput` returns null when `started_at` was yesterday
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. Open `/admin/live` at 360 px width and click through a day.
- [ ] **Step 5: Commit** `feat: live schedule control`

---

### Task 7: Public start page with live schedule + polling

**Files:** Create `src/views/public.tsx`, `public/live.js`; Modify `src/routes/public.tsx`; Test `src/public.test.ts`

**Interfaces:**
- Consumes: `activeEvent`, `itemsForEvent`, `liveInput`, `computeDay`, `plannedNowId`, `renderMarkdown`, settings `show_schedule`
- Produces:
  - `LiveSection({ db, nowMs })` – the whole dynamic part (news slot filled in Task 9, schedule, "Stand: HH:MM")
  - `GET /` – Layout + `<div id="live">{LiveSection}</div>` + contact slot (Task 9) + `<script src="/static/live.js" defer>`
  - `GET /api/live` – returns only the LiveSection HTML; `ETag: W/"<version>-<berlin date>-<minutes>"`; matching `If-None-Match` → `304` empty body; `Cache-Control: no-cache`
- Rendering: one `<details>` per day ("Freitag, 13.11."), today `open`. Today's rows from `computeDay(…, liveInput, now)`, other days with `live = null`. Each row: expected time, planned time `<s>` when |expected − planned| ≥ 5, TOP number, title, location, description (Markdown), responsible only if `show_responsible`. Current row highlighted, "überzogen" badge on overrun agenda, interrupted row: "unterbrochen, geht nach der Pause weiter", done rows dimmed. Banner when `plannedNowId ≠ current`: "Laut Plan: {title}". Unplanned breaks labeled "unplanmäßig".
- `live.js` (plain JS, < 40 lines): every 20 s, if `!document.hidden`, fetch `/api/live` with `If-None-Match`; on 200 replace `#live` innerHTML (keep `open` state of `<details>`), store ETag; on network error add class `stale` (CSS shows "Offline – Stand HH:MM"); fetch immediately on `visibilitychange` to visible.

- [ ] **Step 1: Failing tests:**
  - no active event → 200 with "Aktuell ist keine Veranstaltung geplant."
  - active event with no items → "Der Zeitplan folgt."
  - overrun scenario (Task 4 data, live from 09:00, now 10:20) → HTML contains "überzogen", `10:20` and `<s>10:00</s>`
  - `show_responsible = 0` → responsible name absent; `= 1` → present
  - `show_schedule = "0"` → no schedule markup
  - `/api/live` twice with returned ETag → second is 304; after `bump` → 200
  - live state started yesterday → today's rows show planned times, no "überzogen"
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. Manually: two browser windows, press Weiter in admin → public updates within 20 s.
- [ ] **Step 5: Commit** `feat: public live schedule with polling`

---

### Task 8: Branding settings and uploads

**Files:** Create `src/uploads.ts`; Modify admin routes/views, `Layout`; Test `src/uploads.test.ts`

**Interfaces:**
- Produces:
  - `saveUpload(file: File): Promise<string>` – returns stored filename `<uuid>.<ext>`; allowed ext `png jpg jpeg webp ico svg`, max 2 MB, else throws German message ("Dateityp nicht erlaubt" / "Datei größer als 2 MB")
  - `GET /uploads/:name` – name must match `^[0-9a-f-]{36}\.(png|jpe?g|webp|ico|svg)$` else 404; headers: correct `Content-Type`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`
  - `/admin/settings` (perm `settings`): Seitentitel, Organisation, Copyright, Logo, Favicon, Primärfarbe/Sekundärfarbe (`type=color`), Startseite-Blöcke (Neuigkeiten/Zeitplan/Kontakt anzeigen)
  - Layout uses `logo` and `favicon` (`<link rel="icon" href="/uploads/…">`) when set
- [ ] **Step 1: Failing tests:** upload `.exe` rejected; 3 MB png rejected; valid png stored and served with CSP header; `/uploads/../data/diko.db` → 404; color setting appears as `--primary` in page; settings save without `settings` perm → 403.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`mkdir data/uploads` on start, `Bun.write`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: branding settings and uploads`

---

### Task 9: News, contacts, content and link pages

**Files:** Modify routes/views (public + admin); Test `src/content.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown`, `safeUrl`, `saveUpload`, `editableEvent`, `LiveSection`
- Produces:
  - News (perm `news`, per event): `/admin/events/:id/news` list/create/edit/delete. Public: newest first inside `LiveSection` (so polling updates it), only if `show_news`; date+time shown.
  - Contacts (perm `settings`, per event): `/admin/events/:id/contacts` CRUD with photo upload; form hint "Foto nur mit Einverständnis der Person". Public: cards below schedule if `show_contact`; phone as `tel:`, email as `mailto:`, messenger via `safeUrl`.
  - Pages (perm `pages`): `/admin/pages` list with title, enabled, sort; `/admin/pages/:slug` edit title/body; link pages also "Direkt verlinken" checkbox and per-event link list (label + URL) for the active event. Legal pages: enabled checkbox not offered (always on).
  - Public `GET /p/:slug`: disabled → 404; `markdown`/`legal` → body; `link` → body + one button per link of the active event. Nav: link page with `direct = 1` and exactly one link → nav `href` is that URL (`target="_blank" rel="noopener"`), otherwise `/p/:slug`.
- [ ] **Step 1: Failing tests:** news appears in `/api/live` output; `show_news = 0` hides it; link with `javascript:alert(1)` URL rejected with "Nur http(s)-Links erlaubt"; direct link page → nav href is external URL; disabled page → 404; legal page always reachable; contact with photo renders `<img src="/uploads/…">`; news write on archived event → 403.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: news, contacts and pages`

---

### Task 10: Archive, copy, delete events

**Files:** Modify events routes/views, `src/db.ts`; Test `src/events.test.ts` (extend)

**Interfaces:**
- Produces (perm `events`):
  - `POST /admin/events/:id/archive` – status `archived` (if it was active, no event is active afterwards)
  - `copyEvent(db, id, name, startDate): number` + `POST /admin/events/:id/copy` – new `draft` event; items copied with `date` shifted by whole days (`startDate − source.start_date`), `done = 0`, `unplanned` items skipped; contacts and page_links copied; news and live state not copied
  - `POST /admin/events/:id/delete` – requires checkbox `confirm` ("Ja, endgültig löschen"); cascades
- [ ] **Step 1: Failing tests:** copy shifts a 2026-11-13 item to 2027-11-12 when start dates are 2026-11-13 → 2027-11-12; unplanned breaks and news not copied; archived event not shown publicly and its forms reject writes; delete without confirm → nothing deleted; delete with confirm removes items/news/contacts.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (copy in one transaction). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: archive, copy and delete events`

---

### Task 11: Deployment and README

**Files:** Create `Dockerfile`, `compose.yaml`; Modify `README.md` (append "Installation & Betrieb")

- Dockerfile: `FROM oven/bun:1-alpine`, `ENV TZ=Europe/Berlin`, copy `package.json bun.lock`, `bun install --production --frozen-lockfile`, copy `src public`, `EXPOSE 3000`, `CMD ["bun","run","src/index.ts"]`.
- compose.yaml: one service, `ports: ["3000:3000"]`, volume `./data:/app/data`, env `ADMIN_USER`, `ADMIN_PASSWORD`, `restart: unless-stopped`.
- README section (German): requirements, start with Docker or `bun install && bun run start`, first admin via env vars, HTTPS via reverse proxy (Caddy example, 3 lines) and that the proxy must send `X-Forwarded-For`/`X-Forwarded-Proto`, backup = copy `data/`, update = `git pull` + restart.

- [ ] **Step 1:** Write files.
- [ ] **Step 2: Verify** `bun test` → all PASS; `bun run start` with `ADMIN_USER=admin ADMIN_PASSWORD=<12+ chars>` → log in, create event + items, run Weiter/Pause, check public page on phone width. If Docker is available: `docker compose up -d --build` → same check on http://localhost:3000.
- [ ] **Step 3: Commit** `docs: installation and operations; add Docker setup`
