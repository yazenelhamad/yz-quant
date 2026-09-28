import { describe, expect, it } from "vitest";
import { GEOMETRY, breakevenProbability, noEdgeHitProbability, reanchorGeometry, reconcileGeometry, sigmaOverHorizon, thesisProbability } from "./geometry.js";

describe("reconcileGeometry", () => {
  const sigma = sigmaOverHorizon(0.25, 20); // ~7.0% over 20 days

  it("derives a consistent stop/target pair from volatility when the strategy names no levels", () => {
    const g = reconcileGeometry({ price: 100, sigmaHorizon: sigma, strength: 0.6 });
    expect(g.viable).toBe(true);
    expect(g.downsidePct).toBeCloseTo(sigma, 4);
    expect(g.upsidePct).toBeCloseTo(1.6 * sigma, 4);
    expect(g.invalidationPrice).toBeCloseTo(100 * (1 - sigma), 2);
    expect(g.targetPrice).toBeCloseTo(100 * (1 + 1.6 * sigma), 2);
    expect(g.rewardRisk).toBeCloseTo(1.6, 2);
    expect(g.structuralInvalidationPrice).toBeNull();
  });

  it("keeps a distant structural level as the thesis level but tightens the risk stop to 2σ (the MRK case)", () => {
    const g = reconcileGeometry({ price: 148.68, sigmaHorizon: sigma, strength: 1, structuralStop: 121.67 });
    expect(g.downsidePct).toBeCloseTo(sigma, 4); // the risk stop falls back to 1σ, not to the far level
    expect(g.invalidationPrice).toBeGreaterThan(121.67);
    expect(g.structuralInvalidationPrice).toBe(121.67);
    expect(g.notes.join(" ")).toMatch(/kept as the thesis level/);
    expect(g.viable).toBe(true);
    // the stated downside now equals the distance to the risk stop
    expect((148.68 - g.invalidationPrice) / 148.68).toBeCloseTo(g.downsidePct, 3);
  });

  it("widens a stop inside noise and never raises a structural target", () => {
    const tight = reconcileGeometry({ price: 100, sigmaHorizon: 0.05, strength: 0.5, structuralStop: 99.9 });
    expect(tight.downsidePct).toBeCloseTo(GEOMETRY.minStopSigma * 0.05, 4);
    expect(tight.structuralInvalidationPrice).toBeNull();
    expect(tight.notes.join(" ")).toMatch(/widened/);
    const mr = reconcileGeometry({ price: 100, sigmaHorizon: 0.05, strength: 0.5, structuralTarget: 102, upside: 0.02, downside: 0.015 });
    expect(mr.targetPrice).toBe(102);
    expect(mr.upsidePct).toBeCloseTo(0.02, 4);
  });

  it("caps a target the horizon cannot reach and refuses a setup whose reward does not pay for its stop", () => {
    const capped = reconcileGeometry({ price: 100, sigmaHorizon: 0.04, strength: 1, upside: 0.3 });
    expect(capped.upsidePct).toBeCloseTo(GEOMETRY.maxTargetSigma * 0.04, 4);
    expect(capped.notes.join(" ")).toMatch(/capped/);
    const poor = reconcileGeometry({ price: 100, sigmaHorizon: 0.04, strength: 0.2, structuralTarget: 101, structuralStop: 96 });
    expect(poor.viable).toBe(false);
    expect(poor.rewardRisk).toBeLessThan(GEOMETRY.minRewardRisk);
  });
});

describe("reanchorGeometry", () => {
  it("re-measures upside and downside from the live price and fails closed when the levels no longer work", () => {
    const ok = reanchorGeometry({ price: 100, invalidationPrice: 95, targetPrice: 110, statedUpside: 0.08, statedDownside: 0.05, sigmaHorizon: 0.06 });
    expect(ok.problem).toBeNull();
    expect(ok.downsidePct).toBeCloseTo(0.05, 4);
    expect(ok.upsidePct).toBeCloseTo(0.1, 4);
    expect(reanchorGeometry({ price: 94, invalidationPrice: 95, targetPrice: 110, statedUpside: 0.08, statedDownside: 0.05, sigmaHorizon: 0.06 }).problem).toMatch(/at or below the stop/);
    expect(reanchorGeometry({ price: 111, invalidationPrice: 95, targetPrice: 110, statedUpside: 0.08, statedDownside: 0.05, sigmaHorizon: 0.06 }).problem).toMatch(/at or above the target/);
    expect(reanchorGeometry({ price: 108, invalidationPrice: 95, targetPrice: 110, statedUpside: 0.08, statedDownside: 0.05, sigmaHorizon: 0.06 }).problem).toMatch(/reward\/risk/);
    expect(reanchorGeometry({ price: 96, invalidationPrice: 95, targetPrice: 110, statedUpside: 0.08, statedDownside: 0.05, sigmaHorizon: 0.06 }).problem).toMatch(/inside noise/);
  });
});

describe("noEdgeHitProbability / thesisProbability", () => {
  it("gives about a third for a 2:1 target/stop and about a half for 1:1, less the paths that touch neither", () => {
    const two = noEdgeHitProbability(0.10, 0.05, 0.06);
    expect(two.target).toBeGreaterThan(0.05);
    expect(two.target).toBeLessThan(0.34);
    expect(two.stop).toBeGreaterThan(two.target);
    // martingale: the mass that touches neither level is the difference between the
    // infinite-horizon breakeven odds and what a finite horizon can resolve
    expect(two.neither).toBeGreaterThan(0.2);
    expect(two.target + two.stop + two.neither).toBeCloseTo(1, 3);
    const one = noEdgeHitProbability(0.05, 0.05, 0.06);
    expect(Math.abs(one.target - one.stop)).toBeLessThan(0.05); // log barriers are slightly asymmetric
    expect(one.target).toBeLessThan(0.5);
    // wider levels than the horizon can reach are rarely touched
    const far = noEdgeHitProbability(0.30, 0.30, 0.05);
    expect(far.neither).toBeGreaterThan(0.9);
  });

  it("is monotone: a further target is reached less often, and a nearer stop is hit more often", () => {
    const base = noEdgeHitProbability(0.08, 0.04, 0.05).target;
    expect(noEdgeHitProbability(0.12, 0.04, 0.05).target).toBeLessThan(base);
    expect(noEdgeHitProbability(0.08, 0.02, 0.05).stop).toBeGreaterThan(noEdgeHitProbability(0.08, 0.04, 0.05).stop);
  });

  it("bounds what a signal may add to the base rate", () => {
    expect(thesisProbability({ baseRate: 0.33, signalConfidence: 0.5 }).probability).toBeCloseTo(0.33, 4);
    const strong = thesisProbability({ baseRate: 0.33, signalConfidence: 1 });
    expect(strong.tilt).toBeCloseTo(0.175, 4);
    expect(strong.probability).toBeCloseTo(0.505, 3);
    expect(thesisProbability({ baseRate: 0.33, signalConfidence: 0.2 }).probability).toBeLessThan(0.33);
    expect(thesisProbability({ baseRate: 0.9, signalConfidence: 1 }).probability).toBeLessThanOrEqual(0.95);
  });

  it("breakeven probability is d / (u + d)", () => {
    expect(breakevenProbability(0.10, 0.05)).toBeCloseTo(1 / 3, 4);
    expect(breakevenProbability(0.05, 0.05)).toBeCloseTo(0.5, 4);
    expect(breakevenProbability(0, 0.05)).toBeNull();
  });
});
