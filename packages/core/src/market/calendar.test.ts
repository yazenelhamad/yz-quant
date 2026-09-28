import { describe, expect, it } from "vitest";
import { marketCalendarDay, marketSessionAt, minutesToClose, nyseHolidays, previousTradingDays, isWithinTradingWindow } from "./calendar.js";
import { entriesAllowed, quoteQuality } from "./freshness.js";

describe("NYSE calendar", () => {
  it("knows 2026 holidays and early closes", () => {
    const h = nyseHolidays(2026);
    expect(h.has("2026-01-01")).toBe(true);
    expect(h.has("2026-01-19")).toBe(true); // MLK
    expect(h.has("2026-02-16")).toBe(true); // Presidents
    expect(h.has("2026-04-03")).toBe(true); // Good Friday
    expect(h.has("2026-05-25")).toBe(true); // Memorial
    expect(h.has("2026-06-19")).toBe(true);
    expect(h.has("2026-07-03")).toBe(true); // July 4 observed (Saturday → Friday)
    expect(h.has("2026-09-07")).toBe(true);
    expect(h.has("2026-11-26")).toBe(true);
    expect(h.has("2026-12-25")).toBe(true);
    expect(marketCalendarDay("2026-11-27").earlyClose).toBe(true);
    expect(marketCalendarDay("2026-11-27").regularClose).toBe("2026-11-27T18:00:00.000Z");
  });
  it("computes sessions with DST", () => {
    expect(marketSessionAt(new Date("2026-09-28T14:00:00Z"))).toBe("regular"); // 10:00 EDT Monday
    expect(marketSessionAt(new Date("2026-09-28T12:00:00Z"))).toBe("pre");
    expect(marketSessionAt(new Date("2026-09-28T21:00:00Z"))).toBe("post");
    expect(marketSessionAt(new Date("2026-09-27T14:00:00Z"))).toBe("closed"); // Sunday
    expect(marketSessionAt(new Date("2026-12-15T15:00:00Z"))).toBe("regular"); // 10:00 EST
    expect(marketSessionAt(new Date("2026-12-15T14:00:00Z"))).toBe("pre"); // 09:00 EST
    expect(minutesToClose(new Date("2026-09-28T19:30:00Z"))).toBe(30);
    expect(previousTradingDays("2026-09-28", 3)).toEqual(["2026-09-25", "2026-09-24", "2026-09-23"]);
    expect(isWithinTradingWindow(new Date("2026-09-28T14:00:00Z"), { start: "09:35", end: "15:50", timezone: "America/New_York" })).toBe(true);
    expect(isWithinTradingWindow(new Date("2026-09-28T13:36:00Z"), { start: "09:35", end: "15:50", timezone: "America/New_York" })).toBe(true);
    expect(isWithinTradingWindow(new Date("2026-09-28T13:34:00Z"), { start: "09:35", end: "15:50", timezone: "America/New_York" })).toBe(false);
  });
});

describe("freshness", () => {
  it("classifies quote age and gates entries", () => {
    const now = "2026-09-28T14:00:00.000Z";
    expect(quoteQuality({ observedAt: "2026-09-28T13:59:50.000Z", reliability: 1, marketOpen: true }, now).freshness).toBe("fresh");
    expect(quoteQuality({ observedAt: "2026-09-28T13:59:00.000Z", reliability: 1, marketOpen: true }, now).freshness).toBe("aging");
    expect(quoteQuality({ observedAt: "2026-09-28T13:50:00.000Z", reliability: 1, marketOpen: true }, now).freshness).toBe("stale");
    expect(quoteQuality({ observedAt: null, reliability: 1, marketOpen: true }, now).freshness).toBe("unknown");
    expect(entriesAllowed("fresh", "aging").allowed).toBe(true);
    expect(entriesAllowed("fresh", "stale").allowed).toBe(false);
    expect(entriesAllowed("unknown").allowed).toBe(false);
  });
});
