import type { IsoTimestamp, StrategyId, StrategyVersionId, TenantScope, UserId } from "./ids.js";
import type { RegimeLabel } from "./regime.js";

export type StrategyFamily =
  | "trend_momentum"
  | "mean_reversion"
  | "statistical"
  | "event"
  | "options_volatility"
  | "fundamental_variant";

export type StrategyStage =
  | "research"
  | "backtest"
  | "out_of_sample"
  | "walk_forward"
  | "live_shadow"
  | "limited_live"
  | "live"
  | "paused"
  | "retired";

export const STRATEGY_STAGE_ORDER: readonly StrategyStage[] = [
  "research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live", "live",
];

export type StrategyVisibility = "shared" | UserId; // "shared" or the owning user's id

export interface StrategyDefinition {
  id: StrategyId;
  key: string; // stable machine key, e.g. "xs_momentum"
  name: string;
  family: StrategyFamily;
  description: string;
  visibility: StrategyVisibility;
  /** Regimes in which the strategy is designed to operate. Empty = all. */
  supportedRegimes: RegimeLabel[];
  /** Global stage; a user cannot run the strategy beyond this stage. */
  stage: StrategyStage;
  currentVersionId: StrategyVersionId | null;
  createdAt: IsoTimestamp;
}

export interface StrategyVersion {
  id: StrategyVersionId;
  strategyId: StrategyId;
  version: string; // semantic, e.g. "1.4"
  parameters: Record<string, number | string | boolean>;
  changeSummary: string;
  changeReason: string;
  proposedBy: { kind: "human" | "research_agent" | "learning_engine"; id: string };
  backtestResultId: string | null;
  outOfSampleResultId: string | null;
  walkForwardResultId: string | null;
  shadowResultSummary: Record<string, number> | null;
  approvalStatus: "proposed" | "approved" | "rejected" | "superseded";
  approvedBy: UserId | null;
  deployedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

/** Per-user configuration for a strategy. Never shared between users. */
export interface UserStrategySettings {
  scope: TenantScope;
  strategyId: StrategyId;
  enabled: boolean;
  /** Stage this user runs the strategy at; must be <= global stage. */
  stage: StrategyStage;
  /** Fraction of the account's deployable capital allocated to the strategy (0..1). */
  capitalAllocation: number;
  maxPositionPct: number;
  maxLossPerTradePct: number;
  allowedSymbols: string[] | null; // null = no restriction
  blockedSymbols: string[];
  optionsAllowed: boolean;
  /** Override of minimum confidence / edge for this strategy in this account. */
  minConfidence: number | null;
  minExpectedEdge: number | null;
}

export type SignalDirection = "long" | "short" | "flat";

/** A single, independently trackable signal produced by a strategy or feature. */
export interface Signal {
  key: string; // e.g. "momentum_12_1", "vwap_zscore"
  strategyKey: string;
  symbol: string;
  direction: SignalDirection;
  /** Signed strength in [-1, 1]. */
  value: number;
  /** Raw confidence in [0, 1] before calibration. */
  confidence: number;
  horizonDays: number;
  asOf: IsoTimestamp;
  featureVersion: string;
  explanation: string;
  /** Data quality of the inputs used to compute the signal. */
  inputFreshness: "fresh" | "aging" | "stale" | "unknown";
}

export interface EnsembleComponent {
  key: string;
  weight: number;
  value: number;
  contribution: number;
  /** Cluster id for correlated signals (signals in the same cluster are de-duplicated). */
  cluster: string;
}

export interface EnsembleResult {
  symbol: string;
  strategyKey: string;
  components: EnsembleComponent[];
  /** Net expected edge in [-1, 1]; positive favours long. */
  expectedEdge: number;
  /** Calibrated confidence in [0, 1]. */
  confidence: number;
  /** Model disagreement in [0, 1]. */
  disagreement: number;
  /** 0..1 uncertainty coming from data quality and signal decay. */
  uncertainty: number;
  regime: RegimeLabel;
  asOf: IsoTimestamp;
  explanation: string[];
}

export type CandidateStatus = "candidate" | "analyzing" | "approved" | "rejected" | "expired";

/** A user-agnostic opportunity produced by the shared intelligence stack. */
export interface TradeCandidate {
  id: string;
  symbol: string;
  strategyId: StrategyId;
  strategyKey: string;
  strategyVersionId: StrategyVersionId | null;
  direction: "long" | "reduce" | "exit";
  ensemble: EnsembleResult;
  expectedUpsidePct: number;
  expectedDownsidePct: number;
  holdingPeriodDays: number;
  catalyst: string | null;
  catalystAt: IsoTimestamp | null;
  liquidityScore: number; // 0..1
  regimeFit: number; // 0..1
  historicalSimilarity: { analogs: number; positive: number; avgReturnPct: number | null } | null;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  status: CandidateStatus;
}
