// Lageplan editor: draw room outlines on a floor plan. Points are stored in percent of the plan, so they fit any size.
// Vieleck: each click adds a corner; Rechteck: drag. Corners can be dragged; Backspace removes the last one.
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const clamp = (v) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;
  /** Label position: centroid, or the bounding box centre for degenerate shapes (mirrors centre() in src/rooms.ts). */
  function centre(pts) {
    let a = 0, cx = 0, cy = 0;
    pts.forEach(([x0, y0], i) => {
      const [x1, y1] = pts[(i + 1) % pts.length];
      const f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    });
    if (Math.abs(a) < 1e-6) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  function init(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = "1";
    const floorId = Number(root.dataset.floor);
    const rooms = JSON.parse(document.getElementById("rooms-data").textContent);
    const plan = root.querySelector(".floorplan");
    const svg = plan.querySelector("svg");
    const statusEl = root.querySelector("[data-status]");
    plan.querySelectorAll(".roomlabel").forEach((e) => e.remove());
    const layer = document.createElement("div");
    layer.className = "handles";
    plan.append(layer);
    plan.classList.add("editing");

    let sel = null, pts = [], mode = "poly", dirty = false, drag = null;
    const status = (msg, error = false) => { statusEl.textContent = msg; statusEl.classList.toggle("error", error); };
    const pos = (e) => {
      const r = plan.getBoundingClientRect();
      return [clamp(((e.clientX - r.left) / r.width) * 100), clamp(((e.clientY - r.top) / r.height) * 100)];
    };

    function render() {
      svg.replaceChildren();
      layer.replaceChildren();
      for (const r of rooms) {
        const shape = r === sel ? pts : r.floor_id === floorId ? r.shape : null;
        if (!shape || shape.length < 2) continue;
        const el = document.createElementNS(NS, shape.length > 2 ? "polygon" : "polyline");
        el.setAttribute("points", shape.map((p) => p.join(",")).join(" "));
        el.setAttribute("class", r === sel ? "editing" : "room");
        svg.append(el);
        if (shape.length > 2) {
          const [x, y] = centre(shape);
          const l = document.createElement("span");
          l.className = `roomlabel${r === sel ? " active" : ""}`;
          l.style.left = `${x}%`;
          l.style.top = `${y}%`;
          l.textContent = r.name;
          layer.append(l);
        }
      }
      if (sel)
        pts.forEach(([x, y], i) => {
          const h = document.createElement("span");
          h.className = "pt";
          h.style.left = `${x}%`;
          h.style.top = `${y}%`;
          h.dataset.i = String(i);
          h.title = `Punkt ${i + 1} – ziehen zum Verschieben`;
          layer.append(h);
        });
    }

    function select(room) {
      sel = room;
      pts = room && room.floor_id === floorId && room.shape ? room.shape.map((p) => [...p]) : [];
      dirty = false;
      const elsewhere = room && room.shape && room.floor_id !== floorId;
      status(!room ? "" : elsewhere ? `„${room.name}“ ist auf einer anderen Etage eingezeichnet; Speichern verschiebt den Raum auf diese Etage.` : pts.length ? "" : `Jetzt Eckpunkte für „${room.name}“ setzen.`);
      render();
    }
    const change = () => { dirty = true; status("Nicht gespeichert."); render(); };

    root.addEventListener("change", (e) => {
      if (e.target.name !== "room") return;
      if (dirty && !confirm("Ungespeicherte Änderungen verwerfen?")) {
        root.querySelector(`input[name=room][value="${sel.id}"]`).checked = true;
        return;
      }
      select(rooms.find((r) => r.id === Number(e.target.value)));
    });
    for (const b of root.querySelectorAll("[data-mode]"))
      b.addEventListener("click", () => {
        mode = b.dataset.mode;
        root.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });

    plan.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!sel) return status("Bitte zuerst rechts einen Raum wählen.", true);
      plan.setPointerCapture(e.pointerId);
      if (e.target.classList.contains("pt")) drag = { i: Number(e.target.dataset.i) };
      else if (mode === "rect") {
        const p = pos(e);
        drag = { rect: p };
        pts = [p, [...p], [...p], [...p]];
        change();
      } else {
        pts.push(pos(e));
        change();
      }
    });
    plan.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const [x, y] = pos(e);
      if (drag.rect) {
        const [x0, y0] = drag.rect;
        pts = [[x0, y0], [x, y0], [x, y], [x0, y]];
      } else pts[drag.i] = [x, y];
      change();
    });
    const end = () => {
      if (drag?.rect && Math.abs(pts[0][0] - pts[2][0]) + Math.abs(pts[0][1] - pts[2][1]) < 1) pts = [];
      drag = null;
      render();
    };
    plan.addEventListener("pointerup", end);
    plan.addEventListener("pointercancel", end);

    async function save() {
      if (!sel) return status("Bitte zuerst einen Raum wählen.", true);
      if (pts.length > 0 && pts.length < 3) return status("Ein Umriss braucht mindestens 3 Punkte.", true);
      const body = new FormData();
      body.set("shape", pts.length ? JSON.stringify(pts) : "");
      body.set("floor_id", String(floorId));
      status("Speichere …");
      try {
        const res = await fetch(`/admin/rooms/${sel.id}/shape`, { method: "POST", body });
        if (!res.ok) throw new Error(await res.text());
        const { shape } = await res.json();
        sel.shape = shape;
        if (shape) sel.floor_id = floorId;
        pts = shape ? shape.map((p) => [...p]) : [];
        dirty = false;
        const mark = root.querySelector(`input[name=room][value="${sel.id}"]`)?.closest("label")?.querySelector("[data-state]");
        if (mark) mark.textContent = shape ? "✓" : "";
        status(shape ? `„${sel.name}“ gespeichert.` : `Umriss von „${sel.name}“ entfernt.`);
        render();
      } catch (err) {
        status(`Speichern fehlgeschlagen: ${err.message || "Netzwerkfehler"}`, true);
      }
    }
    root.querySelector("[data-action=save]").addEventListener("click", save);
    root.querySelector("[data-action=undo]").addEventListener("click", () => { if (sel && pts.length) { pts.pop(); change(); } });
    root.querySelector("[data-action=clear]").addEventListener("click", () => { if (sel) { pts = []; change(); } });
    document.addEventListener("keydown", (e) => {
      if (!document.body.contains(root)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); return; }
      if (e.target.closest("input:not([type=radio]), textarea, select")) return;
      if ((e.key === "Backspace" || e.key === "Delete") && sel && pts.length) { e.preventDefault(); pts.pop(); change(); }
    });
    window.addEventListener("beforeunload", (e) => { if (dirty && document.body.contains(root)) e.preventDefault(); });

    const pre = rooms.find((r) => r.id === Number(root.dataset.selected));
    if (pre) {
      root.querySelector(`input[name=room][value="${pre.id}"]`).checked = true;
      select(pre);
    } else render();
  }

  const run = () => document.querySelectorAll(".mapedit").forEach(init);
  run();
  // admin.js swaps the admin content after form posts; set up the new editor then.
  new MutationObserver(run).observe(document.querySelector("main"), { childList: true, subtree: true });
})();
