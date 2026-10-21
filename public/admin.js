// Submits admin forms in the background and swaps only the admin content, so the page keeps its scroll position.
// Without JS the forms still work as normal posts.
(() => {
  // Live control: open the schedule list at today's day heading.
  const plan = document.querySelector(".planscroll");
  const today = plan?.querySelector("#today");
  if (plan && today) plan.scrollTop += today.getBoundingClientRect().top - plan.getBoundingClientRect().top;

  /** Replaces the admin content with the one in `doc`, keeping the schedule list's scroll position. */
  function swap(doc, next) {
    const scrollTop = document.querySelector(".planscroll")?.scrollTop;
    document.querySelector(".admin").replaceWith(next);
    const plan = document.querySelector(".planscroll");
    if (plan && scrollTop !== undefined) plan.scrollTop = scrollTop;
    document.title = doc.title;
    initSortable();
  }

  let posting = 0; // posts in flight
  let posted = 0; // posts started so far; a poll that overlaps one is dropped

  /** Posts `body` and swaps in the new admin content; rejects on network trouble. */
  async function send(action, body) {
    posting++;
    posted++;
    try {
      const res = await fetch(action, { method: "POST", body });
      const target = new URL(res.url);
      if (res.redirected && target.pathname !== location.pathname) return location.assign(res.url);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const next = doc.querySelector(".admin");
      if (!next) {
        if (res.ok) return location.assign(res.url);
        throw new Error(String(res.status)); // e.g. a rejected post: the caller falls back to a normal submit
      }
      swap(doc, next);
    } finally {
      posting--;
    }
  }

  // Übersicht: pages with data-etag reload themselves when someone else changed something (checked every 15 s), but
  // not while this person is busy with a form or an open "Pause starten…".
  let polling = false;
  async function poll() {
    const tagged = document.querySelector(".admin [data-etag]");
    const admin = document.querySelector(".admin");
    if (!tagged || polling || posting || document.hidden) return;
    if (admin.querySelector("details[open]") || (admin.contains(document.activeElement) && document.activeElement.matches("input, select, textarea")))
      return;
    polling = true;
    const before = posted;
    try {
      const res = await fetch(location.pathname, { headers: { "If-None-Match": tagged.dataset.etag }, cache: "no-store" });
      document.querySelector(".admin").classList.remove("stale");
      if (res.redirected) return clearInterval(timer); // signed out: stop asking
      if (res.status !== 200 || posted !== before) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const next = doc.querySelector(".admin");
      const admin = document.querySelector(".admin");
      if (next && posted === before && !admin.querySelector("details[open]")) swap(doc, next);
    } catch {
      document.querySelector(".admin").classList.add("stale");
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(poll, 15000);
  document.addEventListener("visibilitychange", poll);

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.method !== "post" || form.closest(".adminbar, .adminmenu")) return;
    e.preventDefault();
    const submitter = e.submitter;
    const action = submitter?.getAttribute("formaction") ? submitter.formAction : form.action;
    if (submitter) submitter.disabled = true;
    try {
      await send(action, new FormData(form, submitter));
    } catch {
      form.submit(); // network trouble: fall back to a normal post
    } finally {
      if (submitter) submitter.disabled = false;
    }
  });

  // Sicherung: "Alle auswählen" / "Keine" for the export checkboxes.
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element && e.target.closest("button[data-check]");
    if (!btn) return;
    for (const box of btn.form.querySelectorAll("input[type=checkbox]")) box.checked = btn.dataset.check === "1";
  });

  // Schedule: drag entries by their handle, also between days. The arrows remain for keyboard and no-JS use.
  function initSortable() {
    if (!window.Sortable) return;
    for (const list of document.querySelectorAll("[data-sortable]")) {
      Sortable.create(list, {
        group: "plan",
        handle: ".handle",
        animation: 150,
        onEnd(e) {
          if (e.from === e.to && e.oldIndex === e.newIndex) return;
          const body = new FormData();
          body.set("date", e.to.dataset.sortable);
          body.set("index", String(e.newIndex));
          send(`/admin/items/${e.item.dataset.id}/move`, body).catch(() => location.reload());
        },
      });
    }
  }
  initSortable();
})();
