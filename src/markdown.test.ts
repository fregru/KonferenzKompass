import { test, expect } from "bun:test";
import { renderMarkdown, safeUrl } from "./markdown";

test("raw HTML is escaped", () => {
  const h = renderMarkdown("<script>alert(1)</script> **fett**");
  expect(h).not.toContain("<script>");
  expect(h).toContain("&lt;script&gt;");
  expect(h).toContain("<strong>fett</strong>");
});

test("unsafe link schemes dropped", () => {
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
  expect(renderMarkdown("[x](https://a.de)")).toContain('href="https://a.de"');
});

test("safeUrl", () => {
  expect(safeUrl("https://a.de")).toBe("https://a.de");
  expect(safeUrl("javascript:x")).toBeNull();
  expect(safeUrl("mailto:a@b.de")).toBeNull();
  expect(safeUrl("mailto:a@b.de", true)).toBe("mailto:a@b.de");
});

test("site-relative links are kept, protocol-relative ones dropped", () => {
  expect(renderMarkdown("[Hilfe](/p/hilfe)")).toContain('href="/p/hilfe"');
  expect(renderMarkdown("[x](//evil.example)")).not.toContain("evil.example\"");
});
