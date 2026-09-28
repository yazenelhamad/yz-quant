import { z } from "zod";

/**
 * A Trade Thesis is the structured justification for a trade. No thesis => no trade.
 * It is produced by the slow brain (with deterministic inputs) and validated with this schema
 * before it can be persisted. Free text fields are explanations, never instructions.
 */
export const EvidenceSchema = z.object({
  source: z.string(),
  kind: z.enum(["filing", "market_data", "official_data", "guidance", "alt_data", "research", "analyst", "journalism", "social", "model", "internal"]),
  observedAt: z.string(),
  reliability: z.number().min(0).max(1),
  summary: z.string().max(600),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const HistoricalAnalogSchema = z.object({
  tradeId: z.string(),
  symbol: z.string(),
  strategyKey: z.string(),
  regime: z.string(),
  similarity: z.number().min(0).max(1),
  returnPct: z.number().nullable(),
  thesisCorrect: z.boolean().nullable(),
  lesson: z.string().nullable(),
});
export type HistoricalAnalog = z.infer<typeof HistoricalAnalogSchema>;

export const TradeThesisSchema = z.object({
  id: z.string(),
  userId: z.string(),
  brokerAccountId: z.string(),
  candidateId: z.string().nullable(),
  ticker: z.string(),
  strategyId: z.string(),
  strategyKey: z.string(),
  strategyVersionId: z.string().nullable(),
  direction: z.enum(["long", "reduce", "exit"]),
  expectedHoldingPeriodDays: z.number().min(0),
  entryLogic: z.string().max(2000),
  expectedEdge: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  calibratedConfidence: z.number().min(0).max(1),
  marketRegime: z.string(),
  supportingEvidence: z.array(EvidenceSchema),
  contradictingEvidence: z.array(EvidenceSchema),
  catalyst: z.string().nullable(),
  catalystAt: z.string().nullable(),
  expectedUpsidePct: z.number(),
  expectedDownsidePct: z.number(),
  annualizedVolatility: z.number().nullable(),
  proposedQuantity: z.number().min(0),
  proposedNotional: z.number().min(0),
  invalidationPoint: z.string().max(600),
  invalidationPrice: z.number().nullable(),
  exitConditions: z.array(z.string().max(300)),
  targetPrice: z.number().nullable(),
  maxAcceptableLossPct: z.number().min(0).max(1),
  portfolioImpact: z.object({
    positionPctAfter: z.number(),
    sectorPctAfter: z.number(),
    sector: z.string().nullable(),
    correlationToPortfolio: z.number().nullable(),
    betaAfter: z.number().nullable(),
    fitScore: z.number().min(-1).max(1),
    notes: z.array(z.string()),
  }),
  liquidity: z.object({ adv: z.number().nullable(), spreadBps: z.number().nullable(), score: z.number().min(0).max(1) }),
  executionMethod: z.object({
    orderType: z.enum(["market", "limit", "stop_market", "stop_limit"]),
    limitLogic: z.string().nullable(),
    urgency: z.enum(["low", "normal", "high"]),
    staging: z.string().nullable(),
  }),
  dataFreshness: z.enum(["fresh", "aging", "stale", "unknown"]),
  similarHistoricalTrades: z.array(HistoricalAnalogSchema),
  strategyPerformanceInRegime: z.object({
    trades: z.number(),
    winRate: z.number().nullable(),
    expectancyPct: z.number().nullable(),
    profitFactor: z.number().nullable(),
  }).nullable(),
  modelVotes: z.array(z.object({ agent: z.string(), vote: z.string(), confidence: z.number().min(0).max(1), note: z.string().max(400) })),
  devilsAdvocate: z.object({
    whyWrong: z.array(z.string().max(400)),
    late: z.boolean(),
    pricedIn: z.boolean(),
    sharedSignalRisk: z.boolean(),
    eventRisk: z.boolean(),
    recentSimilarTradesPoor: z.boolean(),
    overconfidenceFlag: z.boolean(),
    verdict: z.enum(["proceed", "reduce", "wait", "reject"]),
  }).nullable(),
  variantPerception: z.object({ score: z.number().min(0).max(1), summary: z.string().max(1200), recommendedAction: z.enum(["WAIT", "BUY", "REDUCE", "REJECT", "HOLD"]) }).nullable(),
  plainEnglish: z.string().max(2000),
  versions: z.object({
    modelName: z.string(),
    modelVersion: z.string(),
    promptVersion: z.string(),
    featureVersion: z.string(),
    strategyVersion: z.string(),
    riskEngineVersion: z.string(),
  }),
  createdAt: z.string(),
  status: z.enum(["draft", "active", "superseded", "invalidated", "closed"]),
});
export type TradeThesis = z.infer<typeof TradeThesisSchema>;
