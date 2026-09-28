import { describe, expect, it } from "vitest";
import { buildConsensusModel, consensusConfidence, crowdingScore, distinguishNumbers } from "./expectations.js";
import { expectedSurprise, historicalSensitivity } from "./surprise.js";
import { variantSignificance } from "./dispersion.js";
import { addIsoDays, aggregatePricedIn, catalystStrength, catalystWithinHorizon, daysBetweenIso, nextCatalyst, rankCatalysts } from "./catalyst.js";
import { assessTiming } from "./timing.js";
import { impliedExpectations, impliedGrowth, impliedMargin, valuePerShare } from "./reverseDcf.js";
import { catalystFixture, record } from "./fixtures.test-helpers.js";

describe("expectations", () => {
  it("builds a null-safe consensus model and notes what is missing", () => {
    const { model, notes } = buildConsensusModel({ ticker: "ACME", asOf: "2026-09-28", epsEstimates: [4.9, 5, 5.1, null] });
    expect(model.consensusEps).toBeCloseTo(5, 6);
    expect(model.consensusRevenue).toBeNull();
    expect(model.dispersion.analystCount).toBe(3);
    expect(model.dispersion.epsRange).toEqual([4.9, 5.1]);
    expect(model.positioningProxy.crowdingScore).toBeNull();
    expect(notes.some((n) => n.includes("revenue"))).toBe(true);
    expect(model.dataQuality).toBe("unknown");
  });

  it("consensus confidence rises with coverage and falls with dispersion", () => {
    const tightMany = consensusConfidence(20, 0.05, 5)!;
    const tightFew = consensusConfidence(2, 0.05, 5)!;
    const wideMany = consensusConfidence(20, 1.5, 5)!;
    expect(tightMany).toBeGreaterThan(tightFew);
    expect(tightMany).toBeGreaterThan(wideMany);
    expect(consensusConfidence(null, 0.1, 5)).toBeNull();
    expect(consensusConfidence(0, 0.1, 5)).toBeNull();
  });

  it("crowding score averages available components and lists the missing ones", () => {
    const partial = crowdingScore({ shortInterestPct: 25 }, null);
    expect(partial.score).toBe(1);
    expect(partial.notes.length).toBeGreaterThanOrEqual(3);
    const full = crowdingScore({ shortInterestPct: 2, putCallRatio: 0.8, volumeVsAvg: 1 }, { avgReactionToGoodNewsPct: 3, avgReactionToBadNewsPct: 3 });
    expect(full.score).toBeLessThan(0.2);
    expect(crowdingScore(null, null).score).toBeNull();
  });

  it("distinguishes reported, consensus, market-implied and internal numbers", () => {
    const c = distinguishNumbers({ reported: 1.1, consensus: 1, marketImplied: 1.05, internal: 1.2 });
    expect(c.reportedVsConsensusPct).toBeCloseTo(10, 6);
    expect(c.internalVsConsensusPct).toBeCloseTo(20, 6);
    expect(c.marketImpliedVsConsensusPct).toBeCloseTo(5, 6);
    expect(c.internalVsMarketImpliedPct).toBeCloseTo((0.15 / 1.05) * 100, 6);
    const missing = distinguishNumbers({ consensus: 1 });
    expect(missing.internalVsConsensusPct).toBeNull();
    expect(missing.interpretation.some((s) => s.includes("unknown"))).toBe(true);
  });
});

describe("surprise", () => {
  const records = [record(1, 5, 4), record(2, -3, -2.5), record(3, 10, 7), record(4, 0, 0.5), record(5, 2, 1.8)];

  it("regresses reaction on surprise and needs at least 4 records", () => {
    const s = historicalSensitivity(records)!;
    expect(s.n).toBe(5);
    expect(s.slope).toBeGreaterThan(0.6);
    expect(s.slope).toBeLessThan(0.9);
    expect(historicalSensitivity(records.slice(0, 3))).toBeNull();
    expect(historicalSensitivity([...records.slice(0, 3), record(9, 4, null)])).toBeNull();
  });

  it("adjusted reaction shrinks when priced in and can turn negative when crowded", () => {
    const base = { metric: "eps", consensus: 1, internal: 1.1, historicalSensitivity: 0.8, impliedMovePct: 6, valuationPercentile: null, crowding: null };
    const notPriced = expectedSurprise({ ...base, pricedInPct: 0 });
    const halfPriced = expectedSurprise({ ...base, pricedInPct: 50 });
    expect(notPriced.adjustedImpactPct).toBeCloseTo(8, 6);
    expect(halfPriced.adjustedImpactPct!).toBeCloseTo(4, 6);
    const crowded = expectedSurprise({ ...base, pricedInPct: 90, crowding: 0.9 });
    expect(crowded.adjustedImpactPct!).toBeLessThan(0);
    expect(crowded.reasoning.some((r) => r.includes("beat can still sell off"))).toBe(true);
  });

  it("never invents a reaction without sensitivity", () => {
    const r = expectedSurprise({ metric: "eps", consensus: 1, internal: 1.1, pricedInPct: 20, historicalSensitivity: null, impliedMovePct: 6, valuationPercentile: 0.5, crowding: 0.2 });
    expect(r.surprisePct).toBeCloseTo(10, 6);
    expect(r.adjustedImpactPct).toBeNull();
    expect(r.notes.some((n) => n.includes("not estimated"))).toBe(true);
    const noConsensus = expectedSurprise({ metric: "eps", consensus: null, internal: 1.1, pricedInPct: 20, historicalSensitivity: 0.8, impliedMovePct: 6, valuationPercentile: 0.5, crowding: 0.2 });
    expect(noConsensus.surprisePct).toBeNull();
  });

  it("caps the reaction at twice the implied move", () => {
    const r = expectedSurprise({ metric: "eps", consensus: 1, internal: 1.5, pricedInPct: 0, historicalSensitivity: 1, impliedMovePct: 5, valuationPercentile: null, crowding: null });
    expect(r.adjustedImpactPct).toBe(10);
  });
});

describe("dispersion", () => {
  it("tight consensus makes the same difference more significant", () => {
    const tight = variantSignificance(10, 2, 20);
    const wide = variantSignificance(10, 15, 20);
    expect(tight.significance).toBeGreaterThan(wide.significance);
    expect(tight.consensusTight).toBe(true);
    expect(wide.uncertaintyAlreadyRecognised).toBe(true);
  });
  it("reduces significance when dispersion or analyst count is unknown", () => {
    const unknown = variantSignificance(10, null, null);
    expect(unknown.z).toBeNull();
    expect(unknown.significance).toBeLessThanOrEqual(0.4);
    expect(variantSignificance(null, 2, 20).significance).toBe(0);
    expect(variantSignificance(10, 2, 2).significance).toBeLessThan(variantSignificance(10, 2, 20).significance);
  });
});

describe("catalyst", () => {
  it("calendar helpers work on ISO dates", () => {
    expect(daysBetweenIso("2026-09-28", "2026-10-20")).toBe(22);
    expect(daysBetweenIso("2026-09-28T00:00:00Z", "2026-09-29T12:00:00Z")).toBe(1.5);
    expect(daysBetweenIso("bad", "2026-10-20")).toBeNull();
    expect(addIsoDays("2026-09-28", 5)).toBe("2026-10-03");
  });

  it("strength = p × impact × (1 − pricedIn) × timing, discounted for undated or far catalysts", () => {
    const ctx = { holdingPeriodDays: 30, asOf: "2026-09-28" };
    const strong = catalystStrength(catalystFixture(), ctx);
    const priced = catalystStrength(catalystFixture({ pricedInScore: 0.9 }), ctx);
    const undated = catalystStrength(catalystFixture({ expectedDate: null }), ctx);
    const slow = catalystStrength(catalystFixture({ reactionSpeed: "months" }), { holdingPeriodDays: 5 });
    const far = catalystStrength(catalystFixture({ expectedDate: "2027-06-01" }), ctx);
    expect(strong.strength).toBeGreaterThan(priced.strength);
    expect(strong.strength).toBeGreaterThan(undated.strength);
    expect(strong.strength).toBeGreaterThan(slow.strength);
    expect(strong.strength).toBeGreaterThan(far.strength);
    expect(undated.notes[0]).toContain("no expected date");
  });

  it("finds the next catalyst and horizon membership", () => {
    const cs = [catalystFixture({ expectedDate: "2026-12-01", description: "later" }), catalystFixture({ expectedDate: "2026-10-05", description: "soon" }), catalystFixture({ expectedDate: "2026-01-01", description: "past" })];
    expect(nextCatalyst(cs, "2026-09-28")!.description).toBe("soon");
    expect(catalystWithinHorizon(cs, "2026-09-28", 10)).toBe(true);
    expect(catalystWithinHorizon(cs, "2026-09-28", 3)).toBe(false);
    expect(rankCatalysts(cs, { holdingPeriodDays: 30, asOf: "2026-09-28" })[0]!.catalyst.description).toBe("soon");
    expect(aggregatePricedIn([])).toBeNull();
    expect(aggregatePricedIn([catalystFixture({ pricedInScore: 0.2 }), catalystFixture({ pricedInScore: 0.6 })])).toBeCloseTo(0.4, 6);
  });
});

describe("timing", () => {
  it("says wait when the catalyst is far and momentum is exhausted", () => {
    const t = assessTiming({ catalystDaysAway: 120, holdingPeriodDays: 20, technicalSetup: { trend: 0.8, rsi: 82, distanceFrom52wHighPct: -1 }, positioningCrowding: 0.7, liquidityScore: 0.9, recentMovePct: { d5: 9, d20: 25 }, regimeFit: 0.7, volatility: 0.3, signalDecayHalfLife: 10, signalAgeDays: 1 });
    expect(t.appropriate).toBe(false);
    expect(t.score).toBeLessThanOrEqual(0.4);
    expect(t.reasons[0]).toMatch(/^Timing poor — wait/);
    expect(t.waitFor).not.toBeNull();
  });

  it("is appropriate with a near catalyst, healthy setup and fresh signal", () => {
    const t = assessTiming({ catalystDaysAway: 10, holdingPeriodDays: 20, technicalSetup: { trend: 0.5, rsi: 55, distanceFrom52wHighPct: -8 }, positioningCrowding: 0.2, liquidityScore: 0.9, recentMovePct: { d5: 1, d20: 3 }, regimeFit: 0.8, volatility: 0.3, signalDecayHalfLife: 10, signalAgeDays: 1 });
    expect(t.appropriate).toBe(true);
    expect(t.score).toBeGreaterThan(0.7);
  });

  it("treats missing inputs as unfavourable rather than ignoring them", () => {
    const full = assessTiming({ catalystDaysAway: 10, holdingPeriodDays: 20, technicalSetup: { trend: 0.5, rsi: 55 }, positioningCrowding: 0.2, liquidityScore: 0.9, recentMovePct: { d5: 1, d20: 3 }, regimeFit: 0.8 });
    const sparse = assessTiming({ catalystDaysAway: 10, holdingPeriodDays: 20 });
    expect(sparse.score).toBeLessThan(full.score);
    expect(sparse.reasons.some((r) => r.includes("missing"))).toBe(true);
  });
});

describe("reverse DCF", () => {
  const base = { price: 0, sharesOutstanding: 100, netDebt: 200, baseRevenue: 1000, fcfMarginPct: 15, discountRatePct: 9, terminalGrowthPct: 2.5, horizonYears: 10 };

  it("solves the growth that justifies a price built from a known growth", () => {
    const price = valuePerShare(base, 12)!;
    expect(price).toBeGreaterThan(0);
    const solved = impliedGrowth({ ...base, price })!;
    expect(solved.value).toBeCloseTo(12, 2);
    const margin = impliedMargin({ ...base, price }, 12)!;
    expect(margin.value).toBeCloseTo(15, 2);
  });

  it("returns nulls when inputs are missing and compares to references otherwise", () => {
    const missing = impliedExpectations({ ...base, price: null });
    expect(missing.impliedGrowthPct).toBeNull();
    expect(missing.notes[0]).toContain("missing price");
    const price = valuePerShare(base, 12)!;
    const r = impliedExpectations({ ...base, price, historicalGrowthPct: 8, guidanceGrowthPct: 10, internalGrowthPct: 15, investedCapital: 800 });
    expect(r.impliedGrowthPct).toBeCloseTo(12, 1);
    expect(r.comparedToHistory).toContain("above");
    expect(r.comparedToInternal).toContain("below");
    expect(r.impliedReturnOnCapital).not.toBeNull();
    expect(impliedExpectations({ ...base, price, terminalGrowthPct: 10 }).impliedGrowthPct).toBeNull();
  });
});
