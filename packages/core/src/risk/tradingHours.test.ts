import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_SETTINGS } from "../types/index.js";
import { isWithinEntryWindow } from "./tradingHours.js";

const hours = DEFAULT_RISK_SETTINGS.tradingHours; // 09:35-15:50 America/New_York

describe("isWithinEntryWindow", () => {
  it("handles DST: the same UTC instant is inside in summer and outside in winter", () => {
    expect(isWithinEntryWindow("2026-07-15T13:40:00Z", hours).inside).toBe(true); // 09:40 EDT
    expect(isWithinEntryWindow("2026-01-15T13:40:00Z", hours).inside).toBe(false); // 08:40 EST
    expect(isWithinEntryWindow("2026-01-15T14:40:00Z", hours).inside).toBe(true); // 09:40 EST
  });

  it("is inclusive at both ends", () => {
    expect(isWithinEntryWindow("2026-09-28T13:35:00Z", hours).inside).toBe(true);
    expect(isWithinEntryWindow("2026-09-28T19:50:59Z", hours).inside).toBe(true);
    expect(isWithinEntryWindow("2026-09-28T19:51:00Z", hours).inside).toBe(false);
  });

  it("reports local time and weekday", () => {
    const r = isWithinEntryWindow("2026-09-28T14:30:00Z", hours);
    expect(r.localTime).toBe("10:30");
    expect(r.weekday).toBe(1);
    expect(r.reason).toContain("inside");
  });

  it("excludes weekends", () => {
    const r = isWithinEntryWindow("2026-09-27T14:30:00Z", hours);
    expect(r.inside).toBe(false);
    expect(r.reason).toContain("weekend");
  });

  it("fails closed on malformed configuration or timestamps", () => {
    expect(isWithinEntryWindow("2026-09-28T14:30:00Z", { ...hours, start: "9:35" }).inside).toBe(false);
    expect(isWithinEntryWindow("2026-09-28T14:30:00Z", { ...hours, timezone: "Nowhere/City" }).inside).toBe(false);
    expect(isWithinEntryWindow("garbage", hours).inside).toBe(false);
    expect(isWithinEntryWindow("2026-09-28T14:30:00Z", { ...hours, start: "16:00", end: "09:00" }).inside).toBe(false);
  });
});
