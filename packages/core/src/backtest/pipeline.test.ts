import { describe, expect, it } from "vitest";
import type { BacktestMetrics, BacktestResult, StrategyStage, WalkForwardResult } from "../types/index.js";
import { emptyMetrics } from "./metrics.js";
import { evaluatePromotion, type PromotionThresholds, StrategyValidationPipeline } from "./pipeline.js";
import { makeConfig } from "./test-helpers.js";

const thresholds: PromotionThresholds = {
  minTrades: 30,
  minSharpeOos: 0.8,
  maxDrawdownPct: 20,
  maxOverfittingScore: 0.5,
  minProfitFactor: 1.2,
  minShadowTrades: 20,
  minShadowSharpe: 0.5,
};

function metrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return { ...emptyMetrics(), tradeCount: 50, sharpe: 1.5, maxDrawdownPct: 10, profitFactor: 1.8, netReturnPct: 12, ...overrides };
}

function result(kind: BacktestResult["kind"], overrides: Partial<BacktestMetrics> = {}): BacktestResult {
  return {
    id: `r_${kind}`,
    config: makeConfig(),
    kind,
    metrics: metrics(overrides),
    trades: [],
    equityCurve: [],
    warnings: [],
    dataFingerprint: "abc",
    ranAt: "2024-01-01T00:00:00.000Z",
    durationMs: 0,
  };
}

function walkForward(overrides: Partial<WalkForwardResult> = {}, aggregate: Partial<BacktestMetrics> = {}): WalkForwardResult {
  const fold = { train: ["a", "b"] as [string, string], test: ["c", "d"] as [string, string], metrics: metrics(), parameters: {} };
  return { folds: [fold, fold, fold], aggregate: metrics(aggregate), parameterStability: 0.9, overfittingScore: 0.2, ...overrides };
}

const good = { inSample: result("in_sample"), outOfSample: result("out_of_sample"), walkForward: walkForward() };

describe("StrategyValidationPipeline", () => {
  const pipeline = new StrategyValidationPipeline(thresholds);

  it("promotes research to live_shadow when every backtest gate passes", () => {
    const v = pipeline.evaluate({ currentStage: "research", ...good });
    expect(v.canPromoteTo).toBe("live_shadow");
    expect(v.blockers).toContain("shadow: no shadow evidence");
    expect(v.blockers).toContain("limited_live requires human review approval");
    expect(v.evidence["inSample.sharpe"]).toBe(1.5);
    expect(v.evidence["walkForward.overfittingScore"]).toBe(0.2);
  });

  it("blocks at backtest when there is no evidence", () => {
    const v = pipeline.evaluate({ currentStage: "research" });
    expect(v.canPromoteTo).toBe("research");
    expect(v.blockers).toEqual(["in_sample: no result"]);
  });

  it("blocks when in-sample thresholds fail", () => {
    const v = pipeline.evaluate({ currentStage: "research", inSample: result("in_sample", { tradeCount: 5, maxDrawdownPct: 35, profitFactor: 0.9 }) });
    expect(v.canPromoteTo).toBe("research");
    expect(v.blockers.some((b) => b.includes("trades 5 < 30"))).toBe(true);
    expect(v.blockers.some((b) => b.includes("max drawdown"))).toBe(true);
    expect(v.blockers.some((b) => b.includes("profit factor"))).toBe(true);
  });

  it("stops at backtest when out-of-sample Sharpe is too low", () => {
    const v = pipeline.evaluate({ ...good, currentStage: "research", outOfSample: result("out_of_sample", { sharpe: 0.3 }) });
    expect(v.canPromoteTo).toBe("backtest");
    expect(v.blockers).toEqual(["out_of_sample: sharpe 0.300 < 0.8"]);
  });

  it("stops at out_of_sample when walk-forward overfits or lacks folds", () => {
    const overfit = pipeline.evaluate({ ...good, currentStage: "research", walkForward: walkForward({ overfittingScore: 0.9 }) });
    expect(overfit.canPromoteTo).toBe("out_of_sample");
    expect(overfit.blockers.some((b) => b.includes("overfitting score"))).toBe(true);
    const fewFolds = pipeline.evaluate({ ...good, currentStage: "research", walkForward: walkForward({ folds: [] }) });
    expect(fewFolds.canPromoteTo).toBe("out_of_sample");
    expect(fewFolds.blockers.some((b) => b.includes("folds 0 < 2"))).toBe(true);
    const nullSharpe = pipeline.evaluate({ ...good, currentStage: "research", walkForward: walkForward({}, { sharpe: null }) });
    expect(nullSharpe.blockers.some((b) => b.includes("aggregate sharpe n/a"))).toBe(true);
  });

  it("never demotes: canPromoteTo is at least the current stage", () => {
    const v = pipeline.evaluate({ currentStage: "walk_forward", inSample: result("in_sample", { sharpe: -1 }) });
    expect(v.canPromoteTo).toBe("walk_forward");
    expect(v.blockers.length).toBeGreaterThan(0);
  });

  it("requires shadow evidence and a human review flag for limited_live", () => {
    const noFlag = pipeline.evaluate({ ...good, currentStage: "live_shadow", shadow: { trades: 40, sharpe: 1.1 } });
    expect(noFlag.canPromoteTo).toBe("live_shadow");
    expect(noFlag.blockers).toEqual(["limited_live requires human review approval"]);

    const weakShadow = pipeline.evaluate({ ...good, currentStage: "live_shadow", shadow: { trades: 5, sharpe: 0.1 }, humanReviewApproved: true });
    expect(weakShadow.canPromoteTo).toBe("live_shadow");
    expect(weakShadow.blockers).toEqual(["shadow: trades 5 < 20", "shadow: sharpe 0.100 < 0.5"]);

    const approved = pipeline.evaluate({ ...good, currentStage: "live_shadow", shadow: { trades: 40, sharpe: 1.1 }, humanReviewApproved: true });
    expect(approved.canPromoteTo).toBe("limited_live");
    expect(approved.blockers).toEqual(["promotion to live is never granted by the pipeline; it requires human review"]);
    expect(approved.evidence.humanReviewApproved).toBe(1);
  });

  it("never returns live, even from limited_live with perfect evidence and approval", () => {
    const stages: StrategyStage[] = ["research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live"];
    for (const stage of stages) {
      const v = pipeline.evaluate({ ...good, currentStage: stage, shadow: { trades: 500, sharpe: 3 }, humanReviewApproved: true });
      expect(v.canPromoteTo).not.toBe("live");
    }
    const v = pipeline.evaluate({ ...good, currentStage: "limited_live", shadow: { trades: 500, sharpe: 3 }, humanReviewApproved: true });
    expect(v.canPromoteTo).toBe("limited_live");
    expect(v.blockers[0]).toContain("never granted");
    expect(pipeline.gate("live", { currentStage: "limited_live" })).toHaveLength(1);
  });

  it("paused, retired and live strategies are not promotable by the pipeline", () => {
    expect(pipeline.evaluate({ ...good, currentStage: "paused" }).canPromoteTo).toBe("paused");
    expect(pipeline.evaluate({ ...good, currentStage: "retired" }).blockers[0]).toContain("human review");
    expect(pipeline.evaluate({ ...good, currentStage: "live" }).canPromoteTo).toBe("live");
  });

  it("omits null metrics from evidence instead of emitting NaN", () => {
    const v = evaluatePromotion(thresholds, { currentStage: "research", inSample: result("in_sample", { sharpe: null, profitFactor: null }) });
    expect(v.evidence["inSample.sharpe"]).toBeUndefined();
    expect(v.evidence["inSample.trades"]).toBe(50);
    for (const value of Object.values(v.evidence)) expect(Number.isNaN(value)).toBe(false);
  });
});
