import { describe, expect, it } from "vitest";
import { applyCorporateActions, validateDataset } from "./data.js";
import { bootstrapSample, fnv1a32, fnv1a64, mulberry32, randomNormal, shuffle } from "./random.js";
import { generateSyntheticBars, generateSyntheticDataset, nextTradingDay, SYNTHETIC_SOURCE, syntheticCalendar } from "./synthetic.js";

describe("random primitives", () => {
  it("mulberry32 is deterministic and uniform on [0,1)", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(mulberry32(2)()).not.toBe(mulberry32(1)());
  });

  it("normal deviates have roughly zero mean and unit variance", () => {
    const rng = mulberry32(99);
    const zs = Array.from({ length: 5000 }, () => randomNormal(rng));
    const mean = zs.reduce((s, z) => s + z, 0) / zs.length;
    const variance = zs.reduce((s, z) => s + (z - mean) ** 2, 0) / zs.length;
    expect(Math.abs(mean)).toBeLessThan(0.06);
    expect(Math.abs(variance - 1)).toBeLessThan(0.1);
  });

  it("shuffle and bootstrap preserve multiset / length", () => {
    const rng = mulberry32(3);
    const items = [1, 2, 3, 4, 5, 6];
    const shuffled = shuffle(items, rng);
    expect([...shuffled].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6]);
    const sample = bootstrapSample(items, rng);
    expect(sample).toHaveLength(6);
    for (const s of sample) expect(items).toContain(s);
    expect(bootstrapSample([], rng)).toEqual([]);
  });

  it("FNV-1a matches the reference vectors", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(fnv1a32("foobar")).toBe("bf9cf968");
    expect(fnv1a64("foobar")).toHaveLength(16);
    expect(fnv1a64("foobar")).toBe(fnv1a64("foobar"));
    expect(fnv1a64("foobar")).not.toBe(fnv1a64("foobaz"));
  });
});

describe("synthetic calendar", () => {
  it("skips weekends", () => {
    // 2024-01-05 is a Friday.
    expect(nextTradingDay("2024-01-05T00:00:00.000Z")).toBe("2024-01-08T00:00:00.000Z");
    const cal = syntheticCalendar("2024-01-06T00:00:00.000Z", 3);
    expect(cal).toEqual(["2024-01-08T00:00:00.000Z", "2024-01-09T00:00:00.000Z", "2024-01-10T00:00:00.000Z"]);
  });
});

describe("generateSyntheticBars", () => {
  it("is deterministic, ascending, valid OHLC and clearly labelled synthetic", () => {
    const a = generateSyntheticBars({ symbol: "AAA", bars: 100, seed: 5 });
    const b = generateSyntheticBars({ symbol: "AAA", bars: 100, seed: 5 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(100);
    for (let i = 0; i < a.length; i++) {
      const bar = a[i] as (typeof a)[number];
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.low).toBeGreaterThan(0);
      expect(bar.volume).toBeGreaterThan(0);
      expect(bar.provenance?.source).toBe(SYNTHETIC_SOURCE);
      expect(bar.provenance?.reliability).toBe(0);
      if (i > 0) expect(Date.parse(bar.time)).toBeGreaterThan(Date.parse((a[i - 1] as (typeof a)[number]).time));
    }
    expect(generateSyntheticBars({ symbol: "AAA", bars: 100, seed: 6 })).not.toEqual(a);
  });

  it("regime schedule changes the drift", () => {
    const bull = generateSyntheticBars({ symbol: "B", bars: 500, seed: 1, regimes: [{ bars: 500, drift: 0.5, vol: 0.05 }] });
    const bear = generateSyntheticBars({ symbol: "B", bars: 500, seed: 1, regimes: [{ bars: 500, drift: -0.5, vol: 0.05 }] });
    expect((bull[499] as (typeof bull)[number]).close).toBeGreaterThan(100);
    expect((bear[499] as (typeof bear)[number]).close).toBeLessThan(100);
  });

  it("embeds unadjusted splits that corporate-action adjustment removes", () => {
    const bars = generateSyntheticBars({ symbol: "S", bars: 20, seed: 2, regimes: [{ bars: 20, drift: 0, vol: 0.0001 }], splits: [{ atBar: 10, ratio: 4 }] });
    const before = (bars[9] as (typeof bars)[number]).close;
    const after = (bars[10] as (typeof bars)[number]).close;
    expect(before / after).toBeCloseTo(4, 1);
    const adjusted = applyCorporateActions(bars, [{ symbol: "S", date: (bars[10] as (typeof bars)[number]).time, kind: "split", ratio: 4 }]);
    expect((adjusted[9] as (typeof adjusted)[number]).close / (adjusted[10] as (typeof adjusted)[number]).close).toBeCloseTo(1, 1);
  });
});

describe("generateSyntheticDataset", () => {
  it("builds a valid dataset with benchmark, calendar, delistings and optional VIX", () => {
    const ds = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 50, seed: 8, delistings: [{ symbol: "BBB", atBar: 20 }], splits: [{ symbol: "AAA", atBar: 5, ratio: 2 }], includeVix: true });
    expect(validateDataset(ds)).toEqual([]);
    expect(ds.benchmark).toHaveLength(50);
    expect(ds.calendar).toHaveLength(50);
    expect(ds.vix).toHaveLength(50);
    expect(ds.bars.BBB).toHaveLength(20);
    expect(ds.delistings.BBB).toBe(ds.calendar?.[20]);
    expect(ds.corporateActions.map((a) => a.kind).sort()).toEqual(["delisting", "split"]);
    expect(ds.bars.AAA?.[0]?.time).toBe(ds.benchmark[0]?.time);
  });
});
