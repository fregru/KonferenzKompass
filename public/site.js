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
(() => {
  const root = document.documentElement;
  const box = document.querySelector(".offlinebar");
  const text = box?.querySelector("p");
  const live = document.getElementById("live");
  const stand = () => new Date(Number(root.dataset.stand)).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
  let offline = false;
  let hide;
  const set = (off) => {
    root.style.setProperty("--stand", JSON.stringify(stand()));
    if (off === offline) return;
    offline = off;
    root.classList.toggle("offline", off);
    if (!box) return;
    clearTimeout(hide);
    box.classList.toggle("back", !off);
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
      await fetch("/health", { cache: "no-store" });
      set(false);
    } catch {
      set(true);
    }
  };
  root.style.setProperty("--stand", JSON.stringify(stand()));
  addEventListener("offline", () => set(true));
  if (live) document.addEventListener("kk:online", (e) => set(!e.detail));
  else {
    check();
    setInterval(check, 20000);
    document.addEventListener("visibilitychange", check);
    addEventListener("online", check);
  }
})();
// App zum Installieren: the service worker keeps the last state of the public pages for when the network is gone.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
