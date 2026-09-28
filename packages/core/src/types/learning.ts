import type { IsoTimestamp, TenantScope } from "./ids.js";

export type OutcomeClassification =
  | "good_win"
  | "bad_win"
  | "good_loss"
  | "bad_thesis"
  | "bad_timing"
  | "bad_execution"
  | "oversized"
  | "unexpected_event"
  | "model_error"
  | "data_error"
  | "regime_change";

export interface PostTradeReview {
  id: string;
  scope: TenantScope;
  tradeId: string;
  thesisCorrect: boolean | null;
  timingCorrect: boolean | null;
  sizingCorrect: boolean | null;
  executionEfficient: boolean | null;
  strategyBehavedAsIntended: boolean | null;
  confidenceCalibrated: boolean | null;
  signalsHelped: string[];
  signalsHurt: string[];
  wouldTakeAgain: boolean | null;
  classification: OutcomeClassification;
  returnPct: number;
  expectedEdge: number;
  initialConfidence: number;
  maePct: number | null;
  mfePct: number | null;
  slippageBps: number | null;
  regimeAtEntry: string;
  regimeAtExit: string | null;
  narrative: string;
  reviewedAt: IsoTimestamp;
  reviewerVersion: string;
}

/** Concise machine-readable lesson generated after each trade. */
export interface TradeLesson {
  id: string;
  /** Null when the lesson is shared (derived only from shared features); otherwise scoped. */
  scope: TenantScope | null;
  tradeId: string | null;
  strategyKey: string;
  regime: string;
  setup: string;
  expected: string;
  actual: string;
  lesson: string;
  action: string;
  /** Structured tags for retrieval, e.g. {"breadth": "weak", "setup": "breakout"} */
  tags: Record<string, string>;
  confidenceImpact: number; // suggested multiplicative adjustment, bounded by safe adaptation
  createdAt: IsoTimestamp;
  timesConfirmed: number;
  timesContradicted: number;
}

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyPct: number | null;
  avgReturnPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number | null;
  avgHoldingDays: number | null;
  avgSlippageBps: number | null;
  netReturnPct: number | null;
}

export interface CalibrationBucket {
  lower: number;
  upper: number;
  predictions: number;
  successes: number;
  /** Observed hit rate, null when there are no predictions. */
  observed: number | null;
  /** Average predicted probability in bucket. */
  predicted: number | null;
}

export interface CalibrationProfile {
  key: string; // strategy key, model name, agent name or "system"
  buckets: CalibrationBucket[];
  brierScore: number | null;
  expectedCalibrationError: number | null;
  /** > 1 means overconfident. */
  overconfidenceRatio: number | null;
  sampleSize: number;
  updatedAt: IsoTimestamp;
}

export interface StrategyIntelligenceProfile {
  strategyId: string;
  strategyKey: string;
  /** Null = system-wide (both users' shadow + live); else per-user profile. */
  scope: TenantScope | null;
  mode: "live" | "shadow" | "backtest" | "all";
  overall: PerformanceStats;
  recent: PerformanceStats; // last N trades
  byRegime: Record<string, PerformanceStats>;
  byVolRegime: Record<string, PerformanceStats>;
  bySector: Record<string, PerformanceStats>;
  byHoldingPeriod: Record<string, PerformanceStats>;
  byConfidenceBucket: Record<string, PerformanceStats>;
  byLiquidity: Record<string, PerformanceStats>;
  bySignalStrength: Record<string, PerformanceStats>;
  byTimeOfDay: Record<string, PerformanceStats>;
  calibration: CalibrationProfile;
  signalDecay: { halfLifeDays: number | null; recentVsLongTermEdge: number | null };
  correlationToOtherStrategies: Record<string, number>;
  executionDrag: { theoreticalEdgePct: number | null; realizedEdgePct: number | null; dragPct: number | null };
  degradation: { score: number; trend: "improving" | "stable" | "deteriorating" | "insufficient_data"; notes: string[] };
  stability: number | null;
  assessment: {
    stillWorking: boolean | null;
    workingWhere: string[];
    failingWhere: string[];
    edgeTrend: "improving" | "decaying" | "stable" | "unknown";
    overconfident: boolean | null;
    executionDestroyingEdge: boolean | null;
    recommendedAllocationDelta: number; // bounded by safe adaptation
    recommendedStatus: "keep_live" | "move_to_shadow" | "pause" | "increase" | "insufficient_data";
    plainEnglish: string;
  };
  updatedAt: IsoTimestamp;
}

export interface SignalIntelligenceProfile {
  signalKey: string;
  historicalPredictiveValue: number | null; // e.g. information coefficient
  recentPredictiveValue: number | null;
  regimeDependence: Record<string, number>;
  correlationWithOtherSignals: Record<string, number>;
  cluster: string;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  decayHalfLifeDays: number | null;
  executionSensitivity: number | null;
  sampleSize: number;
  weightBounds: { min: number; max: number };
  currentWeight: number;
  updatedAt: IsoTimestamp;
}

export interface ModelIntelligenceProfile {
  modelName: string;
  modelVersion: string;
  accuracy: number | null;
  calibration: CalibrationProfile;
  byRegime: Record<string, number>;
  byAsset: Record<string, number>;
  byStrategy: Record<string, number>;
  latencyMsP50: number | null;
  failureRate: number | null;
  costUsd: number;
  valueAdded: number | null;
  agreementWithOthers: Record<string, number>;
  routingWeight: number;
  updatedAt: IsoTimestamp;
}

export interface AgentIntelligenceProfile {
  agentName: string;
  decisionsInfluenced: number;
  valueAdded: number | null; // marginal improvement when its output is included
  vetoAccuracy: number | null;
  calibration: CalibrationProfile;
  influenceWeight: number;
  updatedAt: IsoTimestamp;
}

/** Bounded parameter adaptation proposed by the learning engine. */
export interface AdaptationProposal {
  id: string;
  scope: TenantScope | null;
  target: "signal_weight" | "strategy_allocation" | "confidence_calibration" | "execution_preference" | "model_routing" | "strategy_ranking";
  key: string;
  currentValue: number;
  proposedValue: number;
  bounds: { min: number; max: number; maxStepPerDay: number };
  evidence: string;
  /** True when within bounds and can be applied automatically. */
  autoApplicable: boolean;
  requiresValidationPipeline: boolean;
  createdAt: IsoTimestamp;
  appliedAt: IsoTimestamp | null;
}

export interface TradeMemoryEntry {
  tradeId: string;
  scope: TenantScope;
  mode: "live" | "shadow";
  symbol: string;
  sector: string | null;
  strategyKey: string;
  regime: string;
  signals: Record<string, number>;
  features: Record<string, number>;
  entryPrice: number;
  exitPrice: number | null;
  holdingDays: number | null;
  positionPct: number;
  confidence: number;
  expectedEdge: number;
  predictedDownsidePct: number;
  actualReturnPct: number | null;
  maePct: number | null;
  mfePct: number | null;
  slippageBps: number | null;
  executionQuality: number | null;
  exitReason: string | null;
  reviewClassification: OutcomeClassification | null;
  lessons: string[];
  openedAt: IsoTimestamp;
  closedAt: IsoTimestamp | null;
}
