import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { assetUrl, assetsVersion, OFFLINE_ASSETS } from "./assets";
import { getSettings } from "./db";
import { uploadDataUri, uploadDir } from "./uploads";

/** Width and height of a PNG from its header, or null if it is no PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Fallback app icon without own App-Icon: the first letter of the site title on the primary colour, like the header's logo badge. */
function letterIcon(letter: string, color: string) {
  const esc = letter.replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${color}"/>` +
    `<text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="240" font-weight="700" fill="#fff">${esc}</text></svg>`;
}

/**
 * Fallback app icon from the tab icon (favicon): any format or size, centred on a white square. Embedded as data URI
 * because an SVG used as an image may not load anything else; the inner 70 % stays clear of Android's round masks.
 */
const faviconIcon = (dataUri: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff"/>` +
  `<image href="${dataUri}" x="77" y="77" width="358" height="358" preserveAspectRatio="xMidYMid meet"/></svg>`;

/**
 * App zum Installieren (PWA): manifest, default icon and the service worker. The worker is served from the root so
 * its scope covers the whole site, and with the asset version baked in so every deploy installs a new one.
 */
export function pwaRoutes(db: Database) {
  const r = new Hono();

  r.get("/manifest.webmanifest", async (c) => {
    const s = getSettings(db);
    const icons: object[] = [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }];
    if (s.app_icon) {
      const size = pngSize(await Bun.file(join(uploadDir(), s.app_icon)).slice(0, 24).bytes().catch(() => new Uint8Array()));
      if (size) icons.unshift({ src: `/uploads/${s.app_icon}`, sizes: `${size.width}x${size.height}`, type: "image/png", purpose: "any" });
    }
    c.header("Content-Type", "application/manifest+json");
    c.header("Cache-Control", "no-cache");
    return c.body(
      JSON.stringify({
        name: s.site_title,
        short_name: s.site_title!.length > 12 ? s.site_title!.slice(0, 12).trim() : s.site_title,
        lang: "de",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f6f7f8",
        theme_color: "#ffffff", // the header's colour
        icons,
      }),
    );
  });

  r.get("/app-icon.svg", async (c) => {
    const s = getSettings(db);
    const favicon = s.favicon ? await uploadDataUri(s.favicon) : "";
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "no-cache");
    return c.body(favicon ? faviconIcon(favicon) : letterIcon((s.site_title || "K").slice(0, 1).toUpperCase(), s.color_primary!));
  });

  r.get("/sw.js", (c) => {
    const assets = ["/", ...OFFLINE_ASSETS.map(assetUrl)];
    const code = readFileSync("public/sw.js", "utf8")
      .replace('"__VERSION__"', JSON.stringify(assetsVersion()))
      .replace("[/* __ASSETS__ */]", JSON.stringify(assets));
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(code);
  });

  return r;
}
