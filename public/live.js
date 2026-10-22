// Polls the live part of the start page every 20 s; ETag keeps unchanged responses empty.
(() => {
  const el = document.getElementById("live");
  if (!el) return;
  let etag = el.dataset.etag || null;
  let busy = false;
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      // a hanging request (Wi-Fi without internet) counts as offline too
      const res = await fetch("/api/live", { headers: etag ? { "If-None-Match": etag } : {}, cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (res.status === 200) {
        const open = [...el.querySelectorAll("details")].map((d) => d.open);
        el.innerHTML = await res.text();
        el.querySelectorAll("details").forEach((d, i) => { if (i < open.length) d.open = open[i]; });
        etag = res.headers.get("ETag");
      }
      if (res.ok || res.status === 304) {
        el.classList.remove("stale");
        // the data on screen is current now: "Stand" for the offline notice (site.js)
        document.documentElement.dataset.stand = String(Date.now());
        document.dispatchEvent(new CustomEvent("kk:online", { detail: true }));
      }
    } catch {
      el.classList.add("stale");
      document.dispatchEvent(new CustomEvent("kk:online", { detail: false }));
    } finally {
      busy = false;
    }
  }
  // "#e12" (back from the Lageplan): open that entry's day and bring it into view
  const target = /^#e\d+$/.test(location.hash) && document.getElementById(location.hash.slice(1));
  if (target) {
    const day = target.closest("details");
    if (day && !day.open) day.open = true;
    target.scrollIntoView({ block: "center" });
  }
  // right away too: a page the service worker served from its cache then shows "Offline · Stand hh:mm" at once
  refresh();
  setInterval(refresh, 20000);
  document.addEventListener("visibilitychange", refresh);
  addEventListener("online", refresh);
})();
