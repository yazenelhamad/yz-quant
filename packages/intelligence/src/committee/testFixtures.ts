import type { AgentVote, RegimeAssessment, TenantScope, TradeCandidate } from "@yz/core";
import type { PortfolioAssessmentInput } from "../agents/portfolioManagerAgent.js";
import type { ThesisNumbers } from "../agents/thesisWriter.js";

/** Fixtures shared by intelligence tests (not exported from the package index). */
export const SCOPE_A: TenantScope = { userId: "user-a", brokerAccountId: "acct-a" };
export const SCOPE_B: TenantScope = { userId: "user-b", brokerAccountId: "acct-b" };

export function candidate(): TradeCandidate {
  return {
    id: "cand-1",
    symbol: "ACME",
    strategyId: "strat-1",
    strategyKey: "xs_momentum",
    strategyVersionId: "v1",
    direction: "long",
    ensemble: {
      symbol: "ACME",
      strategyKey: "xs_momentum",
      components: [],
      expectedEdge: 0.12,
      confidence: 0.61,
      disagreement: 0.2,
      uncertainty: 0.3,
      regime: "bull_trend",
      asOf: "2026-09-28T13:30:00Z",
      explanation: ["12-1 momentum top decile"],
    },
    expectedUpsidePct: 8,
    expectedDownsidePct: 4,
    holdingPeriodDays: 20,
    catalyst: null,
    catalystAt: null,
    liquidityScore: 0.9,
    regimeFit: 0.8,
    historicalSimilarity: null,
    createdAt: "2026-09-28T13:30:00Z",
    expiresAt: "2026-09-29T13:30:00Z",
    status: "candidate",
  };
}

export function regime(): RegimeAssessment {
  return {
    asOf: "2026-09-28T13:30:00Z",
    primary: "bull_trend",
    probabilities: { bull_trend: 0.7, range_bound: 0.3 },
    confidence: 0.7,
    abnormality: 0.1,
    metrics: { spyTrend20: 0.02, spyTrend100: 0.08, realizedVol20: 0.12, vix: 15, breadthPctAbove50: 65, avgPairwiseCorrelation: 0.3, sectorDispersion: 0.1, momentumPersistence: 0.6, meanReversionScore: 0.2, volumeRatio: 1.1 },
    familyBias: { trend_momentum: 0.3 },
    explanation: ["trend up"],
    dataQuality: "fresh",
  };
}

export function assessment(scope: TenantScope, patch: Partial<PortfolioAssessmentInput> = {}): PortfolioAssessmentInput {
  return {
    scope,
    asOf: "2026-09-28T13:30:00Z",
    totalValue: 100_000,
    cash: 40_000,
    buyingPower: 40_000,
    positionCount: 5,
    currentSymbolPct: 0,
    positionPctAfter: 0.05,
    sectorPctAfter: 0.2,
    sector: "tech",
    correlationToPortfolio: 0.4,
    betaAfter: 1.1,
    drawdownPct: 0.02,
    riskCapacity: 0.7,
    fitScore: 0.5,
    concentrationTop5Pct: 0.4,
    notes: [],
    ...patch,
  };
}

export function thesisNumbers(patch: Partial<ThesisNumbers> = {}): ThesisNumbers {
  return {
    symbol: "ACME",
    strategyKey: "xs_momentum",
    direction: "long",
    marketRegime: "bull_trend",
    expectedEdge: 0.12,
    confidence: 0.61,
    calibratedConfidence: 0.55,
    expectedUpsidePct: 8,
    expectedDownsidePct: 4,
    expectedHoldingPeriodDays: 20,
    proposedQuantity: 37,
    proposedNotional: 4995.37,
    invalidationPrice: 121.5,
    targetPrice: 146.2,
    maxAcceptableLossPct: 0.05,
    referencePrice: 135.01,
    catalyst: null,
    catalystAt: null,
    ...patch,
  };
}

export function vote(agent: string, v: AgentVote["vote"], confidence = 0.6, unknown = false): AgentVote {
  return { agent, vote: v, confidence, unknown, keyPoints: ["kp"], risks: ["r"], dataFreshness: "fresh", evidenceQuality: 0.6 };
}
