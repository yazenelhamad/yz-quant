import { describe, expect, it } from "vitest";
import type { Bar, RegimeAssessment, RegimeLabel } from "../types/index.js";
import { lastBarTime, meanRevertingBars, syntheticBars, trendingBars } from "../features/synthetic.js";
import { REGIME_ENGINE_VERSION, REGIME_LABELS, STRATEGY_FAMILIES, assessRegime, assessRegimeDetailed, averagePairwiseCorrelation, regimeSupport, unknownRegime } from "./engine.js";
import { regimeUsefulnessScore } from "./usefulness.js";

const START = "2024-01-02T00:00:00Z";

function sectorSet(seedBase: number, spread: number): Record<string, Bar[]> {
  const out: Record<string, Bar[]> = {};
  const names = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP"];
  names.forEach((n, i) => {
    out[n] = syntheticBars({ symbol: n, bars: 300, drift: spread * (i - 2.5) / 2.5, vol: 0.01, seed: seedBase + i, start: START });
  });
  return out;
}

function sumProbs(a: RegimeAssessment): number {
  return REGIME_LABELS.reduce((s, l) => s + (a.probabilities[l] ?? 0), 0);
}

describe("assessRegime", () => {
  it("classifies a steady bull market as bull_trend / momentum / risk_on with low vol", () => {
    const spy = trendingBars("SPY", 300, 0.0025, 3, START);
    const qqq = trendingBars("QQQ", 300, 0.0035, 4, START);
    const asOf = lastBarTime(spy);
    const r = assessRegimeDetailed({ asOf, spy, qqq, breadth: { pctAbove50: 78, pctAbove200: 70 } });
    const a = r.assessment;
    expect(sumProbs(a)).toBeCloseTo(1, 4);
    expect(["bull_trend", "momentum", "risk_on"]).toContain(a.primary);
    expect(a.probabilities.bull_trend!).toBeGreaterThan(a.probabilities.bear_trend!);
    expect(a.probabilities.bull_trend!).toBeGreaterThan(a.probabilities.range_bound!);
    expect(a.familyBias["trend_momentum"]).toBeGreaterThan(0);
    expect(a.familyBias["mean_reversion"]).toBeLessThan(0);
    expect(a.dataQuality).toBe("fresh");
    expect(a.metrics.spyTrend20).toBeGreaterThan(0);
    expect(a.metrics.spyTrend100).toBeGreaterThan(0);
    expect(a.explanation.length).toBeGreaterThan(2);
    for (const f of STRATEGY_FAMILIES) expect(a.familyBias[f]).toBeGreaterThanOrEqual(-1);
    for (const f of STRATEGY_FAMILIES) expect(a.familyBias[f]).toBeLessThanOrEqual(1);
  });

  it("classifies a persistent decline as bear_trend / risk_off", () => {
    const spy = trendingBars("SPY", 300, -0.0025, 5, START);
    const qqq = trendingBars("QQQ", 300, -0.004, 6, START);
    const asOf = lastBarTime(spy);
    const a = assessRegime({ asOf, spy, qqq, breadth: { pctAbove50: 20, pctAbove200: 25 } });
    expect(["bear_trend", "risk_off"]).toContain(a.primary);
    expect(a.probabilities.bear_trend!).toBeGreaterThan(a.probabilities.bull_trend!);
    expect(a.familyBias["trend_momentum"]).toBeLessThanOrEqual(0.2);
  });

  it("flags high volatility / liquidity shock when vol explodes with a VIX spike", () => {
    const calm = syntheticBars({ symbol: "SPY", bars: 280, drift: 0.0005, vol: 0.006, seed: 8, start: START });
    const lastCalm = calm[calm.length - 1]!;
    const shock = syntheticBars({ symbol: "SPY", bars: 20, drift: -0.01, vol: 0.045, seed: 9, start: new Date(Date.parse(lastCalm.time) + 86_400_000).toISOString(), startPrice: lastCalm.close, volume: 3_000_000 });
    const spy = [...calm, ...shock];
    const qqq = spy.map((b) => ({ ...b, symbol: "QQQ" }));
    const vix = spy.map((b, i) => ({ ...b, symbol: "VIX", close: i >= 280 ? 38 : 14, open: 14, high: 40, low: 12 }));
    const asOf = lastBarTime(spy);
    const universeReturns: Record<string, number[]> = {};
    for (let k = 0; k < 6; k += 1) universeReturns[`S${k}`] = shock.map((b, i) => (i === 0 ? 0 : b.close / shock[i - 1]!.close - 1) * (1 + k * 0.05));
    const r = assessRegimeDetailed({ asOf, spy, qqq, vix, universeReturns, volumeRatio: 2.5 });
    const a = r.assessment;
    expect(a.probabilities.high_volatility!).toBeGreaterThan(a.probabilities.low_volatility!);
    expect(["high_volatility", "liquidity_shock", "risk_off", "bear_trend"]).toContain(a.primary);
    expect(a.metrics.vix).toBe(38);
    expect(a.metrics.avgPairwiseCorrelation!).toBeGreaterThan(0.9);
    expect(a.abnormality).toBeGreaterThan(0.3);
    expect(a.familyBias["options_volatility"]).toBeGreaterThan(0);
    expect(a.familyBias["mean_reversion"]).toBeLessThan(0.5);
  });

  it("classifies an oscillating market as range_bound / mean_reversion", () => {
    const spy = meanRevertingBars("SPY", 300, 100, 0.3, 1.0, 2, START);
    const qqq = meanRevertingBars("QQQ", 300, 100, 0.3, 1.0, 3, START);
    const asOf = lastBarTime(spy);
    const a = assessRegime({ asOf, spy, qqq });
    expect(["range_bound", "mean_reversion", "low_volatility"]).toContain(a.primary);
    expect(a.metrics.meanReversionScore!).toBeGreaterThan(0);
    expect(a.familyBias["mean_reversion"]).toBeGreaterThan(0);
    expect(a.probabilities.bull_trend!).toBeLessThan(0.2);
  });

  it("detects sector rotation from dispersion", () => {
    const spy = syntheticBars({ symbol: "SPY", bars: 300, drift: 0.0003, vol: 0.008, seed: 12, start: START });
    const qqq = syntheticBars({ symbol: "QQQ", bars: 300, drift: 0.0003, vol: 0.009, seed: 13, start: START });
    const asOf = lastBarTime(spy);
    const dispersed = assessRegime({ asOf, spy, qqq, sectorEtfs: sectorSet(100, 0.008) });
    const tight = assessRegime({ asOf, spy, qqq, sectorEtfs: sectorSet(100, 0.0) });
    expect(dispersed.metrics.sectorDispersion!).toBeGreaterThan(tight.metrics.sectorDispersion!);
    expect(dispersed.probabilities.sector_rotation!).toBeGreaterThan(tight.probabilities.sector_rotation!);
  });

  it("raises event_driven when flagged", () => {
    const spy = syntheticBars({ symbol: "SPY", bars: 300, vol: 0.008, seed: 12, start: START });
    const qqq = syntheticBars({ symbol: "QQQ", bars: 300, vol: 0.009, seed: 13, start: START });
    const asOf = lastBarTime(spy);
    const flagged = assessRegime({ asOf, spy, qqq, eventDriven: true });
    const plain = assessRegime({ asOf, spy, qqq, eventDriven: false });
    expect(flagged.probabilities.event_driven!).toBeGreaterThan(plain.probabilities.event_driven! * 3);
    expect(flagged.familyBias["event"]).toBeGreaterThan(plain.familyBias["event"]!);
  });

  it("fails closed with too little data and reports stale data quality", () => {
    const spy = trendingBars("SPY", 30, 0.002, 3, START);
    const a = assessRegime({ asOf: lastBarTime(spy), spy, qqq: [] });
    expect(a.confidence).toBe(0);
    expect(sumProbs(a)).toBeCloseTo(1, 4);
    expect(a.explanation[0]).toMatch(/Insufficient/);
    const long = trendingBars("SPY", 300, 0.002, 3, START);
    const stale = assessRegime({ asOf: new Date(Date.parse(lastBarTime(long)) + 40 * 86_400_000).toISOString(), spy: long, qqq: long });
    expect(stale.dataQuality).toBe("stale");
  });

  it("never looks past asOf", () => {
    const spy = trendingBars("SPY", 300, 0.002, 3, START);
    const qqq = trendingBars("QQQ", 300, 0.002, 4, START);
    const asOf = spy[199]!.time;
    const full = assessRegime({ asOf, spy, qqq });
    const truncated = assessRegime({ asOf, spy: spy.slice(0, 200), qqq: qqq.slice(0, 200) });
    expect(full).toEqual(truncated);
  });

  it("is deterministic and exposes version / helpers", () => {
    expect(REGIME_ENGINE_VERSION).toBe("regime-1.0.0");
    const spy = trendingBars("SPY", 300, 0.002, 3, START);
    const a = assessRegime({ asOf: lastBarTime(spy), spy, qqq: spy });
    const b = assessRegime({ asOf: lastBarTime(spy), spy, qqq: spy });
    expect(a).toEqual(b);
    expect(regimeSupport(a, [])).toBe(1);
    expect(regimeSupport(a, ["bull_trend", "momentum"])).toBeCloseTo((a.probabilities.bull_trend ?? 0) + (a.probabilities.momentum ?? 0), 9);
    const u = unknownRegime("2025-01-01T00:00:00Z");
    expect(u.dataQuality).toBe("unknown");
    expect(sumProbs(u)).toBeCloseTo(1, 9);
  });

  it("average pairwise correlation", () => {
    const a = [0.01, -0.02, 0.03, -0.01, 0.02, 0.0, -0.03, 0.01, 0.02, -0.01, 0.01, 0.0];
    expect(averagePairwiseCorrelation({ x: a, y: a.map((v) => v * 2) })).toBeCloseTo(1, 9);
    expect(averagePairwiseCorrelation({ x: a })).toBeNull();
  });
});

describe("regimeUsefulnessScore", () => {
  function point(primary: RegimeLabel, ret: number, vol: number, trend = 0.01, confidence = 0.8) {
    const spy = trendingBars("SPY", 60, 0.001, 1, START);
    const base = unknownRegime(lastBarTime(spy));
    return { assessment: { ...base, primary, confidence, metrics: { ...base.metrics, spyTrend20: trend } }, forwardReturn5d: ret, forwardVol5d: vol };
  }

  it("scores perfect foresight at +1 and inverted foresight at -1", () => {
    const good = [point("bull_trend", 0.02, 0.1), point("bear_trend", -0.02, 0.1), point("high_volatility", 0, 0.5), point("low_volatility", 0, 0.05), point("momentum", 0.01, 0.1, 0.02), point("mean_reversion", -0.01, 0.1, 0.02)];
    const r = regimeUsefulnessScore(good);
    expect(r.score).toBeCloseTo(1, 9);
    expect(r.samples).toBe(6);
    const bad = [point("bull_trend", -0.02, 0.1), point("bear_trend", 0.02, 0.1), point("momentum", -0.01, 0.1, 0.02)];
    expect(regimeUsefulnessScore(bad).score).toBeCloseTo(-1, 9);
  });

  it("skips untestable labels and handles empty history", () => {
    const r = regimeUsefulnessScore([point("sector_rotation", 0.01, 0.1)]);
    expect(r.samples).toBe(0);
    expect(r.score).toBe(0);
    expect(r.hitRate).toBeNull();
    expect(regimeUsefulnessScore([]).samples).toBe(0);
  });
});
