import { test, expect } from "bun:test";
import { berlinNow, dayLabel, duration, fmt, isDate, toMinutes } from "./time";

test("toMinutes/fmt", () => {
  expect(toMinutes("09:30")).toBe(570);
  expect(fmt(570)).toBe("09:30");
  expect(fmt(1500)).toBe("01:00");
});

test("duration past midnight", () => {
  expect(duration("21:00", "01:00")).toBe(240);
  expect(duration("09:00", "10:00")).toBe(60);
});

test("berlinNow uses Europe/Berlin", () => {
  expect(berlinNow(new Date("2026-10-11T22:30:00Z"))).toEqual({ date: "2026-10-12", minutes: 30 }); // CEST
  expect(berlinNow(new Date("2026-12-01T08:00:00Z"))).toEqual({ date: "2026-12-01", minutes: 540 }); // CET
});

test("dayLabel has exactly one trailing dot", () => {
  expect(dayLabel("2026-11-13")).toBe("Freitag, 13.11.");
});

test("isDate accepts real calendar days only", () => {
  expect(isDate("2026-11-13")).toBe(true);
  expect(isDate("2028-02-29")).toBe(true);
  for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10", "2026-1-5", "13.11.2026", ""]) expect(isDate(bad)).toBe(false);
});
