/** UTF-8 (with or without BOM), otherwise Windows-1252 as written by German Excel or an "ANSI" editor. */
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const UMLAUTS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/** ASCII file name part: "Großer Saal" → "grosser-saal"; `fallback` when nothing is left. */
export const slug = (s: string, fallback: string) =>
  s
    .toLowerCase()
    .replace(/[äöüß]/g, (ch) => UMLAUTS[ch]!)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || fallback;

/** Download header with an ASCII name for old clients and the real (UTF-8) name per RFC 5987. */
export const attachment = (asciiName: string, realName = asciiName) =>
  `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(realName)}`;
