import type { Catalyst, ConsensusModel, ExpectationsRecord, InternalForecast, Scenario } from "../types/index.js";

/** Test fixtures for the variant engine (imported by *.test.ts only). */

export function record(i: number, surprisePct: number, reactionPct: number | null, ticker = "ACME"): ExpectationsRecord {
  const consensusEps = 1;
  return {
    id: `rec-${i}`,
    ticker,
    catalyst: "earnings",
    eventAt: `2025-0${(i % 8) + 1}-15T21:00:00Z`,
    consensus: { eps: consensusEps },
    narrative: "",
    optionsImpliedMovePct: 6,
    priceBefore: 100,
    systemForecast: { eps: consensusEps * 1.02 },
    systemConfidence: 0.6,
    actualResult: { eps: consensusEps * (1 + surprisePct / 100) },
    priceAfter: reactionPct === null ? null : 100 * (1 + reactionPct / 100),
    reactionPct,
    recordedAt: "2025-01-01T00:00:00Z",
    resolvedAt: reactionPct === null ? null : "2025-01-20T00:00:00Z",
  };
}

export function consensusFixture(overrides: Partial<ConsensusModel> = {}): ConsensusModel {
  return {
    ticker: "ACME",
    asOf: "2026-09-28T00:00:00Z",
    consensusRevenue: 1000,
    consensusEps: 5,
    consensusGrowthPct: 10,
    consensusMarginPct: 20,
    consensusNarrative: "Steady 10% grower with stable margins.",
    currentValuation: { pe: 25, evSales: 5, evEbitda: 18, fcfYield: 0.03 },
    expectedCatalyst: "Q3 earnings",
    optionsImpliedMovePct: 7,
    impliedVolatility: 0.35,
    recentEstimateRevisions: { epsUp: 3, epsDown: 1, revenueUp: 2, revenueDown: 1, priceTargetChangePct: 2, windowDays: 30 },
    currentSentiment: 0.3,
    positioningProxy: { shortInterestPct: 3, putCallRatio: 0.7, volumeVsAvg: 1.1, crowdingScore: 0.3, notes: [] },
    currentMarketNarrative: "AI capex beneficiary",
    dispersion: { epsStdDev: 0.1, epsRange: [4.8, 5.2], analystCount: 20, consensusConfidence: 0.85 },
    sources: ["test"],
    dataQuality: "fresh",
    ...overrides,
  };
}

export function forecastFixture(overrides: Partial<InternalForecast> = {}): InternalForecast {
  return {
    ticker: "ACME",
    asOf: "2026-09-28T00:00:00Z",
    revenue: 1080,
    eps: 5.6,
    marginPct: 22,
    growthPct: 18,
    keyMetrics: { backlogGrowthPct: 25 },
    catalystOutcomes: [{ catalyst: "Q3 earnings", expectedOutcome: "beat and raise on backlog conversion", probability: 0.65 }],
    expectedValuation: { pe: 27, evSales: 5.5 },
    likelyInvestorReaction: "re-rating on growth acceleration",
    confidence: 0.65,
    reasoning: ["Backlog data in the 10-Q implies 18% growth, above the 10% consensus.", "Channel checks confirm pricing holds."],
    evidenceQuality: 0.7,
    ...overrides,
  };
}

export function catalystFixture(overrides: Partial<Catalyst> = {}): Catalyst {
  return {
    kind: "earnings",
    description: "Q3 earnings",
    expectedDate: "2026-10-20",
    probability: 0.95,
    potentialImpactPct: 8,
    consensusExpectsIt: true,
    pricedInScore: 0.3,
    reactionSpeed: "immediate",
    ...overrides,
  };
}

export function scenariosFixture(): Scenario[] {
  return [
    { name: "bull", keyAssumptions: ["backlog converts"], fundamentalOutcome: "18% growth", expectedValuation: "28x", priceImpactPct: 20, probability: 0.35 },
    { name: "base", keyAssumptions: ["in line"], fundamentalOutcome: "12% growth", expectedValuation: "25x", priceImpactPct: 5, probability: 0.4 },
    { name: "bear", keyAssumptions: ["pricing cracks"], fundamentalOutcome: "6% growth", expectedValuation: "20x", priceImpactPct: -12, probability: 0.25 },
  ];
}
