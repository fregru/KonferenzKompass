import { test, expect } from "bun:test";
import { computeDay, plannedNowId, type Item, type LiveInput } from "./schedule";
import { toMinutes as m } from "./time";

const day = (done: string[] = []): Item[] =>
  ([
    [1, "A", "09:00", "10:00", "agenda"],
    [2, "B", "10:00", "11:00", "agenda"],
    [3, "C", "11:00", "12:00", "agenda"],
    [4, "M", "12:00", "13:00", "break"],
    [5, "D", "13:00", "14:00", "agenda"],
  ] as const).map(([id, name, start, end, kind]) => ({ id, start, end, kind, done: done.includes(name) }));

const live = (currentItemId: number | null, startedAt: string | null, more: Partial<LiveInput> = {}): LiveInput => ({
  currentItemId, startedAt: startedAt === null ? null : m(startedAt), elapsedBefore: 0, pause: null, ...more,
});
const pause = (start: string, until: string) => ({ title: "Pause", start: m(start), until: m(until), untilMs: 0 });

const starts = (rows: ReturnType<typeof computeDay>) => Object.fromEntries(rows.map((r) => [r.id, r.expectedStart]));

test("no live → planned times", () => {
  const rows = computeDay(day(), null, m("08:00"));
  expect(starts(rows)).toEqual({ 1: m("09:00"), 2: m("10:00"), 3: m("11:00"), 4: m("12:00"), 5: m("13:00") });
  expect(rows.every((r) => r.status === "upcoming")).toBe(true);
});

test("overrun pushes everything incl. breaks", () => {
  const rows = computeDay(day(), live(1, "09:00"), m("10:20"));
  expect(rows[0]).toMatchObject({ status: "current", overrun: true, expectedEnd: m("10:20") });
  expect(starts(rows)).toMatchObject({ 2: m("10:20"), 3: m("11:20"), 4: m("12:20"), 5: m("13:20") });
});

test("early finish pulls agenda forward, not breaks", () => {
  const rows = computeDay(day(["A"]), live(2, "09:50"), m("10:00"));
  expect(rows[0]!.status).toBe("done");
  expect(rows[1]).toMatchObject({ status: "current", overrun: false, expectedEnd: m("10:50") });
  expect(starts(rows)).toMatchObject({ 3: m("10:50"), 4: m("12:00"), 5: m("13:00") });
});

test("pause interrupts agenda item, remainder after the pause; planned break moves back", () => {
  const rows = computeDay(day(["A", "B"]), live(3, null, { elapsedBefore: 45, pause: pause("11:45", "12:15") }), m("12:00"));
  expect(rows[2]).toMatchObject({ status: "interrupted", expectedStart: m("12:15"), expectedEnd: m("12:30") });
  expect(starts(rows)).toMatchObject({ 4: m("12:30"), 5: m("13:30") });
  expect(rows.some((r) => r.status === "current")).toBe(false);
});

test("overrun pause keeps pushing back until Weiter", () => {
  const rows = computeDay(day(["A", "B"]), live(3, null, { elapsedBefore: 45, pause: pause("11:45", "12:15") }), m("12:25"));
  expect(rows[2]!.expectedStart).toBe(m("12:25"));
  expect(rows[3]!.expectedStart).toBe(m("12:40"));
});

test("pause with nothing behind it does not pull the next entry forward", () => {
  const rows = computeDay(day(), live(null, null, { pause: pause("08:00", "08:15") }), m("08:05"));
  expect(starts(rows)).toMatchObject({ 1: m("09:00"), 2: m("10:00") });
  const late = computeDay(day(), live(null, null, { pause: pause("08:50", "09:20") }), m("09:00"));
  expect(starts(late)).toMatchObject({ 1: m("09:20"), 2: m("10:20") });
});

test("resumed item uses remaining duration", () => {
  const rows = computeDay(day(["A", "B", "M"]), live(3, "13:15", { elapsedBefore: 45 }), m("13:20"));
  expect(rows[2]).toMatchObject({ status: "current", expectedEnd: m("13:30"), overrun: false });
  expect(rows[4]!.expectedStart).toBe(m("13:30"));
});

test("skipped item stays upcoming", () => {
  const rows = computeDay(day(["A"]), live(3, "10:00"), m("10:10"));
  expect(rows[1]!.status).toBe("upcoming");
  expect(starts(rows)).toMatchObject({ 2: m("11:00"), 4: m("12:00"), 5: m("13:00") });
});

test("plannedNowId", () => {
  expect(plannedNowId(day(), m("10:30"))).toBe(2);
  expect(plannedNowId(day(), m("14:30"))).toBeNull();
});

test("item past midnight has positive duration", () => {
  const items: Item[] = [{ id: 9, start: "21:00", end: "01:00", kind: "agenda", done: false }];
  const rows = computeDay(items, live(9, "21:00"), m("22:00"));
  expect(rows[0]).toMatchObject({ overrun: false, expectedEnd: 1500 });
});

test("entries after midnight belong to the evening before: plan and delays run on past 24:00", () => {
  const night: Item[] = [
    { id: 1, start: "22:00", end: "01:00", kind: "agenda", done: false },
    { id: 2, start: "01:00", end: "02:00", kind: "agenda", done: false },
  ];
  expect(plannedNowId(night, 1440 + 90)).toBe(2);
  const rows = computeDay(night, live(1, "22:00"), 1440 + 70);
  expect(rows[0]).toMatchObject({ status: "current", overrun: true });
  expect(rows[1]!.expectedStart).toBe(1440 + 70);
});
