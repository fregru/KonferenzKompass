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
