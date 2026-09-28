import type {
  AutonomyLevel,
  BrokerConnectionStatus,
  Freshness,
  GlobalRiskState,
  IsoTimestamp,
  KillSwitchState,
  MarketSession,
  OrderSide,
  RiskDecision,
  RiskSettings,
  StrategyStage,
  TenantScope,
  TradeMode,
} from "../types/index.js";

export type RiskAction = "enter" | "add" | "reduce" | "exit" | "cancel" | "reprice";

export const RISK_ACTIONS: readonly RiskAction[] = ["enter", "add", "reduce", "exit", "cancel", "reprice"];
export const ENTRY_ACTIONS: ReadonlySet<RiskAction> = new Set<RiskAction>(["enter", "add"]);
export const RISK_REDUCING_ACTIONS: ReadonlySet<RiskAction> = new Set<RiskAction>(["reduce", "exit", "cancel"]);

export interface RiskCandidateMetrics {
  expectedEdge: number | null;
  /** Calibrated signal confidence 0..1 (how sure the signals are; gated by min_confidence). */
  confidence: number | null;
  /** Win probability at the trade's payoff (breakeven plus forecast tilt); must exceed breakeven. */
  winProbability?: number | null;
  disagreement: number | null;
  uncertainty: number | null;
  /** Expected adverse move as a positive fraction (distance to the risk stop). */
  expectedDownsidePct: number | null;
  /** Expected favourable move as a positive fraction (distance to the target); with the downside it sets the payoff ratio. */
  expectedUpsidePct?: number | null;
  /** The risk stop level the downside was measured to; the engine re-measures it from the entry price. */
  invalidationPrice?: number | null;
  annualizedVol: number | null;
  spreadBps: number | null;
  /** Average daily dollar volume. */
  adv: number | null;
  liquidityScore: number | null;
  /** Candidate beta; null => treated as 1.0 with a warning. */
  beta: number | null;
}

export interface RiskDataQuality {
  quoteFreshness: Freshness;
  quoteAgeSeconds: number | null;
  barsFreshness: Freshness;
  regimeFreshness: Freshness;
  contradictory: boolean;
}

export interface RiskPortfolioPosition {
  symbol: string;
  assetClass: "equity" | "option" | "crypto";
  sector: string | null;
  beta: number | null;
  quantity: number;
  /** Null when the mark is missing/stale. Entries fail closed when any value is unknown. */
  marketValue: number | null;
  correlationToCandidate: number | null;
}

export interface RiskPortfolioState {
  totalValue: number | null;
  cash: number | null;
  buyingPower: number | null;
  positions: RiskPortfolioPosition[];
  openOrdersCount: number;
  /** Positive fraction below peak. */
  currentDrawdownPct: number | null;
  /** Signed fractions. */
  dailyPnlPct: number | null;
  weeklyPnlPct: number | null;
  peakValue: number | null;
}

export interface RiskAccountState {
  identityVerified: boolean;
  accountMappingVerified: boolean;
  paused: boolean;
  brokerStatus: BrokerConnectionStatus;
  reconciliationOk: boolean | null;
  reconciliationAgeSeconds: number | null;
  autonomyLevel: AutonomyLevel;
  killSwitch: KillSwitchState;
}

export interface RiskStrategyState {
  strategyId: string;
  enabledForUser: boolean;
  globallyDisabled: boolean;
  userStage: StrategyStage;
  globalStage: StrategyStage;
  optionsAllowed: boolean;
  /** Event-driven strategies are allowed to trade into scheduled events. */
  isEventStrategy: boolean;
}

export interface RiskMarketState {
  session: MarketSession;
}

export interface RiskLimits {
  /** Max quote age for entries and reprices (default 90s). */
  maxQuoteAgeSeconds?: number;
  /** Max reconciliation age for entries (default 15 minutes). */
  maxReconciliationAgeSeconds?: number;
  /** Disagreement thresholds (default reduce > 0.5, reject > 0.7). */
  disagreementReduce?: number;
  disagreementReject?: number;
  /** Uncertainty thresholds (default reduce > 0.5, reject > 0.75). */
  uncertaintyReduce?: number;
  uncertaintyReject?: number;
  /** |correlation| at or above which a holding counts as correlated exposure (default 0.5). */
  correlatedThreshold?: number;
  /** Minimum fraction of the requested quantity a reduction may keep (default 0.25). */
  minReduceFraction?: number;
}

export interface RiskInput {
  decisionId: string;
  candidateId: string | null;
  tradeId: string | null;
  scope: TenantScope;
  now: IsoTimestamp;
  action: RiskAction;
  symbol: string;
  side: OrderSide;
  quantity: number | null;
  price: number | null;
  estimatedNotional: number | null;
  assetClass: "equity" | "option" | "crypto";
  sector: string | null;
  /** live = real capital; shadow = simulated. Shadow relaxes broker/autonomy/stage checks only. */
  mode: TradeMode;
  fractionalAllowed?: boolean;
  candidate: RiskCandidateMetrics;
  dataQuality: RiskDataQuality;
  portfolio: RiskPortfolioState;
  settings: RiskSettings;
  global: GlobalRiskState;
  account: RiskAccountState;
  market: RiskMarketState;
  strategy: RiskStrategyState;
  /** Earnings (or comparable scheduled event) inside the holding horizon. */
  eventRiskWithinHorizon: boolean;
  limits?: RiskLimits;
}

export interface RiskEvaluation extends RiskDecision {
  /** True when the verdict is approve/reduce but a human must confirm before submission. */
  requiresApproval: boolean;
  /** Largest quantity every limit allows (entries only). */
  maxAllowedQuantity: number | null;
}
