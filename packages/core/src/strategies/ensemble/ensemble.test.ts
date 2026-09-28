import { describe, expect, it } from "vitest";
import type { RegimeAssessment, RegimeLabel, Signal } from "../../types/index.js";
import { REGIME_LABELS } from "../../regime/engine.js";
import { computeAdaptiveWeights } from "./adaptive.js";
import { WEIGHT_MULTIPLIER_BOUNDS, adaptWeight, combineSignals } from "./combine.js";

const AS_OF = "2025-03-03T15:00:00Z";

function regime(primary: RegimeLabel = "bull_trend", familyBias: Record<string, number> = {}): RegimeAssessment {
  const probabilities: Partial<Record<RegimeLabel, number>> = {};
  for (const l of REGIME_LABELS) probabilities[l] = l === primary ? 0.45 : 0.05;
  return {
    asOf: AS_OF, primary, probabilities, confidence: 0.7, abnormality: 0.1,
    metrics: { spyTrend20: null, spyTrend100: null, realizedVol20: null, vix: null, breadthPctAbove50: null, avgPairwiseCorrelation: null, sectorDispersion: null, momentumPersistence: null, meanReversionScore: null, volumeRatio: null },
    familyBias: { trend_momentum: 0, mean_reversion: 0, statistical: 0, event: 0, options_volatility: 0, fundamental_variant: 0, ...familyBias },
    explanation: [], dataQuality: "fresh",
  };
}

function sig(key: string, value: number, confidence = 0.6, asOf = AS_OF, freshness: Signal["inputFreshness"] = "fresh"): Signal {
  return { key, strategyKey: "test", symbol: "TEST", direction: value > 0 ? "long" : value < 0 ? "short" : "flat", value, confidence, horizonDays: 10, asOf, featureVersion: "feat-1.0.0", explanation: key, inputFreshness: freshness };
}

describe("combineSignals", () => {
  it("de-duplicates correlated signals by averaging within a cluster", () => {
    const signals = [sig("mom_a", 0.8), sig("mom_b", 0.6), sig("value", -0.2)];
    const clustered = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals, regime: regime(), signalClusters: { mom_a: "momentum", mom_b: "momentum" }, dataQuality: "fresh" });
    // momentum cluster = mean(0.8, 0.6) = 0.7 with weight 1; value = -0.2 weight 1 => (0.7 - 0.2) / 2
    expect(clustered.expectedEdge).toBeCloseTo(0.25, 4);
    const unclustered = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals, regime: regime(), dataQuality: "fresh" });
    expect(unclustered.expectedEdge).toBeCloseTo(0.4, 4);
    expect(clustered.components.length).toBe(3);
    expect(clustered.components.filter((c) => c.cluster === "momentum").length).toBe(2);
    const momentumContribution = clustered.components.filter((c) => c.cluster === "momentum").reduce((s, c) => s + c.contribution, 0);
    expect(momentumContribution).toBeCloseTo(0.35, 3);
    expect(clustered.explanation).toContain("Momentum +0.35");
    expect(clustered.explanation).toContain("Value -0.10");
    expect(clustered.explanation[clustered.explanation.length - 1]).toBe("Final Expected Edge +0.25");
    expect(clustered.explanation.some((e) => e.includes("2 correlated signals averaged"))).toBe(true);
  });

  it("clamps adaptive weights within [0.25, 2] x base", () => {
    expect(adaptWeight(1, 1, 100)).toBe(2);
    expect(adaptWeight(1, -1, 0.001)).toBe(0.25);
    expect(adaptWeight(2, 0, 1)).toBe(2);
    expect(adaptWeight(1, 0.5, 1)).toBeCloseTo(1.25, 9);
    const out = combineSignals({ symbol: "TEST", strategyKey: "test", family: "trend_momentum", asOf: AS_OF, signals: [sig("a", 0.5), sig("b", 0.5)], regime: regime("bull_trend", { trend_momentum: 1 }), calibrationAdjustments: { a: 50, b: 0.0001 }, dataQuality: "fresh" });
    const a = out.components.find((c) => c.key === "a")!;
    const b = out.components.find((c) => c.key === "b")!;
    expect(a.weight).toBe(WEIGHT_MULTIPLIER_BOUNDS.max);
    expect(b.weight).toBe(WEIGHT_MULTIPLIER_BOUNDS.min);
  });

  it("fails closed on stale data quality and on stale signals", () => {
    const stale = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.9, 0.9)], regime: regime(), dataQuality: "stale" });
    expect(stale.expectedEdge).toBe(0);
    expect(stale.confidence).toBe(0);
    expect(stale.uncertainty).toBe(1);
    expect(stale.explanation.some((e) => /Data quality stale/.test(e))).toBe(true);
    const staleSignal = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.9, 0.9, AS_OF, "stale")], regime: regime(), dataQuality: "fresh" });
    expect(staleSignal.expectedEdge).toBe(0);
    expect(staleSignal.components).toEqual([]);
  });

  it("ignores signals dated after asOf (look-ahead)", () => {
    const future = sig("a", 0.9, 0.9, "2025-03-03T16:00:00Z");
    const out = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [future, sig("b", 0.2)], regime: regime(), dataQuality: "fresh" });
    expect(out.components.map((c) => c.key)).toEqual(["b"]);
    expect(out.expectedEdge).toBeCloseTo(0.2, 4);
  });

  it("applies signal decay by half-life and reflects it in uncertainty", () => {
    const old = sig("a", 0.8, 0.8, "2025-02-21T15:00:00Z"); // 10 days before asOf
    const out = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [old], regime: regime(), signalDecay: { a: 10 }, dataQuality: "fresh" });
    expect(out.uncertainty).toBeCloseTo(0.5, 3);
    expect(out.components[0]!.contribution).toBeCloseTo(0.8, 3); // single cluster: value unchanged, weight decayed
    const fresh = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.8, 0.8)], regime: regime(), signalDecay: { a: 10 }, dataQuality: "fresh" });
    expect(fresh.uncertainty).toBe(0);
    expect(fresh.confidence).toBeGreaterThan(out.confidence);
  });

  it("measures disagreement as dispersion of signed contributions", () => {
    const split = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 1), sig("b", -1)], regime: regime(), dataQuality: "fresh" });
    expect(split.expectedEdge).toBeCloseTo(0, 6);
    expect(split.disagreement).toBeCloseTo(1, 6);
    const agree = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.6), sig("b", 0.6)], regime: regime(), dataQuality: "fresh" });
    expect(agree.disagreement).toBe(0);
    expect(agree.confidence).toBeGreaterThan(split.confidence);
  });

  it("adds the portfolio adjustment, clamps the edge and explains each step", () => {
    const out = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.9)], regime: regime(), portfolioAdjustment: -0.21, dataQuality: "aging" });
    expect(out.expectedEdge).toBeCloseTo(0.69, 4);
    expect(out.explanation).toContain("Portfolio Adjustment -0.21");
    expect(out.explanation).toContain("Final Expected Edge +0.69");
    expect(out.uncertainty).toBeGreaterThan(0);
    const clamped = combineSignals({ symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.9)], regime: regime(), portfolioAdjustment: 0.9, dataQuality: "fresh" });
    expect(clamped.expectedEdge).toBe(1);
  });

  it("is deterministic and returns the regime primary", () => {
    const input = { symbol: "TEST", strategyKey: "test", asOf: AS_OF, signals: [sig("a", 0.3), sig("b", 0.1)], regime: regime("range_bound"), dataQuality: "fresh" as const };
    expect(combineSignals(input)).toEqual(combineSignals(input));
    expect(combineSignals(input).regime).toBe("range_bound");
  });
});

describe("computeAdaptiveWeights", () => {
  const bounds = { min: 0.25, max: 2 };

  it("rewards predictive signals, penalises decayed ones, and respects hard bounds", () => {
    const w = computeAdaptiveWeights([
      { key: "good", historicalIC: 0.08, recentIC: 0.06, regimeDependence: {}, decay: 0 },
      { key: "bad", historicalIC: -0.05, recentIC: -0.08, regimeDependence: {}, decay: 0 },
      { key: "decayed", historicalIC: 0.08, recentIC: 0.06, regimeDependence: {}, decay: 1 },
      { key: "unknown", historicalIC: null, recentIC: null, regimeDependence: {}, decay: null },
      { key: "huge", historicalIC: 5, recentIC: 5, regimeDependence: { bull_trend: 1 }, decay: 0, weightBounds: { min: 0.5, max: 1.2 } },
    ], regime("bull_trend"), bounds);
    expect(w["good"]).toBeCloseTo(1.5, 4);
    expect(w["bad"]).toBeCloseTo(0.5, 4);
    expect(w["decayed"]).toBeCloseTo(0.75, 4);
    expect(w["unknown"]).toBe(1);
    expect(w["huge"]).toBe(1.2);
    for (const v of Object.values(w)) { expect(v).toBeGreaterThanOrEqual(0.25); expect(v).toBeLessThanOrEqual(2); }
  });

  it("uses regime dependence weighted by regime probabilities", () => {
    const profile = { key: "s", historicalIC: null, recentIC: null, regimeDependence: { bull_trend: 1, bear_trend: -1 }, decay: 0 };
    const bull = computeAdaptiveWeights([profile], regime("bull_trend"), bounds)["s"]!;
    const bear = computeAdaptiveWeights([profile], regime("bear_trend"), bounds)["s"]!;
    expect(bull).toBeGreaterThan(1);
    expect(bear).toBeLessThan(1);
  });
});
