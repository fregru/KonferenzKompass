// Phone menus: close on Escape or a tap outside. Without JS it still opens/closes via its button.
(() => {
  const menus = () => document.querySelectorAll("details.menu[open]");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const m of menus()) { m.open = false; m.querySelector("summary").focus(); }
  });
  document.addEventListener("click", (e) => { for (const m of menus()) if (!m.contains(e.target)) m.open = false; });
})();
// Pause timers: count down to the end, then up with "+" once overrun. The server renders the seconds left
// (data-left), so the client clock does not matter; elements swapped in by polling start counting when first seen.
(() => {
  const seen = new WeakMap();
  const clock = (s) => {
    const a = Math.abs(s), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60);
    return `${s < 0 ? "+" : ""}${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(a % 60).padStart(2, "0")}`;
  };
  const tick = () => {
    for (const t of document.querySelectorAll(".timer[data-left]")) {
      if (!seen.has(t)) seen.set(t, Date.now());
      const left = Number(t.dataset.left) - Math.round((Date.now() - seen.get(t)) / 1000);
      t.textContent = clock(left);
      if (left < 0) { t.classList.add("over"); t.closest(".now")?.classList.add("over"); }
    }
  };
  tick();
  setInterval(tick, 1000);
})();
// Offline notice: a bar under the header and html.offline (greys out the "Jetzt" card, see style.css). A real request
// decides, because navigator.onLine stays true on venue Wi-Fi without internet. The start page reuses live.js's
// polling ("kk:online" events); other pages ask /health. "Stand" is html[data-stand]: when the page was built, or
// when live.js last got fresh data – so a copy from the service worker's cache shows its real age.
// A page the service worker served from its store (html[data-from-store]) shows the bar at once; only a check that
// reaches the server switches back. The state is also written to the worker's flag (FLAG in the "kk-state" cache,
// see sw.js), so it serves the next pages straight from the store while offline.
(() => {
  const root = document.documentElement;
  const box = document.querySelector(".offlinebar");
  const text = box?.querySelector("p");
  const live = document.getElementById("live");
  const stand = () => new Date(Number(root.dataset.stand)).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
  const FLAG = "/__offline";
  const state = () => ("caches" in window ? caches.open("kk-state") : Promise.reject());
  let offline = false;
  let leaving = false;
  let hide;
  // remember = false: only show, do not write the worker's flag (it set the flag itself and may have cleared it again)
  const set = (off, remember = true) => {
    // a page being left has its running checks aborted by the browser – that is no sign of being offline
    if (leaving) return;
    root.style.setProperty("--stand", JSON.stringify(stand()));
    if (off === offline) return;
    offline = off;
    if (remember) state().then((s) => (off ? s.put(FLAG, new Response("1")) : s.delete(FLAG))).catch(() => {});
    root.classList.toggle("offline", off);
    if (!box) return;
    clearTimeout(hide);
    box.classList.toggle("ok", !off);
    box.classList.remove("float"); // offline and back online push the page down, as they may stay
    if (off) {
      text.textContent = document.querySelector(".admin")
        ? "Offline – Änderungen erst wieder mit Netz möglich."
        : `Offline – Stand ${stand()}. Aktualisiert sich, sobald wieder Netz da ist.`;
      box.hidden = false;
    } else if (live) {
      // the start page swaps in fresh data by itself
      text.textContent = "Wieder online.";
      hide = setTimeout(() => (box.hidden = true), 3000);
    } else {
      text.textContent = "Wieder online. ";
      const a = Object.assign(document.createElement("a"), { href: location.href, textContent: "Seite aktualisieren" });
      text.append(a);
    }
  };
  const check = async () => {
    if (document.hidden) return;
    try {
      // a hanging request (Wi-Fi without internet) counts as offline too
      await fetch("/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      set(false);
    } catch {
      set(true);
    }
  };
  root.style.setProperty("--stand", JSON.stringify(stand()));
  if ("fromStore" in root.dataset) set(true, false);
  addEventListener("offline", () => set(true));
  addEventListener("pagehide", () => (leaving = true));
  if (live) document.addEventListener("kk:online", (e) => set(!e.detail));
  else {
    check();
    setInterval(check, 20000);
    document.addEventListener("visibilitychange", check);
    addEventListener("online", check);
  }
  // back from the back/forward cache: report again (live.js refreshes on visibilitychange by itself)
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    leaving = false;
    if (!live) check();
  });

  // Service worker: stores the public pages for when the network is gone. html[data-sw=off] (SERVICE_WORKER=off on
  // the server) removes it instead. The first time everything is stored, the bar says so once.
  if (!("serviceWorker" in navigator)) return;
  if (root.dataset.sw === "off") {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    return;
  }
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.ready.then(() => {
    try {
      if (localStorage.getItem("offline-ready")) return;
      localStorage.setItem("offline-ready", "1");
    } catch {
      return;
    }
    if (!box || offline || document.querySelector(".admin")) return;
    box.classList.add("ok", "float"); // over the page: appearing must not shift what is about to be tapped
    text.textContent = "Diese Seiten funktionieren jetzt auch ohne Netz.";
    box.hidden = false;
    hide = setTimeout(() => (box.hidden = true), 6000);
  });
})();

// "Als App installieren" on the start page: Chrome/Edge/Android offer their install dialog (beforeinstallprompt),
// on iPhone/iPad it explains the share menu; other browsers (Firefox on the desktop) cannot install, so nothing
// shows. Hidden for good once installed or after "Nicht jetzt".
(() => {
  const card = document.querySelector(".installhint");
  if (!card) return;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let dismissed = false;
  try { dismissed = !!localStorage.getItem("install-dismissed"); } catch {}
  if (standalone || dismissed) return;
  const install = card.querySelector("[data-install]");
  const close = () => {
    card.hidden = true;
    try { localStorage.setItem("install-dismissed", "1"); } catch {}
  };
  let prompt = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    prompt = e;
    install.hidden = false;
    card.hidden = false;
  });
  install.addEventListener("click", async () => {
    if (!prompt) return;
    prompt.prompt();
    if ((await prompt.userChoice).outcome === "accepted") close();
    prompt = null;
  });
  addEventListener("appinstalled", close);
  card.querySelector("[data-dismiss]").addEventListener("click", close);
  // iPadOS reports itself as a Mac; the touch points tell them apart
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (ios) {
    card.querySelector(".ios").hidden = false;
    card.hidden = false;
  }
})();
