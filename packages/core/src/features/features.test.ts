import { describe, expect, it } from "vitest";
import type { Bar, Quote } from "../types/index.js";
import { FEATURE, FEATURE_VERSION, computeFeatures } from "./compute.js";
import { barFreshness, quoteFreshness, usableBars, weekdaysBetween } from "./freshness.js";
import {
  adx, atr, bollingerZ, breakoutFlag, crossSectionalRank, ema, failedBreakoutFlag, liquidityScore, macd,
  maxDrawdown, momentum12_1, pivotLevels, realizedVol, relativeVolume, returnOver, rsi, sma, spreadBpsFromQuote, trendTStat, vwap,
} from "./indicators.js";
import { autocorrelation, beta, correlation, linearRegression, percentileRank, softmax, varianceRatio, zScore } from "./math.js";
import { lastBarTime, rangeBoundBars, syntheticBars, trendingBars } from "./synthetic.js";

function constantBars(n: number, price = 100, volume = 1000): Bar[] {
  return syntheticBars({ symbol: "T", bars: n, vol: 0, drift: 0, startPrice: price, volume, seed: 1 }).map((b) => ({ ...b, open: price, high: price, low: price, close: price, volume }));
}

describe("math helpers", () => {
  it("linear regression recovers slope on a straight line", () => {
    const ys = [1, 3, 5, 7, 9, 11];
    const reg = linearRegression(ys);
    expect(reg).not.toBeNull();
    expect(reg!.slope).toBeCloseTo(2, 9);
    expect(reg!.intercept).toBeCloseTo(1, 9);
    expect(reg!.r2).toBeCloseTo(1, 9);
    expect(reg!.tStat).toBeGreaterThan(100);
  });

  it("returns null for degenerate inputs", () => {
    expect(linearRegression([1, 2])).toBeNull();
    expect(zScore([1, 1, 1], 1)).toBeNull();
    expect(correlation([1, 2], [1, 2])).toBeNull();
    expect(varianceRatio([0.01, -0.01], 5)).toBeNull();
  });

  it("percentile rank and z-score behave on simple histories", () => {
    expect(percentileRank([1, 2, 3, 4, 5], 5)).toBeCloseTo(0.9, 6);
    expect(percentileRank([1, 2, 3, 4, 5], 0)).toBe(0);
    expect(zScore([1, 2, 3, 4, 5], 3)).toBeCloseTo(0, 9);
  });

  it("variance ratio > 1 for trending series and < 1 for alternating series", () => {
    const trending: number[] = [];
    const alternating: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      trending.push(i % 20 < 10 ? 0.01 : -0.01);
      alternating.push(i % 2 === 0 ? 0.01 : -0.01);
    }
    expect(varianceRatio(trending, 5)!).toBeGreaterThan(1);
    expect(varianceRatio(alternating, 5)!).toBeLessThan(1);
    expect(autocorrelation(alternating, 1)!).toBeLessThan(-0.9);
  });

  it("beta and correlation of a scaled series are exact", () => {
    const b = [0.01, -0.02, 0.015, 0.003, -0.01, 0.02];
    const a = b.map((x) => 1.5 * x);
    expect(beta(a, b)).toBeCloseTo(1.5, 9);
    expect(correlation(a, b)).toBeCloseTo(1, 9);
  });

  it("softmax sums to one and respects temperature", () => {
    const p = softmax([1, 2, 3], 1);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    const hot = softmax([1, 2, 3], 10);
    expect(Math.max(...hot) - Math.min(...hot)).toBeLessThan(Math.max(...p) - Math.min(...p));
  });
});

describe("indicators", () => {
  it("SMA / EMA on constant series equal the constant", () => {
    const c = new Array(50).fill(100) as number[];
    expect(sma(c, 20)).toBe(100);
    expect(ema(c, 12)).toBeCloseTo(100, 9);
    expect(sma(c, 60)).toBeNull();
  });

  it("returns and momentum", () => {
    const c = [100, 110, 121];
    expect(returnOver(c, 1)).toBeCloseTo(0.1, 9);
    expect(returnOver(c, 2)).toBeCloseTo(0.21, 9);
    expect(returnOver(c, 3)).toBeNull();
    const up = Array.from({ length: 300 }, (_, i) => 100 + i);
    // from t-252 to t-21: (299-21+100)/(299-252+100) - 1
    expect(momentum12_1(up)).toBeCloseTo((299 - 21 + 100) / (299 - 252 + 100) - 1, 9);
  });

  it("RSI is 100 for monotonic gains, ~0 for monotonic losses, 50 for flat", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(up)).toBe(100);
    expect(rsi(down)!).toBeLessThan(1);
    expect(rsi(new Array(30).fill(5) as number[])).toBe(50);
    expect(rsi([1, 2, 3])).toBeNull();
  });

  it("MACD is zero on a constant series", () => {
    const m = macd(new Array(60).fill(50) as number[]);
    expect(m).not.toBeNull();
    expect(m!.macd).toBeCloseTo(0, 9);
    expect(m!.histogram).toBeCloseTo(0, 9);
  });

  it("ATR equals the constant range on a flat series with fixed range", () => {
    const bars = constantBars(30).map((b) => ({ ...b, high: 102, low: 98 }));
    expect(atr(bars, 14)).toBeCloseTo(4, 9);
  });

  it("Bollinger z-score is positive above the mean", () => {
    const c = [...(new Array(19).fill(100) as number[]), 105];
    expect(bollingerZ(c, 20)!).toBeGreaterThan(3);
  });

  it("realized vol scales with input vol", () => {
    const lo = syntheticBars({ symbol: "A", bars: 100, vol: 0.005, seed: 3 }).map((b) => b.close);
    const hi = syntheticBars({ symbol: "A", bars: 100, vol: 0.03, seed: 3 }).map((b) => b.close);
    expect(realizedVol(hi, 60)!).toBeGreaterThan(realizedVol(lo, 60)! * 3);
  });

  it("VWAP weights by volume", () => {
    const base = constantBars(2);
    const bars: Bar[] = [
      { ...(base[0] as Bar), high: 10, low: 10, close: 10, volume: 100 },
      { ...(base[1] as Bar), high: 20, low: 20, close: 20, volume: 300 },
    ];
    expect(vwap(bars)).toBeCloseTo(17.5, 9);
    expect(vwap([{ ...(base[0] as Bar), volume: 0 }])).toBeNull();
  });

  it("relative volume and breakout with volume confirmation", () => {
    const bars = constantBars(40);
    const lastIdx = bars.length - 1;
    const spiked = bars.map((b, i) => (i === lastIdx ? { ...b, close: 110, high: 111, volume: 3000 } : b));
    expect(relativeVolume(spiked, 20)).toBeCloseTo(3, 9);
    expect(breakoutFlag(spiked, 20)).toBe(1);
    const noVolume = bars.map((b, i) => (i === lastIdx ? { ...b, close: 110, high: 111, volume: 1000 } : b));
    expect(breakoutFlag(noVolume, 20)).toBe(0);
  });

  it("detects a failed breakout", () => {
    const bars = constantBars(40);
    const n = bars.length;
    const shaped = bars.map((b, i) => {
      if (i === n - 3) return { ...b, close: 105, high: 106 };
      if (i === n - 2) return { ...b, close: 101, high: 105 };
      if (i === n - 1) return { ...b, close: 99, high: 100 };
      return b;
    });
    expect(failedBreakoutFlag(shaped, 20, 5)).toBe(1);
    expect(failedBreakoutFlag(bars, 20, 5)).toBe(0);
  });

  it("pivot clustering finds repeated levels", () => {
    const bars = rangeBoundBars("R", 120, 100, 5, 20);
    const levels = pivotLevels(bars);
    expect(levels.length).toBeGreaterThan(1);
    const top = levels[levels.length - 1]!.level;
    const bottom = levels[0]!.level;
    expect(top).toBeGreaterThan(103);
    expect(bottom).toBeLessThan(97);
  });

  it("ADX is high on strong trends and low on ranges", () => {
    const trend = trendingBars("UP", 120, 0.01, 5);
    const range = rangeBoundBars("R", 120, 100, 2, 10);
    expect(adx(trend, 14)!).toBeGreaterThan(adx(range, 14)!);
    expect(adx(trend, 14)!).toBeGreaterThan(25);
  });

  it("trend t-stat has the sign of the trend", () => {
    const up = trendingBars("UP", 80, 0.01, 5).map((b) => b.close);
    const down = trendingBars("DN", 80, -0.01, 5).map((b) => b.close);
    expect(trendTStat(up, 60)!).toBeGreaterThan(3);
    expect(trendTStat(down, 60)!).toBeLessThan(-3);
  });

  it("max drawdown, spread and liquidity", () => {
    expect(maxDrawdown([100, 120, 90, 100], 60)).toBeCloseTo(0.25, 9);
    expect(spreadBpsFromQuote(99.95, 100.05)).toBeCloseTo(10, 6);
    expect(spreadBpsFromQuote(null, 100)).toBeNull();
    expect(liquidityScore(1e9, 2)!).toBeGreaterThan(0.9);
    expect(liquidityScore(5e5, 40)!).toBeLessThan(0.2);
    expect(liquidityScore(null, 2)).toBeNull();
  });

  it("cross-sectional rank maps to [0,1] and ignores nulls", () => {
    const r = crossSectionalRank([{ symbol: "A", value: 3 }, { symbol: "B", value: 1 }, { symbol: "C", value: 2 }, { symbol: "D", value: null }]);
    expect(r["B"]).toBe(0);
    expect(r["A"]).toBe(1);
    expect(r["C"]).toBeCloseTo(0.5, 9);
    expect(r["D"]).toBeUndefined();
  });
});

describe("freshness and look-ahead", () => {
  it("counts weekdays and classifies daily freshness", () => {
    expect(weekdaysBetween("2025-01-06T00:00:00Z", "2025-01-08T00:00:00Z")).toBe(2); // Mon -> Wed
    expect(weekdaysBetween("2025-01-03T00:00:00Z", "2025-01-06T00:00:00Z")).toBe(1); // Fri -> Mon
    const bars = trendingBars("X", 10, 0.001);
    const end = lastBarTime(bars);
    expect(barFreshness(bars, end)).toBe("fresh");
    const endMs = Date.parse(end);
    expect(barFreshness(bars, new Date(endMs + 6 * 86_400_000).toISOString())).toBe("aging");
    expect(barFreshness(bars, new Date(endMs + 20 * 86_400_000).toISOString())).toBe("stale");
    expect(barFreshness([], end)).toBe("unknown");
  });

  it("intraday freshness is interval-relative", () => {
    const bars = syntheticBars({ symbol: "I", bars: 30, interval: "5minute", start: "2025-03-03T14:30:00Z" });
    const end = lastBarTime(bars);
    expect(barFreshness(bars, new Date(Date.parse(end) + 10 * 60_000).toISOString())).toBe("fresh");
    expect(barFreshness(bars, new Date(Date.parse(end) + 3 * 3600_000).toISOString())).toBe("stale");
  });

  it("quote freshness", () => {
    expect(quoteFreshness("2025-03-03T15:00:00Z", "2025-03-03T15:01:00Z")).toBe("fresh");
    expect(quoteFreshness("2025-03-03T15:00:00Z", "2025-03-03T16:01:00Z")).toBe("stale");
    expect(quoteFreshness(null, "2025-03-03T16:01:00Z")).toBe("unknown");
  });

  it("usableBars drops interpolated bars and bars after asOf", () => {
    const bars = trendingBars("X", 30, 0.001);
    const withInterp = bars.map((b, i) => (i === 5 ? { ...b, interpolated: true } : b));
    const cutoff = bars[20]!.time;
    const usable = usableBars(withInterp, cutoff);
    expect(usable.length).toBe(20);
    expect(usable.every((b) => !b.interpolated)).toBe(true);
    expect(usable.every((b) => Date.parse(b.time) <= Date.parse(cutoff))).toBe(true);
  });
});

describe("computeFeatures", () => {
  const quote: Quote = {
    symbol: "X", last: 0, bid: 0, ask: 0, previousClose: null, lastTradeAt: null, session: "regular", instrumentState: "active",
    provenance: { source: "test", observedAt: "2025-01-01T00:00:00Z", receivedAt: "2025-01-01T00:00:00Z", reliability: 1 },
  };

  it("produces a full set on a healthy trending series and never uses bars after asOf", () => {
    const bars = trendingBars("X", 320, 0.002, 9);
    const asOf = bars[299]!.time;
    const bench = syntheticBars({ symbol: "SPY", bars: 320, drift: 0.001, vol: 0.008, seed: 21 });
    const q: Quote = { ...quote, last: bars[299]!.close, bid: bars[299]!.close * 0.9995, ask: bars[299]!.close * 1.0005, lastTradeAt: asOf };
    const fs = computeFeatures({ asOf, bars, quote: q, benchmarkBars: bench });
    expect(fs.featureVersion).toBe(FEATURE_VERSION);
    expect(fs.freshness).toBe("fresh");
    expect(fs.values[FEATURE.barsCount]).toBe(300);
    expect(fs.values[FEATURE.close]).toBe(bars[299]!.close);
    expect(fs.values[FEATURE.sma200]).not.toBeNull();
    expect(fs.values[FEATURE.momentum12_1]).toBeGreaterThan(0);
    expect(fs.values[FEATURE.trendTStat60]).toBeGreaterThan(2);
    expect(fs.values[FEATURE.rsi14]).not.toBeNull();
    expect(fs.values[FEATURE.atrPct]).toBeGreaterThan(0);
    expect(fs.values[FEATURE.spreadBps]).toBeCloseTo(10, 3);
    expect(fs.values[FEATURE.liquidityScore]).toBeGreaterThan(0);
    expect(fs.values[FEATURE.beta60]).not.toBeNull();
    expect(fs.values[FEATURE.high52wDistancePct]).toBeLessThanOrEqual(0);
    expect(fs.values[FEATURE.low52wDistancePct]).toBeGreaterThanOrEqual(0);
    expect(fs.warnings.some((w) => w.includes("dropped"))).toBe(true);
  });

  it("is deterministic", () => {
    const bars = trendingBars("X", 100, 0.001);
    const asOf = lastBarTime(bars);
    const a = computeFeatures({ asOf, bars });
    const b = computeFeatures({ asOf, bars });
    expect(a).toEqual(b);
  });

  it("fails closed on empty input", () => {
    const fs = computeFeatures({ asOf: "2025-06-01T00:00:00Z", bars: [] });
    expect(fs.freshness).toBe("unknown");
    expect(Object.keys(fs.values).length).toBe(0);
    expect(fs.warnings.length).toBeGreaterThan(0);
  });

  it("reports stale freshness when asOf is far after the last bar", () => {
    const bars = trendingBars("X", 100, 0.001);
    const asOf = new Date(Date.parse(lastBarTime(bars)) + 30 * 86_400_000).toISOString();
    const fs = computeFeatures({ asOf, bars });
    expect(fs.freshness).toBe("stale");
    expect(fs.warnings.some((w) => w.includes("stale"))).toBe(true);
  });

  it("computes intraday VWAP features and multi-timeframe alignment", () => {
    const daily = trendingBars("X", 120, 0.004, 3, "2025-01-02T00:00:00Z");
    const lastDay = lastBarTime(daily).slice(0, 10);
    const intraday = syntheticBars({ symbol: "X", bars: 40, interval: "5minute", start: `${lastDay}T14:30:00Z`, drift: 0.002, vol: 0.001, startPrice: daily[daily.length - 1]!.close, seed: 4 });
    const asOf = lastBarTime(intraday);
    const fs = computeFeatures({ asOf, bars: daily, intradayBars: intraday });
    expect(fs.values[FEATURE.vwapIntraday]).not.toBeNull();
    expect(fs.values[FEATURE.vwapDeviationPct]).not.toBeNull();
    expect(fs.values[FEATURE.intradayTrendTStat]).toBeGreaterThan(0);
    expect(fs.values[FEATURE.mtfAlignment]).toBe(1);
  });

  it("leaves benchmark features null when no benchmark is given", () => {
    const bars = trendingBars("X", 100, 0.001);
    const fs = computeFeatures({ asOf: lastBarTime(bars), bars });
    expect(fs.values[FEATURE.beta60]).toBeNull();
    expect(fs.values[FEATURE.spreadBps]).toBeNull();
  });
});
