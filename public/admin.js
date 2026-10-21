// Submits admin forms in the background and swaps only the admin content, so the page keeps its scroll position.
// Without JS the forms still work as normal posts.
(() => {
  // Live control: open the schedule list at today's day heading.
  const plan = document.querySelector(".planscroll");
  const today = plan?.querySelector("#today");
  if (plan && today) plan.scrollTop += today.getBoundingClientRect().top - plan.getBoundingClientRect().top;

  /** Posts `body` and swaps in the new admin content; rejects on network trouble. */
  async function send(action, body) {
    const res = await fetch(action, { method: "POST", body });
    const target = new URL(res.url);
    if (res.redirected && target.pathname !== location.pathname) return location.assign(res.url);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const next = doc.querySelector(".admin");
    if (!next) {
      if (res.ok) return location.assign(res.url);
      throw new Error(String(res.status)); // e.g. a rejected post: the caller falls back to a normal submit
    }
    const scrollTop = document.querySelector(".planscroll")?.scrollTop;
    document.querySelector(".admin").replaceWith(next);
    const plan = document.querySelector(".planscroll");
    if (plan && scrollTop !== undefined) plan.scrollTop = scrollTop;
    document.title = doc.title;
    initSortable();
  }

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
