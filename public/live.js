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
      const res = await fetch("/api/live", { headers: etag ? { "If-None-Match": etag } : {}, cache: "no-store" });
      if (res.status === 200) {
        const open = [...el.querySelectorAll("details")].map((d) => d.open);
        el.innerHTML = await res.text();
        el.querySelectorAll("details").forEach((d, i) => { if (i < open.length) d.open = open[i]; });
        etag = res.headers.get("ETag");
      }
      if (res.ok || res.status === 304) el.classList.remove("stale");
    } catch {
      el.classList.add("stale");
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
  setInterval(refresh, 20000);
  document.addEventListener("visibilitychange", refresh);
})();
