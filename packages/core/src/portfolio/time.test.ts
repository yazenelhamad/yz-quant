import { describe, expect, it } from "vitest";
import { isValidIso, isValidTimeZone, parseHHMM, shiftDateKey, zonedParts } from "./time.js";

describe("zonedParts", () => {
  it("converts UTC to America/New_York during EDT", () => {
    const p = zonedParts("2026-09-28T14:30:00Z", "America/New_York");
    expect(p).not.toBeNull();
    expect(p?.hour).toBe(10);
    expect(p?.minute).toBe(30);
    expect(p?.minutesOfDay).toBe(630);
    expect(p?.dateKey).toBe("2026-09-28");
    expect(p?.weekday).toBe(1); // Monday
  });

  it("converts UTC to America/New_York during EST", () => {
    const p = zonedParts("2026-01-15T14:30:00Z", "America/New_York");
    expect(p?.hour).toBe(9);
    expect(p?.minute).toBe(30);
  });

  it("crosses the date line correctly", () => {
    const p = zonedParts("2026-09-28T02:00:00Z", "America/New_York");
    expect(p?.dateKey).toBe("2026-09-27");
    expect(p?.hour).toBe(22);
    expect(p?.weekday).toBe(0); // Sunday
  });

  it("handles midnight as hour 0 (not 24)", () => {
    const p = zonedParts("2026-09-28T04:00:00Z", "America/New_York");
    expect(p?.hour).toBe(0);
  });

  it("returns null for invalid input", () => {
    expect(zonedParts("not-a-date", "America/New_York")).toBeNull();
    expect(zonedParts("2026-09-28T14:30:00Z", "Mars/Olympus")).toBeNull();
  });
});

describe("helpers", () => {
  it("validates ISO strings and timezones", () => {
    expect(isValidIso("2026-09-28T14:30:00Z")).toBe(true);
    expect(isValidIso("garbage")).toBe(false);
    expect(isValidIso(null)).toBe(false);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Nowhere/Land")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("parses HH:MM", () => {
    expect(parseHHMM("09:35")).toBe(575);
    expect(parseHHMM("15:50")).toBe(950);
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("9:35")).toBeNull();
  });

  it("shifts date keys across month boundaries", () => {
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateKey("2026-09-28", 0)).toBe("2026-09-28");
  });
});
