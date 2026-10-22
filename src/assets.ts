import { readFileSync, statSync } from "node:fs";

/** Files served under /static/; vendor files come from node_modules. */
const FILES: Record<string, string> = {
  "style.css": "public/style.css",
  "theme.js": "public/theme.js",
  "site.js": "public/site.js",
  "live.js": "public/live.js",
  "admin.js": "public/admin.js",
  "map.js": "public/map.js",
  "map-editor.js": "public/map-editor.js",
  "vendor/sortable.js": "node_modules/sortablejs/Sortable.min.js",
  "sw.js": "public/sw.js", // served at /sw.js; listed so a changed worker also gets a fresh cache
};

/** Public pages need these offline; the service worker stores them on install. */
export const OFFLINE_ASSETS = ["style.css", "theme.js", "site.js", "live.js", "map.js"];

const hashes = new Map<string, { mtime: number; hash: string }>();

/** Short content hash; recomputed when the file changes, so `bun --watch` and edits in public/ never serve stale. */
function hashOf(name: string): string {
  const path = FILES[name];
  if (!path) throw new Error(`Unbekannte Datei: ${name}`);
  const mtime = statSync(path).mtimeMs;
  const known = hashes.get(name);
  if (known?.mtime === mtime) return known.hash;
  const hash = Bun.hash(readFileSync(path)).toString(36).slice(0, 8);
  hashes.set(name, { mtime, hash });
  return hash;
}

/** `/static/<name>?v=<hash>`: the version lets browsers keep the file for a year (see the static route). */
export const assetUrl = (name: string) => `/static/${name}?v=${hashOf(name)}`;

/** Changes whenever any static file changes; names the service worker's cache. */
export const assetsVersion = () => Bun.hash(Object.keys(FILES).map(hashOf).join()).toString(36).slice(0, 8);
