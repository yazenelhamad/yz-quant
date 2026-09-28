import { describe, expect, it } from "vitest";
import { CrossTenantError } from "../types/index.js";
import {
  assessDegradation,
  buildAgentProfile,
  buildModelProfile,
  buildSignalProfile,
  buildStrategyProfile,
  clusterSignals,
  correlationMatrix,
  estimateEdgeHalfLifeDays,
  icDecayHalfLife,
  MAX_ALLOCATION_DELTA,
  rollingStability,
  timeOfDayBucket,
  volRegimeBucket,
  type BuildStrategyProfileInput,
  type SignalObservation,
} from "./profiles.js";
import { isoDaysAgo, makeMemory, makeOutcome, makeSeries, NOW, rng, SCOPE_A, SCOPE_B } from "./testFixtures.js";

function profileInput(over: Partial<BuildStrategyProfileInput> = {}): BuildStrategyProfileInput {
  return { strategyId: "s1", strategyKey: "xs_momentum", scope: null, mode: "all", entries: [], executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW, ...over };
}

describe("buildStrategyProfile", () => {
  it("returns insufficient_data below the minimum trade count", () => {
    const p = buildStrategyProfile(profileInput({ entries: makeSeries({ n: 10, meanPct: 1, sdPct: 1 }) }));
    expect(p.overall.trades).toBe(10);
    expect(p.assessment.recommendedStatus).toBe("insufficient_data");
    expect(p.assessment.stillWorking).toBeNull();
    expect(p.assessment.recommendedAllocationDelta).toBe(0);
    expect(p.degradation.trend).toBe("insufficient_data");
    expect(p.assessment.plainEnglish).toContain("not enough");
  });

  it("recommends a capped increase when long-term and recent are both positive and calibration is fine", () => {
    const entries = makeSeries({ n: 80, meanPct: 1.2, sdPct: 1.5, confidence: 0.65 });
    const p = buildStrategyProfile(profileInput({ entries, theoreticalEdgePct: 1.5 }));
    expect(p.assessment.stillWorking).toBe(true);
    expect(p.assessment.recommendedStatus).toBe("increase");
    expect(p.assessment.recommendedAllocationDelta).toBeGreaterThan(0);
    expect(p.assessment.recommendedAllocationDelta).toBeLessThanOrEqual(MAX_ALLOCATION_DELTA);
    // 80 trades < 100 => scaled below the cap: a handful of recent winners cannot max it out
    expect(p.assessment.recommendedAllocationDelta).toBeLessThan(MAX_ALLOCATION_DELTA);
    expect(p.assessment.overconfident).toBe(false);
    expect(p.executionDrag.theoreticalEdgePct).toBe(1.5);
    expect(p.executionDrag.dragPct).toBeCloseTo(1.5 - (p.overall.expectancyPct as number));
    expect(p.recent.trades).toBe(30);
    expect(p.assessment.plainEnglish).toMatch(/modest allocation increase/);
    expect(Object.keys(p.byRegime)).toEqual(["bull_trend"]);
    expect(p.byHoldingPeriod.short?.trades).toBe(80);
    expect(p.calibration.sampleSize).toBe(80);
    expect(p.stability).not.toBeNull();
  });

  it("does not recommend an increase for an overconfident strategy", () => {
    const entries = makeSeries({ n: 80, meanPct: 0.6, sdPct: 2, confidence: 0.95 });
    const p = buildStrategyProfile(profileInput({ entries }));
    expect(p.assessment.overconfident).toBe(true);
    expect(p.assessment.recommendedStatus).not.toBe("increase");
    expect(p.assessment.plainEnglish).toContain("overstated");
  });

  it("moves a deteriorating strategy with negative recent expectancy to shadow", () => {
    const entries = makeSeries({ n: 80, meanPct: 1, sdPct: 1.2, returnShift: (i, n) => (i >= n - 30 ? -3 : 0) });
    const p = buildStrategyProfile(profileInput({ entries, options: { pauseDrawdownPct: 60 } }));
    expect(p.degradation.trend).toBe("deteriorating");
    expect(p.degradation.score).toBeGreaterThan(0.5);
    expect(p.assessment.edgeTrend).toBe("decaying");
    expect(p.assessment.stillWorking).toBe(false);
    expect(p.assessment.recommendedStatus).toBe("move_to_shadow");
    expect(p.assessment.recommendedAllocationDelta).toBe(-MAX_ALLOCATION_DELTA);
    expect(p.signalDecay.recentVsLongTermEdge).toBeLessThan(0);
  });

  it("pauses a strategy whose drawdown exceeds the threshold", () => {
    const entries = makeSeries({ n: 40, meanPct: 0.5, sdPct: 0.5, returnShift: (i) => (i >= 10 && i < 16 ? -5 : 0) });
    const p = buildStrategyProfile(profileInput({ entries }));
    expect(p.overall.maxDrawdownPct as number).toBeGreaterThan(15);
    expect(p.assessment.recommendedStatus).toBe("pause");
    expect(p.assessment.recommendedAllocationDelta).toBe(-MAX_ALLOCATION_DELTA);
  });

  it("builds every breakdown, calibration, correlations and execution drag from slippage", () => {
    const r = rng(7);
    const entries = makeSeries({ n: 40, meanPct: 0.8, sdPct: 1, regime: (i) => (i % 2 ? "bull_trend" : "risk_off"), holdingDays: 0.3 }).map((e, i) => ({
      ...e,
      sector: i % 3 === 0 ? "tech" : "energy",
      openedAt: `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T${i % 2 ? "14" : "18"}:00:00.000Z`,
      features: { ...e.features, realized_vol_20: i % 4 === 0 ? 0.4 : 0.1, liquidity_score: r() },
    }));
    const other = entries.map((e) => (e.actualReturnPct as number) * 0.9 + 0.1);
    const p = buildStrategyProfile(profileInput({ entries, correlations: { other_strategy: other, xs_momentum: entries.map((e) => e.actualReturnPct as number) }, executionOutcomes: [makeOutcome({ actualSlippageBps: 30 }), makeOutcome({ actualSlippageBps: 10 })] }));
    expect(Object.keys(p.byRegime).sort()).toEqual(["bull_trend", "risk_off"]);
    expect(Object.keys(p.byVolRegime).sort()).toEqual(["high_vol", "low_vol"]);
    expect(Object.keys(p.bySector).sort()).toEqual(["energy", "tech"]);
    expect(Object.keys(p.byTimeOfDay).sort()).toEqual(["afternoon", "open"]); // 14:00Z = 10:00 ET, 18:00Z = 14:00 ET
    expect(Object.keys(p.byConfidenceBucket)).toEqual(["0.7-0.8"]);
    expect(Object.keys(p.byLiquidity).length).toBeGreaterThan(1);
    expect(Object.keys(p.bySignalStrength).length).toBeGreaterThan(0);
    expect(p.correlationToOtherStrategies.other_strategy).toBeCloseTo(1);
    expect(p.correlationToOtherStrategies.xs_momentum).toBeUndefined();
    expect(p.executionDrag.dragPct).toBeCloseTo(0.2);
    expect(p.assessment.workingWhere.length).toBeGreaterThan(0);
  });

  it("filters by mode and strategy key and skips data-error trades", () => {
    const live = makeSeries({ n: 5, meanPct: 1, sdPct: 0.1, mode: "live" });
    const shadow = makeSeries({ n: 7, meanPct: 1, sdPct: 0.1, mode: "shadow", seed: 3 });
    const other = makeSeries({ n: 4, meanPct: 1, sdPct: 0.1, strategyKey: "mean_rev" });
    const bad = [makeMemory({ tradeId: "bad", reviewClassification: "data_error" })];
    expect(buildStrategyProfile(profileInput({ mode: "live", entries: [...live, ...shadow, ...other, ...bad] })).overall.trades).toBe(5);
    expect(buildStrategyProfile(profileInput({ mode: "shadow", entries: [...live, ...shadow] })).overall.trades).toBe(7);
    expect(buildStrategyProfile(profileInput({ mode: "all", entries: [...live, ...shadow, ...bad] })).overall.trades).toBe(12);
  });

  it("a scoped profile refuses entries from another tenant, a shared one accepts both", () => {
    const a = makeSeries({ n: 3, meanPct: 1, sdPct: 0.1, scope: SCOPE_A });
    const b = makeSeries({ n: 3, meanPct: 1, sdPct: 0.1, scope: SCOPE_B });
    expect(() => buildStrategyProfile(profileInput({ scope: SCOPE_A, entries: [...a, ...b] }))).toThrow(CrossTenantError);
    expect(() => buildStrategyProfile(profileInput({ scope: SCOPE_A, entries: a, executionOutcomes: [makeOutcome({ scope: SCOPE_B })] }))).toThrow(CrossTenantError);
    const shared = buildStrategyProfile(profileInput({ scope: null, entries: [...a, ...b] }));
    expect(shared.scope).toBeNull();
    expect(shared.overall.trades).toBe(6);
    expect(buildStrategyProfile(profileInput({ scope: SCOPE_A, entries: a })).scope).toEqual(SCOPE_A);
  });
});

describe("degradation, stability, half-life helpers", () => {
  it("assessDegradation needs enough samples in both windows", () => {
    expect(assessDegradation(makeSeries({ n: 20, meanPct: 1, sdPct: 1 }), 10, 15).trend).toBe("insufficient_data");
    const stable = assessDegradation(makeSeries({ n: 60, meanPct: 1, sdPct: 1 }), 30, 15);
    expect(stable.trend).toBe("stable");
    expect(stable.score).toBeLessThan(0.3);
    const improving = assessDegradation(makeSeries({ n: 60, meanPct: 0, sdPct: 1, returnShift: (i, n) => (i >= n - 30 ? 2 : 0) }), 30, 15);
    expect(improving.trend).toBe("improving");
    expect(improving.score).toBe(0);
  });

  it("rollingStability is high for i.i.d. returns and lower for shifting ones", () => {
    const iid = makeSeries({ n: 100, meanPct: 0.5, sdPct: 1 }).map((e) => e.actualReturnPct as number);
    const shifting = makeSeries({ n: 100, meanPct: 0.5, sdPct: 1, returnShift: (i) => (Math.floor(i / 10) % 2 ? 4 : -4) }).map((e) => e.actualReturnPct as number);
    expect(rollingStability(iid, 10) as number).toBeGreaterThan(rollingStability(shifting, 10) as number);
    expect(rollingStability([1, 2, 3], 10)).toBeNull();
  });

  it("estimates a half-life when older trades did better than recent ones", () => {
    // Older trades (larger age) have larger returns: log(return) rises with age => decay.
    const decaying = makeSeries({ n: 50, meanPct: 0, sdPct: 0.05, spanDays: 200, returnShift: (i, n) => 3 * Math.exp(-(i / (n - 1)) * 2) });
    const hl = estimateEdgeHalfLifeDays(decaying, NOW);
    expect(hl).not.toBeNull();
    expect(hl as number).toBeGreaterThan(0);
    expect(estimateEdgeHalfLifeDays(makeSeries({ n: 50, meanPct: -1, sdPct: 0.1 }), NOW)).toBeNull();
    expect(estimateEdgeHalfLifeDays(makeSeries({ n: 5, meanPct: 1, sdPct: 0.1 }), NOW)).toBeNull();
  });

  it("buckets vol and time of day", () => {
    expect(volRegimeBucket(0.1)).toBe("low_vol");
    expect(volRegimeBucket(0.2)).toBe("normal_vol");
    expect(volRegimeBucket(0.5)).toBe("high_vol");
    expect(volRegimeBucket(null)).toBe("unknown");
    expect(timeOfDayBucket("2026-09-28T13:45:00.000Z")).toBe("open"); // 09:45 ET (EDT)
    expect(timeOfDayBucket("2026-09-28T19:45:00.000Z")).toBe("close");
    expect(timeOfDayBucket("2026-09-28T21:00:00.000Z")).toBe("extended");
    expect(timeOfDayBucket("garbage")).toBe("unknown");
  });
});

describe("buildSignalProfile", () => {
  function observations(n: number, slope: number, seed = 1, regime: (i: number) => string = () => "bull_trend"): SignalObservation[] {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const v = r() * 2 - 1;
      const noise = (r() - 0.5) * 0.5;
      return { value: v, realizedReturns: { "1d": slope * v + noise, "5d": 0.6 * slope * v + noise, "20d": 0.3 * slope * v + noise }, regime: regime(i), asOf: isoDaysAgo(n - i) };
    });
  }

  it("computes IC (Spearman), recent vs historical, regime dependence and error rates", () => {
    const obs = observations(120, 2, 1, (i) => (i % 2 ? "bull_trend" : "risk_off"));
    const p = buildSignalProfile("momentum_12_1", obs, {}, NOW, { currentWeight: 1.2, weightBounds: { min: 0.2, max: 1.8 } });
    expect(p.sampleSize).toBe(120);
    expect(p.historicalPredictiveValue as number).toBeGreaterThan(0.7);
    expect(p.recentPredictiveValue as number).toBeGreaterThan(0.5);
    expect(Object.keys(p.regimeDependence).sort()).toEqual(["bull_trend", "risk_off"]);
    expect(p.falsePositiveRate as number).toBeLessThan(0.3);
    expect(p.falseNegativeRate as number).toBeLessThan(0.6);
    expect(p.currentWeight).toBe(1.2);
    expect(p.weightBounds).toEqual({ min: 0.2, max: 1.8 });
    expect(p.decayHalfLifeDays).not.toBeNull();
  });

  it("uses the horizon ICs to estimate decay and clusters correlated signals", () => {
    expect(icDecayHalfLife({ "1d": 0.4, "5d": 0.2, "20d": 0.05 }) as number).toBeGreaterThan(1);
    expect(icDecayHalfLife({ "1d": 0.1, "5d": 0.2 })).toBeNull();
    expect(icDecayHalfLife({ "1d": 0.4 })).toBeNull();
    const obs = observations(60, 1);
    const own = obs.map((o) => o.value);
    const twin = own.map((v) => v * 0.9 + 0.01);
    const unrelated = own.map((_, i) => Math.sin(i * 1.7));
    const p = buildSignalProfile("momentum_12_1", obs, { momentum_6_1: twin, vwap_zscore: unrelated }, NOW);
    expect(p.correlationWithOtherSignals.momentum_6_1).toBeCloseTo(1, 3);
    expect(Math.abs(p.correlationWithOtherSignals.vwap_zscore as number)).toBeLessThan(0.5);
    expect(p.cluster).toBe("momentum_12_1");
    const matrix = correlationMatrix({ a: own, b: twin, c: unrelated });
    expect(clusterSignals(matrix)).toEqual({ a: "a", b: "a", c: "c" });
    expect(clusterSignals({ x: { y: -0.9 }, y: {} }, 0.7)).toEqual({ x: "x", y: "x" });
  });

  it("handles observations without returns", () => {
    const p = buildSignalProfile("k", [{ value: 0.5, regime: "r", asOf: NOW }], {}, NOW);
    expect(p.sampleSize).toBe(0);
    expect(p.historicalPredictiveValue).toBeNull();
    expect(p.falsePositiveRate).toBeNull();
  });
});

describe("model and agent profiles", () => {
  it("buildModelProfile computes accuracy, breakdowns, latency, failure rate and cost", () => {
    const preds = Array.from({ length: 40 }, (_, i) => ({ predicted: 0.7, correct: i % 4 !== 0, latencyMs: 100 + i, costUsd: 0.01, regime: i % 2 ? "bull_trend" : "risk_off", symbol: i % 3 ? "AAPL" : "MSFT", strategy: "xs_momentum", failed: i === 39 }));
    const m = buildModelProfile("claude", "2026-01", preds, { other_model: 0.8 }, NOW, { baselineAccuracy: 0.6, routingWeight: 0.5 });
    expect(m.accuracy).toBeCloseTo(29 / 39);
    expect(m.failureRate).toBeCloseTo(1 / 40);
    expect(m.costUsd).toBeCloseTo(0.4);
    expect(m.latencyMsP50).toBeCloseTo(119.5);
    expect(m.valueAdded).toBeCloseTo(29 / 39 - 0.6);
    expect(m.byRegime.bull_trend).toBeDefined();
    expect(m.byAsset.MSFT).toBeDefined();
    expect(m.byStrategy.xs_momentum).toBeCloseTo(29 / 39);
    expect(m.agreementWithOthers).toEqual({ other_model: 0.8 });
    expect(m.routingWeight).toBe(0.5);
    expect(m.calibration.sampleSize).toBe(39);
  });

  it("buildAgentProfile measures value added and veto accuracy", () => {
    const decisions = [
      ...Array.from({ length: 10 }, (_, i) => ({ agentVote: "for" as const, finalOutcomeSuccess: i < 8, includedInDecision: true, confidence: 0.7 })),
      ...Array.from({ length: 10 }, (_, i) => ({ agentVote: "against" as const, finalOutcomeSuccess: i < 3, includedInDecision: i < 5, confidence: 0.6 })),
      { agentVote: "abstain" as const, finalOutcomeSuccess: true, includedInDecision: false, confidence: 0.1 },
    ];
    const a = buildAgentProfile("devils_advocate", decisions, NOW, { influenceWeight: 0.8 });
    expect(a.decisionsInfluenced).toBe(15);
    expect(a.valueAdded).toBeCloseTo(0.8 - 0.3);
    expect(a.vetoAccuracy).toBeCloseTo(0.7);
    expect(a.calibration.sampleSize).toBe(20);
    expect(a.influenceWeight).toBe(0.8);
    expect(buildAgentProfile("x", decisions.slice(0, 3), NOW).valueAdded).toBeNull();
  });
});
