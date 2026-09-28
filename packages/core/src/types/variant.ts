import { z } from "zod";

/** Variant perception: what the market believes vs what we believe. */
export const ConsensusModelSchema = z.object({
  ticker: z.string(),
  asOf: z.string(),
  consensusRevenue: z.number().nullable(),
  consensusEps: z.number().nullable(),
  consensusGrowthPct: z.number().nullable(),
  consensusMarginPct: z.number().nullable(),
  consensusNarrative: z.string().max(800),
  currentValuation: z.object({ pe: z.number().nullable(), evSales: z.number().nullable(), evEbitda: z.number().nullable(), fcfYield: z.number().nullable() }),
  expectedCatalyst: z.string().nullable(),
  optionsImpliedMovePct: z.number().nullable(),
  impliedVolatility: z.number().nullable(),
  recentEstimateRevisions: z.object({ epsUp: z.number(), epsDown: z.number(), revenueUp: z.number(), revenueDown: z.number(), priceTargetChangePct: z.number().nullable(), windowDays: z.number() }),
  currentSentiment: z.number().min(-1).max(1).nullable(),
  positioningProxy: z.object({ shortInterestPct: z.number().nullable(), putCallRatio: z.number().nullable(), volumeVsAvg: z.number().nullable(), crowdingScore: z.number().min(0).max(1).nullable(), notes: z.array(z.string()) }),
  currentMarketNarrative: z.string().max(800),
  dispersion: z.object({ epsStdDev: z.number().nullable(), epsRange: z.tuple([z.number(), z.number()]).nullable(), analystCount: z.number().nullable(), consensusConfidence: z.number().min(0).max(1).nullable() }),
  sources: z.array(z.string()),
  dataQuality: z.enum(["fresh", "aging", "stale", "unknown"]),
});
export type ConsensusModel = z.infer<typeof ConsensusModelSchema>;

export const InternalForecastSchema = z.object({
  ticker: z.string(),
  asOf: z.string(),
  revenue: z.number().nullable(),
  eps: z.number().nullable(),
  marginPct: z.number().nullable(),
  growthPct: z.number().nullable(),
  keyMetrics: z.record(z.string(), z.number()),
  catalystOutcomes: z.array(z.object({ catalyst: z.string(), expectedOutcome: z.string().max(400), probability: z.number().min(0).max(1) })),
  expectedValuation: z.object({ pe: z.number().nullable(), evSales: z.number().nullable() }),
  likelyInvestorReaction: z.string().max(600),
  confidence: z.number().min(0).max(1),
  reasoning: z.array(z.string().max(500)),
  evidenceQuality: z.number().min(0).max(1),
});
export type InternalForecast = z.infer<typeof InternalForecastSchema>;

export const CatalystSchema = z.object({
  kind: z.enum(["earnings", "guidance", "investor_day", "product_launch", "regulatory", "economic_data", "industry_data", "analyst_revision", "capital_return", "m_and_a", "management_change", "pricing", "contract", "market_share", "legal", "sector_rerating", "other"]),
  description: z.string().max(400),
  expectedDate: z.string().nullable(),
  probability: z.number().min(0).max(1),
  potentialImpactPct: z.number(),
  consensusExpectsIt: z.boolean(),
  pricedInScore: z.number().min(0).max(1),
  reactionSpeed: z.enum(["immediate", "days", "weeks", "months"]),
});
export type Catalyst = z.infer<typeof CatalystSchema>;

export const ScenarioSchema = z.object({
  name: z.enum(["bull", "base", "bear"]),
  keyAssumptions: z.array(z.string().max(300)),
  fundamentalOutcome: z.string().max(400),
  expectedValuation: z.string().max(200),
  priceImpactPct: z.number(),
  probability: z.number().min(0).max(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const VariantViewSchema = z.object({
  ticker: z.string(),
  asOf: z.string(),
  consensusStatement: z.string().max(500),
  internalStatement: z.string().max(500),
  differences: z.array(z.object({ metric: z.string(), consensus: z.number().nullable(), internal: z.number().nullable(), differencePct: z.number().nullable() })),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(400)),
  meaningful: z.boolean(),
  pricedInScore: z.number().min(0).max(1),
  catalysts: z.array(CatalystSchema),
  expectedReactionPct: z.number().nullable(),
  timing: z.object({ appropriate: z.boolean(), score: z.number().min(0).max(1), reasons: z.array(z.string().max(300)) }),
  expectedSurprise: z.object({ metric: z.string(), consensus: z.number().nullable(), internal: z.number().nullable(), surprisePct: z.number().nullable(), pricedInPct: z.number().nullable(), historicalSensitivity: z.number().nullable(), adjustedImpactPct: z.number().nullable() }).nullable(),
  secondOrder: z.array(z.string().max(400)),
  narrative: z.object({ dominant: z.string().max(200), trend: z.enum(["strengthening", "weakening", "stable", "unknown"]), crowded: z.boolean(), confirmingInfo: z.array(z.string().max(300)), contradictingInfo: z.array(z.string().max(300)), priceDivergingFromNarrative: z.boolean() }),
  whatWouldMakeUsWrong: z.object({ marketBelieves: z.string().max(400), weBelieve: z.string().max(400), whyDifferent: z.string().max(400), whyMarketMightBeRight: z.string().max(400), invalidatingEvidence: z.array(z.string().max(300)), resolvingCatalyst: z.string().max(300), upsidePct: z.number(), downsidePct: z.number() }),
  scenarios: z.array(ScenarioSchema),
  impliedExpectations: z.object({ impliedGrowthPct: z.number().nullable(), impliedMarginPct: z.number().nullable(), impliedReturnOnCapital: z.number().nullable(), comparedToHistory: z.string().max(400), comparedToGuidance: z.string().max(400), comparedToInternal: z.string().max(400) }).nullable(),
  preMortem: z.object({ likelyCauseOfLoss: z.string().max(400), misunderstood: z.string().max(300), ignoredRisk: z.string().max(300), optimisticAssumption: z.string().max(300), alreadyPriced: z.boolean(), weakCatalyst: z.boolean(), badTiming: z.boolean(), crowded: z.boolean(), verdict: z.enum(["proceed", "reduce", "wait", "reject"]) }).nullable(),
  redTeam: z.object({ contradictoryEvidence: z.array(z.string().max(300)), alternativeExplanations: z.array(z.string().max(300)), weakAssumptions: z.array(z.string().max(300)), dataConcerns: z.array(z.string().max(300)), historicalCounterexamples: z.array(z.string().max(300)), valuationRisk: z.string().max(300), timingRisk: z.string().max(300), crowdingRisk: z.string().max(300), hiddenExposure: z.string().max(300), catalystStructureIssues: z.string().max(300), severity: z.number().min(0).max(1), legitimateFlaws: z.array(z.string().max(300)) }).nullable(),
  sourceDisagreements: z.array(z.object({ topic: z.string(), sourceA: z.string(), claimA: z.string().max(300), sourceB: z.string(), claimB: z.string().max(300), reason: z.string().max(300).nullable(), moreReliable: z.string().nullable(), effectOnTrade: z.string().max(300) })),
  evidence: z.array(z.object({ source: z.string(), tier: z.number().int().min(1).max(9), summary: z.string().max(400), reliability: z.number().min(0).max(1) })),
  score: z.object({
    total: z.number().min(0).max(1),
    components: z.record(z.string(), z.number()),
  }),
  recommendedAction: z.enum(["WAIT", "BUY", "REDUCE", "REJECT", "HOLD"]),
  icSummary: z.string().max(3000),
  versions: z.object({ modelName: z.string(), modelVersion: z.string(), promptVersion: z.string() }),
});
export type VariantView = z.infer<typeof VariantViewSchema>;

export interface ExpectationsRecord {
  id: string;
  ticker: string;
  catalyst: string;
  eventAt: string;
  consensus: Record<string, number | null>;
  narrative: string;
  optionsImpliedMovePct: number | null;
  priceBefore: number;
  systemForecast: Record<string, number | null>;
  systemConfidence: number;
  actualResult: Record<string, number | null> | null;
  priceAfter: number | null;
  reactionPct: number | null;
  recordedAt: string;
  resolvedAt: string | null;
}

export interface CompanyIntelligenceProfile {
  ticker: string;
  name: string;
  sector: string | null;
  industry: string | null;
  businessModel: string;
  revenueDrivers: string[];
  costDrivers: string[];
  keyKpis: string[];
  industryStructure: string;
  competitors: string[];
  managementHistory: string;
  guidanceAccuracy: { beats: number; misses: number; inline: number; avgSurprisePct: number | null };
  earningsBehaviour: { avgMovePct: number | null; avgImpliedMovePct: number | null; beatReactionPct: number | null; missReactionPct: number | null };
  valuationHistory: { peRange: [number, number] | null; evSalesRange: [number, number] | null };
  majorCatalysts: string[];
  majorRisks: string[];
  marketNarrative: string;
  consensusExpectations: Record<string, number | null>;
  internalExpectations: Record<string, number | null>;
  previousTheses: { thesisId: string; date: string; view: string; outcome: string | null }[];
  commonMoveReasons: string[];
  updatedAt: string;
  version: number;
}
