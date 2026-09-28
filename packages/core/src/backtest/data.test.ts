import { describe, expect, it } from "vitest";
import {
  applyCorporateActions,
  assertNoLookahead,
  fingerprint,
  isDelistedAt,
  LookaheadError,
  sliceUpTo,
  tradingDays,
  universeAt,
  validateDataset,
  DatasetError,
  type BacktestDataset,
} from "./data.js";
import { generateSyntheticDataset, syntheticCalendar } from "./synthetic.js";
import { barsFromCloses } from "./test-helpers.js";

const times = syntheticCalendar("2024-01-01T00:00:00.000Z", 10);

describe("sliceUpTo", () => {
  const bars = barsFromCloses("AAA", times, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  it("returns bars strictly at or before asOf", () => {
    const slice = sliceUpTo(bars, times[4] as string);
    expect(slice).toHaveLength(5);
    expect(slice[slice.length - 1]?.time).toBe(times[4]);
    for (const b of slice) expect(Date.parse(b.time)).toBeLessThanOrEqual(Date.parse(times[4] as string));
  });

  it("handles asOf between bars and before the first bar", () => {
    const between = new Date(Date.parse(times[2] as string) + 3600_000).toISOString();
    expect(sliceUpTo(bars, between)).toHaveLength(3);
    expect(sliceUpTo(bars, "2023-01-01T00:00:00.000Z")).toHaveLength(0);
  });

  it("drops interpolated bars by default", () => {
    const withGap = bars.map((b, i) => (i === 1 ? { ...b, interpolated: true } : b));
    expect(sliceUpTo(withGap, times[9] as string)).toHaveLength(9);
    expect(sliceUpTo(withGap, times[9] as string, { includeInterpolated: true })).toHaveLength(10);
  });

  it("does not mutate the input", () => {
    const before = bars.length;
    sliceUpTo(bars, times[3] as string);
    expect(bars).toHaveLength(before);
  });
});

describe("assertNoLookahead", () => {
  const bars = barsFromCloses("AAA", times, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  it("throws when a bar is after asOf", () => {
    expect(() => assertNoLookahead(bars, times[3] as string)).toThrow(LookaheadError);
  });
  it("passes for a proper slice", () => {
    expect(() => assertNoLookahead(sliceUpTo(bars, times[3] as string), times[3] as string)).not.toThrow();
  });
});

describe("fingerprint", () => {
  it("is stable for identical datasets and changes when data changes", () => {
    const a = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 50, seed: 1 });
    const b = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 50, seed: 1 });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
    const c = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 50, seed: 2 });
    expect(fingerprint(c)).not.toBe(fingerprint(a));
    const d = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 51, seed: 1 });
    expect(fingerprint(d)).not.toBe(fingerprint(a));
  });

  it("is independent of symbol ordering", () => {
    const a = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 20, seed: 3 });
    const swapped: BacktestDataset = { ...a, symbols: ["BBB", "AAA"] };
    expect(fingerprint(swapped)).toBe(fingerprint(a));
  });
});

describe("applyCorporateActions", () => {
  it("back-adjusts prices and volume before a split", () => {
    const bars = barsFromCloses("AAA", times.slice(0, 4), [100, 102, 51, 52], 1000);
    const adjusted = applyCorporateActions(bars, [{ symbol: "AAA", date: times[2] as string, kind: "split", ratio: 2 }]);
    expect(adjusted[0]?.close).toBeCloseTo(50);
    expect(adjusted[1]?.close).toBeCloseTo(51);
    expect(adjusted[0]?.volume).toBe(2000);
    expect(adjusted[2]?.close).toBe(51);
    expect(adjusted.every((b) => b.adjusted === "split")).toBe(true);
    // Original untouched.
    expect(bars[0]?.close).toBe(100);
    expect(bars[0]?.adjusted).toBe("none");
  });

  it("adjusts for dividends only in 'all' mode", () => {
    const bars = barsFromCloses("AAA", times.slice(0, 3), [100, 100, 99]);
    const splitOnly = applyCorporateActions(bars, [{ symbol: "AAA", date: times[2] as string, kind: "dividend", amount: 1 }], "split");
    expect(splitOnly[1]?.close).toBe(100);
    const all = applyCorporateActions(bars, [{ symbol: "AAA", date: times[2] as string, kind: "dividend", amount: 1 }], "all");
    expect(all[1]?.close).toBeCloseTo(99);
    expect(all[0]?.adjusted).toBe("all");
  });

  it("ignores actions for other symbols and already-adjusted bars", () => {
    const bars = barsFromCloses("AAA", times.slice(0, 3), [10, 10, 10]).map((b) => ({ ...b, adjusted: "all" as const }));
    const out = applyCorporateActions(bars, [{ symbol: "AAA", date: times[1] as string, kind: "split", ratio: 2 }]);
    expect(out[0]?.close).toBe(10);
  });
});

describe("survivorship helpers", () => {
  const dataset = generateSyntheticDataset({ symbols: ["AAA", "BBB", "CCC"], bars: 30, seed: 9, delistings: [{ symbol: "CCC", atBar: 15 }] });
  const cal = dataset.calendar as string[];

  it("includes not-yet-delisted names and excludes them after delisting", () => {
    expect(universeAt(dataset, cal[5] as string)).toEqual(["AAA", "BBB", "CCC"]);
    expect(universeAt(dataset, cal[15] as string)).toEqual(["AAA", "BBB"]);
    expect(universeAt(dataset, cal[20] as string)).toEqual(["AAA", "BBB"]);
    expect(isDelistedAt(dataset, "CCC", cal[14] as string)).toBe(false);
    expect(isDelistedAt(dataset, "CCC", cal[15] as string)).toBe(true);
  });

  it("excludes ever-delisted names when includeDelisted is false (explicit survivorship bias)", () => {
    expect(universeAt(dataset, cal[5] as string, false)).toEqual(["AAA", "BBB"]);
  });

  it("tradingDays respects the window", () => {
    const days = tradingDays(dataset, cal[3] as string, cal[7] as string);
    expect(days).toEqual(cal.slice(3, 8));
  });

  it("validateDataset rejects unordered bars", () => {
    const bad: BacktestDataset = { ...dataset, bars: { ...dataset.bars, AAA: [...(dataset.bars.AAA as never[])].reverse() } };
    expect(() => validateDataset(bad)).toThrow(DatasetError);
    expect(validateDataset(dataset)).toEqual([]);
  });
});
