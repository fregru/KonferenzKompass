// Darkmode: follows the device ("Automatisch") unless the footer switch stored "light" or "dark" in this browser.
// Loaded blocking in <head> so the page never flashes in the wrong theme. Without JS the CSS still follows the
// device; only the switch stays hidden.
(() => {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;

  document.addEventListener("DOMContentLoaded", () => {
    for (const box of document.querySelectorAll(".themeswitch")) {
      const current = box.querySelector(`input[value="${root.dataset.theme || "auto"}"]`);
      if (current) current.checked = true;
      box.hidden = false;
    }
  });
  document.addEventListener("change", (e) => {
    if (!e.target.matches?.(".themeswitch input")) return;
    const value = e.target.value;
    if (value === "auto") delete root.dataset.theme;
    else root.dataset.theme = value;
    try { value === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", value); } catch {}
  });
})();
