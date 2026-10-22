// The offline app in real browsers: what one visit stores, what is shown without network, and what never is.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/** First visit: the worker installs and stores the site; resolves once it controls the page (activated + claimed). */
async function visit(page: Page) {
  await page.goto("/");
  await page.waitForFunction("navigator.serviceWorker.controller !== null"); // runs in the page (no DOM types here)
}

/**
 * Offline for real: the test server drops every connection of this context (e2e-down, see server.ts), which also
 * reaches the service worker's own requests; setOffline adds the browser's offline events.
 */
async function offline(context: BrowserContext) {
  await context.addCookies([{ name: "e2e-down", value: "1", domain: "localhost", path: "/" }]);
  await context.setOffline(true);
}

async function online(context: BrowserContext) {
  await context.clearCookies({ name: "e2e-down" });
  await context.setOffline(false);
}

test("one visit stores the whole site: a page never opened works offline, with the offline bar", async ({ page, context }) => {
  await visit(page);
  const bar = page.locator(".offlinebar");
  await expect(bar).toContainText("funktionieren jetzt auch ohne Netz");
  // the note lies over the page: the page sits in the same place with and without it
  const main = page.locator("main");
  const withNote = (await main.boundingBox())!.y;
  await bar.evaluate((el) => ((el as { hidden: boolean }).hidden = true));
  expect((await main.boundingBox())!.y).toBe(withNote);
  await offline(context);
  await page.goto("/p/hilfe");
  await expect(page.locator("h1")).toHaveText("Hilfe & Service");
  await expect(page.locator(".offlinebar")).toContainText(/Offline – Stand \d\d:\d\d Uhr/);
});

test("start page offline: Jetzt card shows its age, timer hidden", async ({ page, context }) => {
  await visit(page);
  await offline(context);
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/offline/);
  const eyebrow = page.locator(".now .eyebrow").first();
  await expect.poll(() => eyebrow.evaluate((el) => (globalThis as any).getComputedStyle(el, "::before").content)).toContain("Offline · Stand");
  for (const timer of await page.locator(".now .timer").all()) await expect(timer).toBeHidden();
});

test("offline fallbacks: room link shows the stored Lageplan, unknown page a notice, admin is never stored", async ({ page, context }) => {
  await visit(page);
  await offline(context);
  await page.goto("/p/lageplan?raum=99999");
  await expect(page.locator("h1").first()).toHaveText("Lageplan");
  await page.goto("/p/gibt-es-nicht");
  await expect(page.locator("h1")).toHaveText("Keine Verbindung");
  await expect(page.goto("/admin")).rejects.toThrow();
});

test("back online: the bar says so and offers a reload", async ({ page, context }) => {
  await visit(page);
  await page.goto("/p/hilfe");
  await offline(context);
  await expect(page.locator(".offlinebar")).toContainText("Offline", { timeout: 25000 });
  await online(context);
  await expect(page.locator(".offlinebar")).toContainText("Wieder online", { timeout: 25000 });
  await expect(page.locator(".offlinebar a")).toHaveText("Seite aktualisieren");
});

test("hanging network: the stored page shows after about 3 s, then the bar says offline", async ({ page, context, baseURL }) => {
  await visit(page);
  await context.addCookies([{ name: "e2e-slow", value: "1", url: baseURL! }]);
  const start = Date.now();
  await page.goto("/p/hilfe");
  await expect(page.locator("h1")).toHaveText("Hilfe & Service");
  expect(Date.now() - start).toBeLessThan(8000);
  await expect(page.locator(".offlinebar")).toContainText("Offline", { timeout: 10000 });
});

test("offline state carries over: once offline, the next pages come from the store at once, until the server answers", async ({ page, context, baseURL }) => {
  await visit(page);
  await context.addCookies([{ name: "e2e-slow", value: "1", url: baseURL! }]);
  await page.goto("/p/hilfe"); // waits the 3 s once, then counts as offline
  await expect(page.locator("h1")).toHaveText("Hilfe & Service");

  const start = Date.now();
  await page.goto("/p/wahlen");
  expect(Date.now() - start).toBeLessThan(2000); // no second 3 s wait
  await expect(page.locator(".offlinebar")).toContainText("Offline", { timeout: 1500 }); // without waiting for a check

  await context.clearCookies({ name: "e2e-slow" });
  await page.goto("/p/unterlagen"); // still from the store; the request in the background reaches the server
  await expect(page.locator(".offlinebar")).toContainText("Wieder online", { timeout: 10000 });
  // requests from the slow phase still hold the browser's connections to the server (6 per server) until the test
  // server answers them after 8 s; a page needing a connection before that is rightly treated as slow again
  await page.waitForTimeout(8500);
  await page.goto("/p/hilfe"); // online again: fresh from the network, no bar
  await expect(page.locator(".offlinebar")).toBeHidden();
  expect(await page.evaluate(`"fromStore" in document.documentElement.dataset`)).toBe(false);
});

test("install hint on iPhone explains the share menu; 'Nicht jetzt' hides it for good", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto("/");
  const hint = page.locator(".installhint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Zum Home-Bildschirm");
  await expect(hint.locator("[data-install]")).toBeHidden();
  await hint.locator("[data-dismiss]").click();
  await expect(hint).toBeHidden();
  await page.reload();
  await expect(hint).toBeHidden();
  await context.close();
});

test("install hint stays hidden where the browser offers no install", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(500);
  await expect(page.locator(".installhint")).toBeHidden();
});
