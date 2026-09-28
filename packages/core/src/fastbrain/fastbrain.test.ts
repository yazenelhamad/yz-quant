import { describe, expect, it } from "vitest";
import type { FastBrainInput } from "../types/index.js";
import { FAST_ACTIONS } from "../types/index.js";
import { FAST_BRAIN_MIN_CONVICTION, FAST_BRAIN_VERSION, decide, explainDecision, scoreActions } from "./decide.js";

const NOW = "2025-03-03T15:00:00Z";

function base(over: Partial<FastBrainInput> = {}): FastBrainInput {
  return {
    scope: { userId: "u1", brokerAccountId: "a1" },
    symbol: "TEST", strategyKey: "time_series_momentum",
    hasPosition: false, positionPnlPct: null, positionAgeDays: null, invalidated: false, targetReached: false,
    expectedEdge: 0.6, confidence: 0.8, disagreement: 0.1, uncertainty: 0.1, regimeFit: 0.8, liquidityScore: 0.9, spreadBps: 5,
    dataFreshness: "fresh", portfolioFit: 0.5, riskCapacity: 0.8, eventRiskWithinHorizon: false, openOrder: null,
    marketSession: "regular", calibrationAdjustment: 1,
    ...over,
  };
}

function sum(p: Record<string, number>): number {
  return Object.values(p).reduce((a, b) => a + b, 0);
}

describe("fast brain", () => {
  it("probabilities cover all eight actions and sum to one", () => {
    const out = decide(base(), NOW);
    expect(Object.keys(out.probabilities).sort()).toEqual([...FAST_ACTIONS].sort());
    expect(sum(out.probabilities)).toBeCloseTo(1, 9);
    expect(out.bypassedRisk).toBe(false);
    expect(out.modelVersion).toBe(FAST_BRAIN_VERSION);
    expect(out.decidedAt).toBe(NOW);
    expect(out.conviction).toBe(out.probabilities[out.action]);
    expect(out.reasons.length).toBeGreaterThan(2);
  });

  it("buys on a strong, fresh, well-fitting edge with capacity", () => {
    const out = decide(base(), NOW);
    expect(out.action).toBe("BUY");
    expect(out.conviction).toBeGreaterThan(FAST_BRAIN_MIN_CONVICTION);
  });

  it("prefers WAIT under stale data even with a strong edge", () => {
    for (const f of ["stale", "unknown"] as const) {
      const out = decide(base({ dataFreshness: f, expectedEdge: 0.9, confidence: 0.95 }), NOW);
      expect(out.action, f).toBe("WAIT");
      expect(out.probabilities.BUY, f).toBeLessThan(0.01);
    }
    const aging = decide(base({ dataFreshness: "aging" }), NOW);
    expect(aging.probabilities.WAIT).toBeGreaterThan(decide(base(), NOW).probabilities.WAIT);
  });

  it("holds (not waits) a position when data is stale", () => {
    const out = decide(base({ dataFreshness: "stale", hasPosition: true, positionPnlPct: 0.02 }), NOW);
    expect(out.action).toBe("HOLD");
  });

  it("waits or holds when the session is closed", () => {
    expect(decide(base({ marketSession: "closed" }), NOW).action).toBe("WAIT");
    expect(decide(base({ marketSession: "overnight", hasPosition: true, positionPnlPct: 0.01 }), NOW).action).toBe("HOLD");
    expect(decide(base({ marketSession: "closed" }), NOW).probabilities.BUY).toBeLessThan(0.001);
  });

  it("exits an invalidated position and reduces at target", () => {
    const exit = decide(base({ hasPosition: true, invalidated: true, positionPnlPct: -0.05, expectedEdge: -0.2 }), NOW);
    expect(exit.action).toBe("EXIT");
    expect(exit.reasons.some((r) => /invalidated/.test(r))).toBe(true);
    const reduce = decide(base({ hasPosition: true, targetReached: true, positionPnlPct: 0.12, expectedEdge: 0.15, confidence: 0.5 }), NOW);
    expect(["REDUCE", "EXIT"]).toContain(reduce.action);
  });

  it("never proposes SELL / REDUCE / EXIT without a position", () => {
    const out = decide(base({ expectedEdge: -0.9, confidence: 0.95 }), NOW);
    expect(out.probabilities.SELL).toBeLessThan(1e-4);
    expect(out.probabilities.REDUCE).toBeLessThan(1e-4);
    expect(out.probabilities.EXIT).toBeLessThan(1e-4);
    expect(out.action).toBe("WAIT");
  });

  it("sells an existing long on a strongly negative fresh edge", () => {
    const out = decide(base({ hasPosition: true, expectedEdge: -0.8, confidence: 0.9, positionPnlPct: 0.03 }), NOW);
    expect(["SELL", "EXIT", "REDUCE"]).toContain(out.action);
    expect(out.probabilities.BUY).toBeLessThan(1e-4);
  });

  it("cancels an open order with low fill probability or a vanished edge; reprices a stale-but-valid one", () => {
    const lowFill = decide(base({ openOrder: { side: "buy", ageSeconds: 600, distanceFromMarketBps: 80, fillProbability: 0.05 } }), NOW);
    expect(lowFill.action).toBe("CANCEL_ORDER");
    const edgeGone = decide(base({ expectedEdge: -0.1, openOrder: { side: "buy", ageSeconds: 60, distanceFromMarketBps: 5, fillProbability: 0.6 } }), NOW);
    expect(edgeGone.action).toBe("CANCEL_ORDER");
    const reprice = decide(base({ openOrder: { side: "buy", ageSeconds: 300, distanceFromMarketBps: 20, fillProbability: 0.35 } }), NOW);
    expect(reprice.action).toBe("REPRICE_ORDER");
    expect(reprice.probabilities.BUY).toBeLessThan(1e-4);
  });

  it("refuses to buy without risk capacity or with event risk", () => {
    expect(decide(base({ riskCapacity: 0 }), NOW).probabilities.BUY).toBeLessThan(1e-4);
    const ev = decide(base({ eventRiskWithinHorizon: true, expectedEdge: 0.3, confidence: 0.6 }), NOW);
    expect(ev.action).toBe("WAIT");
  });

  it("calibration scales confidence multiplicatively", () => {
    const a = scoreActions(base({ calibrationAdjustment: 0.5 }));
    const b = scoreActions(base({ calibrationAdjustment: 1 }));
    expect(a.terms["calibratedEdge"]!).toBeCloseTo(b.terms["calibratedEdge"]! / 2, 9);
    expect(a.scores.BUY).toBeLessThan(b.scores.BUY);
  });

  it("falls back to WAIT/HOLD when conviction is below the threshold", () => {
    const out = decide(base({ expectedEdge: 0.12, confidence: 0.5, uncertainty: 0.5, disagreement: 0.5, portfolioFit: 0, regimeFit: 0.5 }), NOW);
    const maxP = Math.max(...Object.values(out.probabilities));
    if (maxP < FAST_BRAIN_MIN_CONVICTION) {
      expect(out.action).toBe("WAIT");
      expect(out.reasons[0]).toMatch(/defaulting to WAIT/);
    } else {
      expect(out.conviction).toBe(maxP);
    }
  });

  it("is deterministic and explainable", () => {
    const a = decide(base(), NOW);
    const b = decide(base(), NOW);
    expect(a).toEqual(b);
    const text = explainDecision(a);
    expect(text).toContain("BUY");
    expect(text).toContain("risk engine not bypassed");
  });
});
