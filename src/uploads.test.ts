import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { getSetting } from "./db";
import { pruneUploads, saveUpload, uploadDir } from "./uploads";
import { loginAs, testApp } from "./test-helpers";

beforeAll(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "diko-uploads-"));
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function postMultipart(app: Hono, path: string, fields: Record<string, string | File>, cookie: string) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return app.request(path, { method: "POST", body, headers: { origin: "http://localhost", cookie } });
}

const baseSettings = { site_title: "Diko", org_name: "KjG", copyright: "", color_primary: "#006d84", color_secondary: "#00b6be", hero_position: "center" };

test("saveUpload rejects disallowed types and big files", async () => {
  await expect(saveUpload(new File(["x"], "virus.exe"))).rejects.toThrow("Dateityp nicht erlaubt");
  await expect(saveUpload(new File([new Uint8Array(3 * 1024 * 1024)], "big.png"))).rejects.toThrow("Datei größer als 2 MB");
  expect(await saveUpload(new File([PNG], "Logo.PNG"))).toMatch(/^[0-9a-f-]{36}\.png$/);
});

test("logo upload is stored and served with safe headers", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  const res = await postMultipart(app, "/admin/settings", { ...baseSettings, logo: new File([PNG], "logo.png", { type: "image/png" }) }, cookie);
  expect(res.status).toBe(302);
  const logo = getSetting(db, "logo");
  expect(logo).toMatch(/\.png$/);
  expect(await (await app.request("/")).text()).toContain(`/uploads/${logo}`);
  const file = await app.request(`/uploads/${logo}`);
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("image/png");
  expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
});

test("disallowed upload shows error and keeps settings", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  const res = await postMultipart(app, "/admin/settings", { ...baseSettings, site_title: "Neu", logo: new File(["x"], "x.exe") }, cookie);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Dateityp nicht erlaubt");
  expect(getSetting(db, "site_title")).toBe("Diko Manager");
});

test("path traversal and unknown names give 404", async () => {
  const { app } = testApp();
  expect((await app.request("/uploads/..%2Fdata%2Fdiko.db")).status).toBe(404);
  expect((await app.request("/uploads/notes.txt")).status).toBe(404);
});

test("colors and texts are saved; invalid color rejected", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  await postMultipart(app, "/admin/settings", { ...baseSettings, color_primary: "#123456", show_intro: "1" }, cookie);
  const html = await (await app.request("/")).text();
  expect(html).toContain("--primary:#123456");
  expect(getSetting(db, "show_schedule")).toBe("0");
  const bad = await postMultipart(app, "/admin/settings", { ...baseSettings, color_primary: "red;}</style>" }, cookie);
  expect(bad.status).toBe(400);
  expect(getSetting(db, "color_primary")).toBe("#123456");
});

test("settings require settings perm", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["intro"]);
  expect((await postMultipart(app, "/admin/settings", baseSettings, cookie)).status).toBe(403);
});

test("title image upload and crop position are saved; invalid position rejected", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  const res = await postMultipart(app, "/admin/settings", { ...baseSettings, hero_position: "bottom", hero_image: new File([PNG], "altenberg.jpg") }, cookie);
  expect(res.status).toBe(302);
  expect(getSetting(db, "hero_image")).toMatch(/\.jpg$/);
  expect(getSetting(db, "hero_position")).toBe("bottom");
  const bad = await postMultipart(app, "/admin/settings", { ...baseSettings, hero_position: "left;}" }, cookie);
  expect(bad.status).toBe(400);
  expect(getSetting(db, "hero_position")).toBe("bottom");
});

test("replacing or removing the logo deletes the old file", async () => {
  const { app, db } = testApp();
  const cookie = await loginAs(app, db, ["settings"]);
  await postMultipart(app, "/admin/settings", { ...baseSettings, logo: new File([PNG], "a.png") }, cookie);
  const first = getSetting(db, "logo");
  await postMultipart(app, "/admin/settings", { ...baseSettings, logo: new File([PNG], "b.png") }, cookie);
  const second = getSetting(db, "logo");
  expect((await app.request(`/uploads/${first}`)).status).toBe(404);
  await postMultipart(app, "/admin/settings", { ...baseSettings, remove_logo: "1" }, cookie);
  expect((await app.request(`/uploads/${second}`)).status).toBe(404);
});

test("pruneUploads deletes files nothing refers to and keeps the rest", async () => {
  const { db } = testApp();
  const used = await saveUpload(new File([PNG], "used.png"));
  const orphan = await saveUpload(new File([PNG], "orphan.png"));
  db.run("UPDATE settings SET value = ? WHERE key = 'favicon'", [used]);
  pruneUploads(db);
  expect(existsSync(join(uploadDir(), used))).toBe(true);
  expect(existsSync(join(uploadDir(), orphan))).toBe(false);
});
