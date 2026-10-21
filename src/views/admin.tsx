import type { Database } from "bun:sqlite";
import type { Child } from "hono/jsx";
import { can, PERM_LABELS, PERMS, type Perm, type User } from "../auth";
import { Layout } from "./layout";

/** Area links; a list of perms means any one of them is enough. */
const sections: [Perm | Perm[], string, string][] = [
  ["schedule", "/admin/schedule", "Zeitplan"],
  ["intro", "/admin/intro", "Einführung & FAQ"],
  ["events", "/admin/events", "Veranstaltungen"],
  ["pages", "/admin/pages", "Seiten"],
  ["map", "/admin/venues", "Lageplan"],
  ["settings", "/admin/contacts", "Kontakte"],
  ["settings", "/admin/settings", "Einstellungen"],
  ["users", "/admin/users", "Benutzer"],
  [["settings", "pages", "users", "map", "events"], "/admin/sicherung", "Sicherung"],
];

const allowed = (user: User, p: Perm | Perm[]) => [p].flat().some((x) => can(user, x));

function adminLinks(user: User) {
  return (
    <>
      <a href="/admin">Übersicht</a>
      {sections.filter(([p]) => allowed(user, p)).map(([, href, label]) => (
        <a href={href}>{label}</a>
      ))}
      <form method="post" action="/admin/logout">
        <button class="secondary">Abmelden ({user.username})</button>
      </form>
    </>
  );
}

export function AdminPage({ db, user, title, error, children }: { db: Database; user: User; title: string; error?: string; children?: Child }) {
  return (
    <Layout db={db} title={title} active="admin" user={user}>
      <div class="admin">
        <details class="menu adminmenu">
          <summary>
            <span class="burger" aria-hidden="true"></span>
            Admin-Bereiche
          </summary>
          <nav class="menu-list" aria-label="Admin-Bereiche">
            {adminLinks(user)}
          </nav>
        </details>
        <nav class="adminbar" aria-label="Admin-Bereiche">
          {adminLinks(user)}
        </nav>
        <h1>{title}</h1>
        {error && <p class="error">{error}</p>}
        {children}
      </div>
      <script src="/static/admin.js" defer></script>
    </Layout>
  );
}

export function Dashboard({ db, user }: { db: Database; user: User }) {
  const visible = sections.filter(([p]) => allowed(user, p));
  return (
    <AdminPage db={db} user={user} title="Admin-Bereich">
      {visible.length === 0 ? (
        <p>Dein Konto hat noch keine Berechtigungen.</p>
      ) : (
        <ul>
          {visible.map(([, href, label]) => (
            <li>
              <a href={href}>{label}</a>
            </li>
          ))}
        </ul>
      )}
    </AdminPage>
  );
}

export function LoginPage({ db, error }: { db: Database; error?: string }) {
  return (
    <Layout db={db} title="Anmelden">
      <form method="post" action="/admin/login" class="card narrow">
        <h1>Anmelden</h1>
        {error && <p class="error">{error}</p>}
        <label>
          Benutzername <input name="username" autocomplete="username" required />
        </label>
        <label>
          Passwort <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button>Anmelden</button>
      </form>
    </Layout>
  );
}

export function Forbidden({ db, user }: { db: Database; user: User }) {
  return (
    <AdminPage db={db} user={user} title="Keine Berechtigung">
      <p>Für diesen Bereich fehlt deinem Konto die Berechtigung.</p>
    </AdminPage>
  );
}

export function PermCheckboxes({ perms }: { perms: Perm[] }) {
  return (
    <fieldset>
      <legend>Berechtigungen</legend>
      {PERMS.map((p) => (
        <label>
          <input type="checkbox" name="perms" value={p} checked={perms.includes(p)} /> {PERM_LABELS[p]}
        </label>
      ))}
    </fieldset>
  );
}

type UserRow = { id: number; username: string; perms: string };

export function UsersPage({ db, user, users, error }: { db: Database; user: User; users: UserRow[]; error?: string }) {
  return (
    <AdminPage db={db} user={user} title="Benutzer" error={error}>
      <table>
        <tr>
          <th>Benutzer</th>
          <th>Berechtigungen</th>
        </tr>
        {users.map((u) => (
          <tr>
            <td>
              <a href={`/admin/users/${u.id}`}>{u.username}</a>
            </td>
            <td>{(JSON.parse(u.perms) as Perm[]).map((p) => PERM_LABELS[p]).join(", ")}</td>
          </tr>
        ))}
      </table>
      <form method="post" action="/admin/users" class="card">
        <h2>Neuer Benutzer</h2>
        <label>
          Benutzername <input name="username" required />
        </label>
        <label>
          Passwort (mind. 12 Zeichen) <input type="password" name="password" autocomplete="new-password" required />
        </label>
        <PermCheckboxes perms={[]} />
        <button>Anlegen</button>
      </form>
    </AdminPage>
  );
}

export function UserEdit({ db, user, target, error }: { db: Database; user: User; target: UserRow; error?: string }) {
  return (
    <AdminPage db={db} user={user} title={`Benutzer: ${target.username}`} error={error}>
      <form method="post" action={`/admin/users/${target.id}`} class="card">
        <PermCheckboxes perms={JSON.parse(target.perms)} />
        <label>
          Neues Passwort (leer lassen = unverändert)
          <input type="password" name="password" autocomplete="new-password" />
        </label>
        <button>Speichern</button>
      </form>
      <form method="post" action={`/admin/users/${target.id}/delete`} class="card">
        <label>
          <input type="checkbox" name="confirm" value="1" required /> Ja, diesen Benutzer endgültig löschen
        </label>
        <button class="danger">Löschen</button>
      </form>
    </AdminPage>
  );
}
