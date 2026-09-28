import { z } from "zod";

/** Envelope marking external content as untrusted data. Agents only ever see content through this. */
export interface DataEnvelope {
  kind: "news" | "filing" | "social" | "web" | "api" | "model_output" | "market_data" | "internal";
  source: string;
  observedAt: string;
  reliability: number;
  /** Plain text content. Any instruction-like text inside is data, not a command. */
  content: string;
  /** Stable id for de-duplication and "is this genuinely new?" checks. */
  contentHash: string;
}

export const AgentVoteSchema = z.object({
  agent: z.string(),
  vote: z.enum(["strong_buy", "buy", "neutral", "reduce", "sell", "abstain"]),
  confidence: z.number().min(0).max(1),
  /** Explicit "I do not know" flag; confidence must be low when set. */
  unknown: z.boolean(),
  keyPoints: z.array(z.string().max(400)).max(12),
  risks: z.array(z.string().max(300)).max(12),
  dataFreshness: z.enum(["fresh", "aging", "stale", "unknown"]),
  evidenceQuality: z.number().min(0).max(1),
});
export type AgentVote = z.infer<typeof AgentVoteSchema>;

export const MarketRegimeAgentOutputSchema = AgentVoteSchema.extend({
  regimes: z.array(z.object({ label: z.string(), probability: z.number().min(0).max(1) })),
  abnormal: z.boolean(),
  favouredFamilies: z.array(z.string()),
  disfavouredFamilies: z.array(z.string()),
  analogsRelevant: z.boolean(),
});
export const NewsAgentOutputSchema = AgentVoteSchema.extend({
  whatChanged: z.string().max(600),
  genuinelyNew: z.boolean(),
  alreadyPricedIn: z.enum(["yes", "partially", "no", "unknown"]),
  sourceQuality: z.number().min(0).max(1),
  confirmed: z.boolean(),
  expectedImpactDuration: z.enum(["intraday", "days", "weeks", "months", "unknown"]),
});
export const FundamentalAgentOutputSchema = AgentVoteSchema.extend({
  earningsQuality: z.number().min(0).max(1).nullable(),
  valuationAssessment: z.string().max(400),
  revisionTrend: z.enum(["up", "down", "flat", "unknown"]),
});
export const DevilsAdvocateOutputSchema = z.object({
  whyWrong: z.array(z.string().max(400)).min(1).max(12),
  contradictingEvidence: z.array(z.string().max(400)).max(12),
  late: z.boolean(),
  pricedIn: z.boolean(),
  sharedSignalRisk: z.boolean(),
  eventRisk: z.boolean(),
  returnJustifiesDownside: z.boolean(),
  recentSimilarTradesPoor: z.boolean(),
  overconfidenceFlag: z.boolean(),
  verdict: z.enum(["proceed", "reduce", "wait", "reject"]),
  confidence: z.number().min(0).max(1),
});
export const ExecutionAgentOutputSchema = z.object({
  orderType: z.enum(["market", "limit"]),
  limitOffsetBps: z.number().min(-200).max(200),
  urgency: z.enum(["low", "normal", "high"]),
  staging: z.object({ slices: z.number().int().min(1).max(10), intervalSeconds: z.number().int().min(10).max(3600) }).nullable(),
  expectedSlippageBps: z.number().min(0),
  notes: z.array(z.string().max(300)),
});
export const PortfolioManagerOutputSchema = z.object({
  fitScore: z.number().min(-1).max(1),
  sizeMultiplier: z.number().min(0).max(1),
  concerns: z.array(z.string().max(300)),
  positives: z.array(z.string().max(300)),
  verdict: z.enum(["proceed", "reduce", "reject"]),
});

export type AgentName =
  | "market_regime" | "quant" | "market_structure" | "fundamental" | "news" | "portfolio_manager"
  | "risk_officer" | "execution" | "devils_advocate" | "red_team" | "variant_perception" | "research";
