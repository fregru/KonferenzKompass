import { Marked } from "marked";

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function safeUrl(url: string, allowContact = false): string | null {
  const u = url.trim();
  const ok = allowContact ? /^(https?:\/\/|mailto:|tel:)/i : /^https?:\/\//i;
  return ok.test(u) ? u : null;
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = /^\/(?!\/)/.test(href) ? href : safeUrl(href, true); // site-relative links like /p/hilfe
      return url ? `<a href="${escape(url)}" rel="noopener">${text}</a>` : text;
    },
    image: ({ text }) => escape(text), // no remote images: privacy
  },
});

// "<" is escaped up front so raw HTML never forms an HTML block; the html renderer is a second guard.
export const renderMarkdown = (md: string): string => marked.parse(md.replace(/</g, "&lt;"), { async: false });
