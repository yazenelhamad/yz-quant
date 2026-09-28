import { describe, expect, it } from "vitest";
import {
  averagePairwiseCorrelation,
  computeCorrelationMatrix,
  computeDailyPnl,
  computeDrawdown,
  computeWeeklyPnl,
  herfindahl,
  pearsonCorrelation,
  portfolioBeta,
} from "./math.js";

describe("pearsonCorrelation", () => {
  it("is 1 for identical series and -1 for inverted", () => {
    const a = [0.01, -0.02, 0.03, 0.005, -0.01];
    expect(pearsonCorrelation(a, a)).toBeCloseTo(1, 10);
    expect(pearsonCorrelation(a, a.map((x) => -x))).toBeCloseTo(-1, 10);
  });

  it("is ~0 for orthogonal series", () => {
    expect(pearsonCorrelation([1, -1, 1, -1], [1, 1, -1, -1])).toBeCloseTo(0, 10);
  });

  it("returns null for short or degenerate inputs", () => {
    expect(pearsonCorrelation([1, 2], [1, 2])).toBeNull();
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearsonCorrelation([1, NaN, 3], [1, 2, 3])).toBeNull();
  });

  it("builds a symmetric matrix and averages pairs", () => {
    const m = computeCorrelationMatrix({ A: [1, 2, 3, 4], B: [2, 4, 6, 8], C: [4, 3, 2, 1] });
    expect(m.A?.B).toBeCloseTo(1, 10);
    expect(m.B?.A).toBeCloseTo(1, 10);
    expect(m.A?.C).toBeCloseTo(-1, 10);
    expect(averagePairwiseCorrelation(["A", "B", "C"], m)).toBeCloseTo((1 - 1 - 1) / 3, 10);
    expect(averagePairwiseCorrelation(["A"], m)).toBeNull();
    expect(averagePairwiseCorrelation(["A", "Z"], m)).toBeNull();
  });
});

describe("portfolioBeta / herfindahl", () => {
  it("computes value-weighted beta as a fraction of total value", () => {
    expect(portfolioBeta([{ beta: 1.2, marketValue: 5000 }, { beta: 0.8, marketValue: 5000 }], 20_000)).toBeCloseTo(0.5, 10);
  });

  it("returns null when any beta or value is missing", () => {
    expect(portfolioBeta([{ beta: null, marketValue: 5000 }], 20_000)).toBeNull();
    expect(portfolioBeta([{ beta: 1, marketValue: null }], 20_000)).toBeNull();
    expect(portfolioBeta([], 0)).toBeNull();
  });

  it("HHI is 1 for one position, 1/n for equal weights, 0 when empty", () => {
    expect(herfindahl([100])).toBe(1);
    expect(herfindahl([1, 1, 1, 1])).toBeCloseTo(0.25, 10);
    expect(herfindahl([])).toBe(0);
  });
});

describe("computeDrawdown", () => {
  it("tracks peak and current drawdown", () => {
    const r = computeDrawdown([100, 110, 99, 105]);
    expect(r.peakValue).toBe(110);
    expect(r.currentValue).toBe(105);
    expect(r.currentDrawdownPct).toBeCloseTo(5 / 110, 10);
    expect(r.maxDrawdownPct).toBeCloseTo(11 / 110, 10);
    expect(r.points).toBe(4);
  });

  it("accepts value points and handles empty history", () => {
    const r = computeDrawdown([{ asOf: "2026-01-01T00:00:00Z", totalValue: 100 }, { asOf: "2026-01-02T00:00:00Z", totalValue: 90 }]);
    expect(r.currentDrawdownPct).toBeCloseTo(0.1, 10);
    expect(computeDrawdown([]).currentDrawdownPct).toBeNull();
  });
});

describe("computeDailyPnl / computeWeeklyPnl", () => {
  // 2026-09-28 is a Monday.
  const snaps = [
    { asOf: "2026-09-25T20:05:00Z", totalValue: 100_000 }, // Fri close
    { asOf: "2026-09-28T14:00:00Z", totalValue: 101_000 }, // Mon
    { asOf: "2026-09-28T20:05:00Z", totalValue: 102_000 }, // Mon close
    { asOf: "2026-09-29T15:00:00Z", totalValue: 100_500 }, // Tue
    { asOf: "2026-09-30T15:00:00Z", totalValue: 103_000 }, // Wed (future relative to tests below)
  ];

  it("uses the last snapshot of the previous NY day as the baseline", () => {
    const r = computeDailyPnl(snaps, "2026-09-29T16:00:00Z");
    expect(r?.baselineValue).toBe(102_000);
    expect(r?.currentValue).toBe(100_500);
    expect(r?.pnlPct).toBeCloseTo(-1500 / 102_000, 10);
  });

  it("ignores snapshots after now", () => {
    const r = computeDailyPnl(snaps, "2026-09-28T16:00:00Z");
    expect(r?.baselineValue).toBe(100_000);
    expect(r?.currentValue).toBe(101_000);
  });

  it("weekly uses the last snapshot before Monday", () => {
    const r = computeWeeklyPnl(snaps, "2026-09-29T16:00:00Z");
    expect(r?.baselineValue).toBe(100_000);
    expect(r?.currentValue).toBe(100_500);
    expect(r?.pnlPct).toBeCloseTo(0.005, 10);
  });

  it("returns null when there is no baseline", () => {
    expect(computeDailyPnl(snaps.slice(1, 2), "2026-09-28T16:00:00Z")).toBeNull();
    expect(computeDailyPnl([], "2026-09-28T16:00:00Z")).toBeNull();
    expect(computeDailyPnl(snaps, "invalid")).toBeNull();
  });
});
