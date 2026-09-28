import { describe, expect, it } from "vitest";
import { buildStrategyProfile } from "./profiles.js";
import { describeRegimeFit, regimeWeightAdjustments, strategyRegimeFit } from "./regimeLearning.js";
import { makeSeries, NOW } from "./testFixtures.js";

const good = buildStrategyProfile({ strategyId: "a", strategyKey: "momo", scope: null, mode: "all", entries: makeSeries({ n: 60, meanPct: 1.5, sdPct: 1, strategyKey: "momo", regime: (i) => (i % 3 ? "bull_trend" : "risk_off"), returnShift: (i) => (i % 3 ? 0 : -3) }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
const thin = buildStrategyProfile({ strategyId: "b", strategyKey: "thin", scope: null, mode: "all", entries: makeSeries({ n: 3, meanPct: 5, sdPct: 0.1, strategyKey: "thin", regime: "bull_trend" }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });

describe("strategyRegimeFit", () => {
  it("scores each regime in [-1, 1] with sample-size shrinkage", () => {
    const fit = strategyRegimeFit({ momo: good, thin });
    expect(fit.momo?.bull_trend?.score as number).toBeGreaterThan(0.3);
    expect(fit.momo?.risk_off?.score as number).toBeLessThan(0);
    expect(fit.thin?.bull_trend?.score as number).toBeLessThan(0.15); // 3 trades of +5% shrink to near zero
    for (const s of Object.values(fit)) for (const c of Object.values(s)) {
      expect(c.score).toBeGreaterThanOrEqual(-1);
      expect(c.score).toBeLessThanOrEqual(1);
    }
  });

  it("produces bounded weight adjustments for the current regime only", () => {
    const fit = strategyRegimeFit({ momo: good, thin });
    const adj = regimeWeightAdjustments(fit, "risk_off", { min: 0.2, max: 2, maxStep: 0.1 }, { momo: 1 });
    expect(adj).toHaveLength(1);
    expect(adj[0]?.strategyKey).toBe("momo");
    expect(adj[0]?.delta as number).toBeLessThan(0);
    expect(Math.abs(adj[0]?.delta as number)).toBeLessThanOrEqual(0.1 + 1e-9);
    const bull = regimeWeightAdjustments(fit, "bull_trend", { min: 0.2, max: 1.05, maxStep: 0.5 }, { momo: 1, thin: 1 });
    expect(bull.find((a) => a.strategyKey === "momo")?.proposedWeight).toBeLessThanOrEqual(1.05);
    expect(regimeWeightAdjustments(fit, "liquidity_shock", { min: 0, max: 2, maxStep: 0.1 })).toEqual([]);
  });

  it("describes fits in plain English", () => {
    const lines = describeRegimeFit(strategyRegimeFit({ momo: good }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/momo fits bull_trend best/);
  });
});
