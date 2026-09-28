import { describe, expect, it } from "vitest";
import { buildStrategyProfile } from "../learning/profiles.js";
import { EMPTY_STATS, computePerformanceStats } from "../learning/stats.js";
import { makeSeries, NOW, SCOPE_A } from "../learning/testFixtures.js";
import type { PerformanceStats, StrategyIntelligenceProfile } from "../types/index.js";
import { ScopeError } from "../types/index.js";
import { assessStrategyFitness, darwinianAllocation } from "./fitness.js";
import { computeSurvival, fitnessScore, MODE_PARAMS, SURVIVAL_ENGINE_VERSION } from "./mandate.js";
import { netExpectancy } from "./expectancy.js";
import type { SurvivalInput, SurvivalState } from "./types.js";

function stats(returnsPct: number[]): PerformanceStats {
  return computePerformanceStats(returnsPct.map((r) => ({ returnPct: r, holdingDays: 5, slippageBps: 5 })));
}
const WINNING = [1.2, -0.5, 0.9, 1.5, -0.4, 0.8, 1.1, -0.6, 1.3, 0.7, -0.3, 1.0, 0.9, -0.5, 1.4, 0.6, -0.4, 1.2, 0.8, 1.0, -0.2, 0.9, 1.1, -0.5, 1.3];
const LOSING = WINNING.map((r) => -r);
const settings = { maxDrawdownPct: 0.1, maxWeeklyLossPct: 0.05, maxDailyLossPct: 0.02, maxSimultaneousPositions: 12 };

function input(over: Partial<SurvivalInput> = {}): SurvivalInput {
  return {
    scope: SCOPE_A, now: NOW, settings,
    equity: { current: 100_000, peak: 100_000, inception: 95_000, inceptionAt: "2026-06-01T00:00:00.000Z", lastHighAt: NOW },
    drawdownPct: 0, dailyPnlPct: 0.001, weeklyPnlPct: 0.004, recentDailyReturns: [0.002, -0.001, 0.003, 0.001, 0.002],
    live: { overall: stats(WINNING), recent: stats(WINNING.slice(-20)) },
    shadow: { overall: { ...EMPTY_STATS }, recent: { ...EMPTY_STATS } },
    benchmark: { label: "SPY", returnPct: 0.02 }, liveReturnPct: 0.0526, previous: null,
    ...over,
  };
}

describe("computeSurvival — earn or die", () => {
  it("refuses a missing scope", () => {
    expect(() => computeSurvival({ ...input(), scope: { userId: "", brokerAccountId: "" } })).toThrow(ScopeError);
  });

  it("an account that earns on every window with headroom is thriving at full risk", () => {
    const s = computeSurvival(input());
    expect(s.version).toBe(SURVIVAL_ENGINE_VERSION);
    expect(s.mode).toBe("thriving");
    expect(s.riskMultiplier).toBe(1);
    expect(s.minEdgeMultiplier).toBe(1);
    expect(s.allowLiveEntries).toBe(true);
    expect(s.fitnessScore).toBeGreaterThanOrEqual(75);
    expect(s.alpha.alphaPct).toBeCloseTo(0.0326, 4);
    expect(s.mandate).toMatch(/^THRIVING/);
  });

  it("a fresh account with no live record is on probation, never earning on hope", () => {
    const s = computeSurvival(input({ live: { overall: { ...EMPTY_STATS }, recent: { ...EMPTY_STATS } }, liveReturnPct: null, benchmark: null }));
    expect(s.mode).toBe("probation");
    expect(s.fitnessScore).toBeLessThan(60);
    expect(s.riskMultiplier).toBe(0.75);
    expect(s.minEdgeMultiplier).toBe(1.25);
    expect(s.maxNewPositions).toBe(6);
    expect(s.hurdles.join(" ")).toMatch(/more closed live trade/);
    expect(s.evidence.sufficient).toBe(false);
  });

  it("a losing live record on both windows is hibernation: no live entries", () => {
    const s = computeSurvival(input({ live: { overall: stats(LOSING), recent: stats(LOSING.slice(-20)) }, drawdownPct: 0.03, liveReturnPct: -0.03 }));
    expect(s.mode).toBe("hibernation");
    expect(s.allowLiveEntries).toBe(false);
    expect(s.riskMultiplier).toBe(0);
    expect(s.maxNewPositions).toBe(0);
    expect(s.reasons.join(" ")).toMatch(/losing money overall/);
    expect(s.hurdles.join(" ")).toMatch(/shadow trades/);
  });

  it("drawdown at 80% of the limit is hibernation even with a good record", () => {
    const s = computeSurvival(input({ drawdownPct: 0.085 }));
    expect(s.mode).toBe("hibernation");
    expect(s.reasons[0]).toMatch(/drawdown 8.5%/);
  });

  it("drawdown over half the limit or a negative recent window is survival mode with two position slots", () => {
    const a = computeSurvival(input({ drawdownPct: 0.06 }));
    expect(a.mode).toBe("survival");
    expect(a.riskMultiplier).toBe(0.4);
    expect(a.minEdgeMultiplier).toBe(1.75);
    expect(a.maxNewPositions).toBe(2);
    const b = computeSurvival(input({ live: { overall: stats(WINNING), recent: stats(LOSING.slice(-12)) } }));
    expect(b.mode).toBe("survival");
    expect(b.reasons.join(" ")).toMatch(/recent live expectancy/);
  });

  it("computes runway from the burn rate and drops to survival when it is short", () => {
    const s = computeSurvival(input({ drawdownPct: 0.02, recentDailyReturns: [-0.004, -0.005, -0.003, -0.006, -0.004, -0.005] }));
    expect(s.runway.burnRatePctPerDay).toBeLessThan(0);
    expect(s.runway.days).not.toBeNull();
    // headroom 8% / burn ~0.45%/day ≈ 18 days => probation (warning) rather than survival (critical)
    expect(s.runway.days!).toBeGreaterThan(10);
    expect(s.runway.days!).toBeLessThan(20);
    expect(s.mode).toBe("probation");
    const critical = computeSurvival(input({ drawdownPct: 0.06, recentDailyReturns: [-0.008, -0.009, -0.007, -0.01] }));
    expect(critical.runway.days!).toBeLessThan(10);
    expect(critical.mode).toBe("survival");
    expect(critical.mandate).toMatch(/Runway \d+ days/);
  });

  it("demotes immediately but promotes one rung at a time after the dwell", () => {
    const thriving = computeSurvival(input());
    // Sudden losses: straight to survival regardless of the previous mode.
    const hit = computeSurvival(input({ drawdownPct: 0.06, previous: thriving }));
    expect(hit.mode).toBe("survival");
    expect(hit.previousMode).toBe("thriving");
    expect(hit.modeSince).toBe(NOW);
    // Record recovers the same day: promotion deferred (dwell not met).
    const sameDay = computeSurvival(input({ previous: hit }));
    expect(sameDay.mode).toBe("survival");
    expect(sameDay.reasons.join(" ")).toMatch(/promotion deferred/);
    // Three days later: climbs exactly one rung (survival -> probation) even though the record supports thriving.
    const later = computeSurvival(input({ now: "2026-10-01T15:00:00.000Z", previous: hit }));
    expect(later.mode).toBe("probation");
    expect(later.reasons.join(" ")).toMatch(/climbing one rung/);
    const later2 = computeSurvival(input({ now: "2026-10-04T15:00:00.000Z", previous: later }));
    expect(later2.mode).toBe("earning");
  });

  it("leaves hibernation only with a positive shadow record", () => {
    const dead = computeSurvival(input({ live: { overall: stats(LOSING), recent: stats(LOSING.slice(-20)) } }));
    expect(dead.mode).toBe("hibernation");
    const stillLosingLive = { overall: stats(LOSING), recent: stats(LOSING.slice(-20)) };
    // Days pass, no shadow proof: stays dead.
    const noProof = computeSurvival(input({ now: "2026-10-05T15:00:00.000Z", previous: dead, live: stillLosingLive }));
    expect(noProof.mode).toBe("hibernation");
    expect(noProof.reasons.join(" ")).toMatch(/shadow record has not yet proven an edge/);
    // Shadow proves an edge over 20 trades: climbs to survival, not straight back to live-earning.
    const revived = computeSurvival(input({ now: "2026-10-05T15:00:00.000Z", previous: dead, live: stillLosingLive, shadow: { overall: stats(WINNING), recent: stats(WINNING.slice(-20)) } }));
    expect(revived.mode).toBe("survival");
    expect(revived.allowLiveEntries).toBe(true);
    expect(revived.riskMultiplier).toBe(MODE_PARAMS.survival.riskMultiplier);
  });

  it("caps the fitness score below the earning threshold without enough live trades", () => {
    const few = input({ live: { overall: stats(WINNING.slice(0, 5)), recent: stats(WINNING.slice(0, 5)) } });
    expect(fitnessScore(few, 0, 0.03, false)).toBeLessThanOrEqual(59);
    expect(fitnessScore(input(), 0, 0.03, true)).toBeGreaterThan(59);
  });

  it("never multiplies risk above one in any mode", () => {
    for (const p of Object.values(MODE_PARAMS)) {
      expect(p.riskMultiplier).toBeLessThanOrEqual(1);
      expect(p.minEdgeMultiplier).toBeGreaterThanOrEqual(1);
    }
  });
});

function profile(returns: number[], over: Partial<StrategyIntelligenceProfile> = {}): StrategyIntelligenceProfile {
  const n = returns.length;
  const entries = makeSeries({ n, meanPct: 0, sdPct: 0, returnShift: (i) => returns[i] as number });
  const p = buildStrategyProfile({ strategyId: "s1", strategyKey: "xs_momentum", scope: SCOPE_A, mode: "live", entries, executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW, recentN: 10 });
  return { ...p, ...over };
}

describe("strategy Darwinism", () => {
  it("a losing live strategy is culled to shadow with zero target allocation", () => {
    const f = assessStrategyFitness({ strategyId: "s1", strategyKey: "xs_momentum", stage: "live", capitalAllocation: 0.3, live: profile(LOSING), shadow: null, now: NOW });
    expect(f.verdict).toBe("cull");
    expect(f.recommendedStage).toBe("live_shadow");
    expect(f.targetAllocation).toBe(0);
    expect(f.evidence).toBe("live");
    expect(f.reasons.join(" ")).toMatch(/losing money live/);
  });

  it("a strategy earning on both windows scales up one bounded step", () => {
    const f = assessStrategyFitness({ strategyId: "s1", strategyKey: "xs_momentum", stage: "live", capitalAllocation: 0.2, live: profile(WINNING), shadow: null, now: NOW });
    expect(["scale", "keep"]).toContain(f.verdict);
    expect(f.score).toBeGreaterThan(60);
    expect(f.targetAllocation).toBeLessThanOrEqual(0.25);
  });

  it("recent losses put a working strategy on probation at half allocation", () => {
    const rs = [...WINNING.slice(0, 20), -0.8, -0.6, -0.9, -0.7, -0.5, -0.8, -0.6, -0.9, -0.7, -0.5];
    const f = assessStrategyFitness({ strategyId: "s1", strategyKey: "xs_momentum", stage: "live", capitalAllocation: 0.3, live: profile(rs), shadow: null, now: NOW });
    expect(["probation", "cull"]).toContain(f.verdict);
    expect(f.targetAllocation).toBeLessThanOrEqual(0.15);
  });

  it("a shadow strategy with a proven record is proposed for revival, never auto-live", () => {
    const f = assessStrategyFitness({ strategyId: "s2", strategyKey: "mean_rev", stage: "live_shadow", capitalAllocation: 0, live: null, shadow: profile(WINNING), now: NOW });
    expect(f.verdict).toBe("revive");
    expect(f.recommendedStage).toBe("limited_live");
    expect(f.reasons.join(" ")).toMatch(/validation pipeline/);
  });

  it("too little evidence is incubating and keeps its allocation", () => {
    const f = assessStrategyFitness({ strategyId: "s3", strategyKey: "breakout", stage: "live", capitalAllocation: 0.1, live: profile(WINNING.slice(0, 6)), shadow: null, now: NOW });
    expect(f.verdict).toBe("incubating");
    expect(f.targetAllocation).toBe(0.1);
  });

  it("Darwinian allocation zeroes the culled, steps the survivors and never exceeds the budget", () => {
    const culled = assessStrategyFitness({ strategyId: "a", strategyKey: "a", stage: "live", capitalAllocation: 0.3, live: profile(LOSING), shadow: null, now: NOW });
    const winner = assessStrategyFitness({ strategyId: "b", strategyKey: "b", stage: "live", capitalAllocation: 0.3, live: profile(WINNING), shadow: null, now: NOW });
    const rookie = assessStrategyFitness({ strategyId: "c", strategyKey: "c", stage: "live", capitalAllocation: 0.1, live: profile(WINNING.slice(0, 5)), shadow: null, now: NOW });
    const alloc = darwinianAllocation([culled, winner, rookie], { budget: 0.7, maxStep: 0.05 });
    const byId = Object.fromEntries(alloc.map((a) => [a.strategyId, a]));
    expect(byId["a"]!.next).toBeCloseTo(0.25, 6); // steps down toward zero, never a cliff
    expect(byId["a"]!.target).toBe(0);
    expect(byId["b"]!.next).toBeGreaterThanOrEqual(0.3);
    expect(byId["b"]!.next).toBeLessThanOrEqual(0.35);
    expect(byId["c"]!.next).toBe(0.1);
    expect(alloc.reduce((s, a) => s + a.next, 0)).toBeLessThanOrEqual(0.7 + 1e-9);
  });
});

describe("net expectancy gate", () => {
  it("passes a trade whose EV clears costs and the hurdle, with an auditable breakdown", () => {
    const r = netExpectancy({ confidence: 0.6, expectedUpsidePct: 0.05, expectedDownsidePct: 0.03, spreadBps: 5, expectedSlippageBps: 3, holdingDays: 5, hurdleBps: 10 });
    expect(r.grossEvBps).toBeCloseTo(180, 6);
    expect(r.costBps).toBeCloseTo(11.3, 6);
    expect(r.netEvBps).toBeCloseTo(168.7, 6);
    expect(r.passes).toBe(true);
    expect(r.evPerDayBps).toBeCloseTo(33.74, 2);
    expect(r.breakdown.some((b) => /gross EV/.test(b))).toBe(true);
  });

  it("fails a trade that cannot pay for its own costs, and fails closed on missing inputs", () => {
    const r = netExpectancy({ confidence: 0.52, expectedUpsidePct: 0.004, expectedDownsidePct: 0.004, spreadBps: 20, expectedSlippageBps: 8, holdingDays: 1, hurdleBps: 10 });
    expect(r.grossEvBps).toBeCloseTo(1.6, 6);
    expect(r.passes).toBe(false);
    expect(r.breakdown[r.breakdown.length - 1]).toMatch(/does not pay for its own costs/);
    const missing = netExpectancy({ confidence: null, expectedUpsidePct: 0.05, expectedDownsidePct: 0.03, spreadBps: 5, expectedSlippageBps: 3, holdingDays: 5, hurdleBps: 10 });
    expect(missing.passes).toBe(false);
    expect(missing.netEvBps).toBeNull();
  });

  it("assumes the worst when costs are unknown and applies the survival hurdle", () => {
    const r = netExpectancy({ confidence: 0.55, expectedUpsidePct: 0.01, expectedDownsidePct: 0.008, spreadBps: null, expectedSlippageBps: null, holdingDays: 3, hurdleBps: 35 });
    expect(r.costBps).toBeCloseTo(25 + 20 + 0.3, 6);
    expect(r.breakdown[0]).toMatch(/spread unknown/);
    expect(r.grossEvBps).toBeCloseTo(19, 6);
    expect(r.passes).toBe(false);
  });
});
