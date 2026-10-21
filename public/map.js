// Lageplan: filters the room list while typing. Without JS the full list stays visible.
(() => {
  const input = document.querySelector("[data-roomfilter]");
  if (!input) return;
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  input.addEventListener("input", () => {
    const q = norm(input.value.trim());
    let hits = 0;
    for (const group of document.querySelectorAll(".roomgroup")) {
      let shown = 0;
      for (const li of group.querySelectorAll("li[data-name]")) {
        const ok = !q || norm(li.dataset.name).includes(q);
        li.hidden = !ok;
        if (ok) shown++;
      }
      group.hidden = shown === 0;
      hits += shown;
    }
    document.querySelector("[data-nohits]").hidden = hits > 0;
  });
  // Enter jumps to the only (or first) hit.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = document.querySelector(".roomlist li:not([hidden]) a");
    if (first) location.assign(first.href);
  });
})();

// Floor plan labels: write room names out in full where they fit; keep the short name where the full one would
// leave the plan, cover a neighbouring room or overlap another label. Re-fitted whenever the plan changes size.
(() => {
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  function fit(plan) {
    const labels = [...plan.querySelectorAll(".roomlabel[data-full]")];
    if (!labels.length) return;
    const p = plan.getBoundingClientRect();
    // room boxes in pixels, relative to the viewport like getBoundingClientRect()
    const rooms = labels.map((l) => {
      const [x0, y0, x1, y1] = l.dataset.box.split(",").map(Number);
      return { left: p.left + (x0 / 100) * p.width, top: p.top + (y0 / 100) * p.height, right: p.left + (x1 / 100) * p.width, bottom: p.top + (y1 / 100) * p.height };
    });
    for (const l of labels) {
      l.textContent = l.dataset.short;
      l.classList.remove("full");
    }
    // big rooms first: they have the most space and are worth naming
    const order = labels.map((l, i) => i).sort((a, b) => {
      const area = (r) => (r.right - r.left) * (r.bottom - r.top);
      return area(rooms[b]) - area(rooms[a]);
    });
    for (const i of order) {
      const l = labels[i];
      if (l.dataset.full === l.dataset.short) continue;
      l.textContent = l.dataset.full;
      l.classList.add("full");
      const r = l.getBoundingClientRect();
      const centre = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      const ok =
        r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom &&
        labels.every((o, j) => j === i || !overlap(r, o.getBoundingClientRect())) &&
        rooms.every((o, j) => {
          if (j === i || !overlap(r, o)) return true;
          // an area around this room (e.g. a courtyard with rooms inside) is no conflict
          return centre.x >= o.left && centre.x <= o.right && centre.y >= o.top && centre.y <= o.bottom;
        });
      if (!ok) {
        l.textContent = l.dataset.short;
        l.classList.remove("full");
      }
    }
  }
  function watch(plan) {
    fit(plan);
    if ("ResizeObserver" in window) new ResizeObserver(() => fit(plan)).observe(plan);
    // the plan image may load after this script ran
    plan.querySelector("img")?.addEventListener("load", () => fit(plan));
  }
  document.querySelectorAll(".floorplan").forEach(watch);

  // "Zurück zum Zeitplan": when the agenda is the page we came from, go back in history, so it reappears exactly as
  // left (scroll position, open day). Otherwise the link opens the start page at the entry.
  document.querySelector("[data-back]")?.addEventListener("click", (e) => {
    let ref = null;
    try {
      ref = document.referrer && new URL(document.referrer);
    } catch {}
    if (!ref || ref.origin !== location.origin || ref.pathname !== "/") return;
    e.preventDefault();
    history.go(-((history.state?.depth ?? 0) + 1));
  });

  // Picking a room or floor swaps the map and room details in place instead of reloading, so the page keeps its
  // scroll position. Picks from the room list below still scroll up to the map. Without JS the links simply reload.
  const view = document.querySelector("[data-mapview]");
  if (!view || !window.fetch || !window.DOMParser) return;
  async function show(url, push) {
    let html;
    try {
      const res = await fetch(url, { headers: { Accept: "text/html" } });
      if (!res.ok) throw new Error(String(res.status));
      html = await res.text();
    } catch {
      location.assign(url);
      return;
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const next = doc.querySelector("[data-mapview]");
    if (!next) return location.assign(url);
    view.replaceChildren(...next.childNodes);
    view.querySelectorAll(".floorplan").forEach(watch);
    // keep the current-room marker in the room list in step
    const fresh = new Map([...doc.querySelectorAll(".roomlist a")].map((a) => [a.getAttribute("href"), a.getAttribute("aria-current")]));
    for (const a of document.querySelectorAll(".roomlist a")) {
      const cur = fresh.get(a.getAttribute("href"));
      if (cur) a.setAttribute("aria-current", cur);
      else a.removeAttribute("aria-current");
    }
    // depth: room picks since arriving, so "Zurück zum Zeitplan" can skip them
    if (push) history.pushState({ depth: (history.state?.depth ?? 0) + 1 }, "", url);
  }
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || !(view.contains(a) || a.closest(".roomlist"))) return;
    const url = new URL(a.getAttribute("href"), location.href); // SVG links have no plain .href string
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    e.preventDefault();
    const fromList = !view.contains(a);
    show(url.href, true).then(() => {
      if (fromList) document.getElementById("karte")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  addEventListener("popstate", () => show(location.href, false));
})();
