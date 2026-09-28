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

  it("refuses an entry whose thesis level sits inside noise (the AMZN case), widens a too-tight estimate, and never raises a structural target", () => {
    // AMZN: price 246.81, 200-day average 240.85 (2.4% away against a ~7.7% horizon move)
    const amzn = reconcileGeometry({ price: 246.81, sigmaHorizon: 0.077, strength: 0.5, structuralStop: 240.85 });
    expect(amzn.viable).toBe(false);
    expect(amzn.notes.join(" ")).toMatch(/inside noise, and the thesis fails below it/);
    const tight = reconcileGeometry({ price: 100, sigmaHorizon: 0.05, strength: 0.5, downside: 0.001 });
    expect(tight.viable).toBe(true);
    expect(tight.downsidePct).toBeCloseTo(GEOMETRY.minStopSigma * 0.05, 4);
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
    // a mean-reversion setup targets a level as far as its stop: viable at the 1.0 floor
    const even = reconcileGeometry({ price: 100, sigmaHorizon: 0.02, strength: 0.5, structuralTarget: 102, upside: 0.02, downside: 0.02, minRewardRisk: 1.0 });
    expect(even.viable).toBe(true);
    expect(even.rewardRisk).toBeCloseTo(1, 4);
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

  it("forecasts IC × σ_h × score and turns it into a tilt over breakeven (the AMAT case)", () => {
    // AMAT: ~14.2% horizon move, score 0.92, target +27.9% / stop -14.6%
    const p = thesisProbability({ breakeven: 0.146 / (0.279 + 0.146), signalScore: 0.92, sigmaHorizon: 0.142, upsidePct: 0.279, downsidePct: 0.146 });
    expect(p.expectedReturn).toBeCloseTo(0.05 * 0.142 * 0.92, 4); // about +0.65%, not +17%
    expect(p.tilt).toBeCloseTo(p.expectedReturn / 0.425, 3);
    expect(p.probability).toBeCloseTo(p.breakeven + p.tilt, 4);
    expect(p.probability).toBeLessThan(0.37);
    // no signal, no forecast: exactly breakeven
    expect(thesisProbability({ breakeven: 0.33, signalScore: 0, sigmaHorizon: 0.1, upsidePct: 0.1, downsidePct: 0.05 }).probability).toBeCloseTo(0.33, 4);
    // a negative score forecasts against the trade
    expect(thesisProbability({ breakeven: 0.33, signalScore: -0.5, sigmaHorizon: 0.1, upsidePct: 0.1, downsidePct: 0.05 }).probability).toBeLessThan(0.33);
    // the coefficient is capped and the regime bias scales it by at most half
    expect(thesisProbability({ breakeven: 0.5, signalScore: 1, sigmaHorizon: 0.1, upsidePct: 0.1, downsidePct: 0.1, informationCoefficient: 0.9 }).informationCoefficient).toBeCloseTo(0.15, 4);
    expect(thesisProbability({ breakeven: 0.5, signalScore: 1, sigmaHorizon: 0.1, upsidePct: 0.1, downsidePct: 0.1, regimeBias: 2 }).informationCoefficient).toBeCloseTo(0.075, 4);
  });

  it("breakeven probability is d / (u + d)", () => {
    expect(breakevenProbability(0.10, 0.05)).toBeCloseTo(1 / 3, 4);
    expect(breakevenProbability(0.05, 0.05)).toBeCloseTo(0.5, 4);
    expect(breakevenProbability(0, 0.05)).toBeNull();
  });
});
