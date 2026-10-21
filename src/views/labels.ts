import type { ItemRow } from "../db";

/** "TOP 3 Wahlen", or just the title; `sep` goes between number and title. */
export const itemLabel = (i: Pick<ItemRow, "top_number" | "title">, sep = " ") => [i.top_number, i.title].filter(Boolean).join(sep);
