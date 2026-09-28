/**
 * HTTP contract types for the dashboard. These mirror docs/API.md and the domain
 * shapes in packages/core/src/types. Where the contract only says `[...]` the shape
 * chosen here is documented in the final report so the API can match it.
 *
 * Unit conventions (resolved ambiguity): every field ending in `Pct` is a FRACTION
 * (0.0123 === 1.23%), matching RiskSettingsSchema in @yz/core. Confidence, edge,
 * scores and fits are 0..1 (fit is -1..1). Money is USD. Times are ISO-8601 UTC.
 */

export type UserRole = "admin" | "trader";
export type AutonomyLevel = "research_only" | "shadow" | "manual_approval" | "semi_autonomous" | "fully_autonomous";
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["research_only", "shadow", "manual_approval", "semi_autonomous", "fully_autonomous"];

export type Freshness = "fresh" | "aging" | "stale" | "unknown";
export type HealthStatus = "healthy" | "warning" | "critical" | "unknown";

// ---------------------------------------------------------------- errors
export interface ApiErrorEnvelope {
  error: { code: string; message: string; detail?: unknown };
}

// ---------------------------------------------------------------- auth
export interface SessionUser {
  id: string;
  username: string | null;
  email: string | null;
  displayName: string;
  /** Personal product name for this user, e.g. "Elhamad's Quant". */
  brandName: string;
  role: UserRole;
  mfaEnabled: boolean;
}
export interface SessionInfo {
  user: SessionUser;
  csrfToken: string;
  expiresAt: string;
  inactivityTimeoutSeconds: number;
  stepUpValidUntil: string | null;
}
export interface LoginResponse { ok: true; mfaRequired: boolean }
export interface OkResponse { ok: true }
export interface StepUpResponse { ok: true; validUntil: string }
export interface MfaEnrollResponse { secret: string; otpauthUrl: string; qrDataUrl: string }
export interface MfaConfirmResponse { ok: true; recoveryCodes: string[] }
export interface SessionRecord {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
export interface SessionsResponse { sessions: SessionRecord[] }
export interface RevokeAllResponse { ok: true; revoked: number }

// ---------------------------------------------------------------- accounts
export type BrokerKind = "robinhood_agentic" | "simulated";
export type BrokerConnectionStatus =
  | "not_connected" | "connecting" | "connected" | "token_expired" | "unreliable" | "revoked" | "error";

export interface PortfolioSummary {
  asOf: string;
  totalValue: number;
  cash: number;
  buyingPower: number;
  equityValue: number;
  dailyPnl: number;
  totalPnl: number;
  drawdownPct: number;
  exposurePct: number;
}

export interface AccountSummary {
  id: string;
  kind: BrokerKind;
  label: string;
  accountNumberMasked: string | null;
  agenticAllowed: boolean;
  accountType: "cash" | "margin" | "limited_margin" | "unknown";
  optionsEnabledAtBroker: boolean;
  status: BrokerConnectionStatus;
  statusDetail: string | null;
  lastHealthyAt: string | null;
  lastReconciledAt: string | null;
  reconciliationOk: boolean | null;
  autonomyLevel: AutonomyLevel;
  tradingPaused: boolean;
  pausedReason: string | null;
  portfolio: PortfolioSummary | null;
  killSwitchActive: boolean;
  owner: { id: string; displayName: string };
}
export interface AccountsResponse {
  accounts: AccountSummary[];
  /** Admins only: every account in the system (read-only comparison). */
  allAccounts?: AccountSummary[];
}

export interface RiskSettings {
  maxCapitalDeployedPct: number;
  maxPositionPct: number;
  maxSectorPct: number;
  maxCorrelatedExposurePct: number;
  maxPortfolioBeta: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxDrawdownPct: number;
  maxSimultaneousPositions: number;
  maxOptionsExposurePct: number;
  maxLossPerTradePct: number;
  minLiquidityAdv: number;
  minConfidence: number;
  minExpectedEdge: number;
  maxSpreadBps: number;
  maxAnnualizedVolatility: number;
  semiAutoApprovalNotional: number;
  tradingHours: { start: string; end: string; timezone: string; allowExtendedHours: boolean };
  restrictedSymbols: string[];
  allowedSymbols: string[] | null;
  optionsEnabled: boolean;
  kellyFraction: number;
}

export type KillSwitchReason =
  | "daily_loss_limit" | "weekly_loss_limit" | "drawdown_limit" | "market_data_failure" | "broker_unreliable"
  | "reconciliation_failed" | "position_mismatch" | "abnormal_ai_output" | "repeated_execution_failures"
  | "database_error" | "unexpected_position" | "emergency_volatility" | "manual" | "admin_global";

export interface KillSwitchView {
  active: boolean;
  reasons: KillSwitchReason[];
  allowRiskReducingExits: boolean;
  triggeredAt: string | null;
  triggeredBy: string | null;
  note: string | null;
}

export interface BrokerStatus {
  status: BrokerConnectionStatus;
  detail: string | null;
  lastHealthyAt: string | null;
  consecutiveFailures: number;
  tools: string[] | null;
  agenticAccountNumberMasked: string | null;
}
export interface BrokerConnectResponse { authorizationUrl: string }
export interface BrokerSyncResponse {
  portfolio: PortfolioSummary | null;
  positions: number;
  orders: number;
  reconciliation: { ok: boolean; mismatches: string[] } | null;
}

// ---------------------------------------------------------------- market / regime
export type RegimeLabel =
  | "bull_trend" | "bear_trend" | "range_bound" | "high_volatility" | "low_volatility" | "risk_on" | "risk_off"
  | "liquidity_shock" | "event_driven" | "sector_rotation" | "momentum" | "mean_reversion";

export interface RegimeAssessment {
  asOf: string;
  primary: RegimeLabel;
  probabilities: Partial<Record<RegimeLabel, number>>;
  confidence: number;
  abnormality: number;
  metrics: Record<string, number | null>;
  familyBias: Record<string, number>;
  explanation: string[];
  dataQuality: Freshness;
}
export interface MarketRegimeResponse {
  current: RegimeAssessment | null;
  history: { asOf: string; primary: RegimeLabel; confidence: number }[];
  usefulness: Record<string, number | string | null>;
}

// ---------------------------------------------------------------- overview & opportunities
export interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
  at: string;
}

export interface EnsembleComponent {
  key: string;
  weight: number;
  value: number;
  contribution: number;
  cluster: string;
}

export type CandidateStatus = "candidate" | "analyzing" | "approved" | "rejected" | "expired";

export interface Opportunity {
  candidateId: string;
  symbol: string;
  strategyKey: string;
  strategyName: string;
  expectedEdge: number;
  confidence: number;
  calibratedConfidence: number;
  potentialDownsidePct: number;
  holdingPeriodDays: number;
  regimeFit: number;
  liquidityScore: number;
  catalyst: string | null;
  risk: { score: number; notes: string[] };
  /** -1..1, computed for the selected account. */
  portfolioFit: number | null;
  historicalSimilarity: { analogs: number; positive: number; avgReturnPct: number | null } | null;
  strategyPerformance: { trades: number; winRate: number | null; expectancyPct: number | null; profitFactor: number | null } | null;
  variantScore: number | null;
  finalStatus: CandidateStatus | string;
  reasons: string[];
  createdAt: string;
  /** Optional ensemble breakdown (requested addition, see report). */
  ensemble?: { components: EnsembleComponent[]; explanation: string[]; disagreement: number; uncertainty: number } | null;
}

export interface OverviewResponse {
  account: AccountSummary;
  portfolio: PortfolioSummary | null;
  pnl: { daily: number | null; total: number | null; dailyPct: number | null; totalPct: number | null };
  positionsCount: number;
  exposure: { grossPct: number | null; bySector: Record<string, number>; beta: number | null };
  regime: RegimeAssessment | null;
  drawdownPct: number | null;
  risk: { utilization: Record<string, { used: number; limit: number }>; capacity: number | null };
  activeStrategies: { id: string; key: string; name: string; stage: StrategyStage; allocation: number }[];
  topOpportunities: Opportunity[];
  upcomingCatalysts: { symbol: string; kind: string; at: string; description: string }[];
  alerts: Alert[];
  executionIssues: { orderId: string; symbol: string; issue: string; at: string }[];
  broker: { status: BrokerConnectionStatus; detail: string | null };
  dataQuality: { quotes: Freshness; bars: Freshness; regime: Freshness };
}

// ---------------------------------------------------------------- positions & theses
export interface Evidence {
  source: string;
  kind: string;
  observedAt: string;
  reliability: number;
  summary: string;
}
export interface HistoricalAnalog {
  tradeId: string;
  symbol: string;
  strategyKey: string;
  regime: string;
  similarity: number;
  returnPct: number | null;
  thesisCorrect: boolean | null;
  lesson: string | null;
}
export interface ModelVote { agent: string; vote: string; confidence: number; note: string }

export interface TradeThesis {
  id: string;
  ticker: string;
  strategyKey: string;
  direction: "long" | "reduce" | "exit";
  expectedHoldingPeriodDays: number;
  entryLogic: string;
  expectedEdge: number;
  confidence: number;
  calibratedConfidence: number;
  marketRegime: string;
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];
  catalyst: string | null;
  catalystAt: string | null;
  expectedUpsidePct: number;
  expectedDownsidePct: number;
  proposedQuantity: number;
  proposedNotional: number;
  invalidationPoint: string;
  invalidationPrice: number | null;
  exitConditions: string[];
  targetPrice: number | null;
  maxAcceptableLossPct: number;
  portfolioImpact: {
    positionPctAfter: number; sectorPctAfter: number; sector: string | null;
    correlationToPortfolio: number | null; betaAfter: number | null; fitScore: number; notes: string[];
  };
  liquidity: { adv: number | null; spreadBps: number | null; score: number };
  executionMethod: { orderType: string; limitLogic: string | null; urgency: string; staging: string | null };
  dataFreshness: Freshness;
  similarHistoricalTrades: HistoricalAnalog[];
  strategyPerformanceInRegime: { trades: number; winRate: number | null; expectancyPct: number | null; profitFactor: number | null } | null;
  modelVotes: ModelVote[];
  devilsAdvocate: {
    whyWrong: string[]; late: boolean; pricedIn: boolean; sharedSignalRisk: boolean; eventRisk: boolean;
    recentSimilarTradesPoor: boolean; overconfidenceFlag: boolean; verdict: "proceed" | "reduce" | "wait" | "reject";
  } | null;
  variantPerception: { score: number; summary: string; recommendedAction: string } | null;
  plainEnglish: string;
  versions: Record<string, string>;
  createdAt: string;
  status: "draft" | "active" | "superseded" | "invalidated" | "closed";
}

export interface PositionView {
  symbol: string;
  quantity: number;
  sharesAvailableForSells: number;
  averageCost: number | null;
  markPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  strategyKey: string | null;
  tradeId: string | null;
  thesisId: string | null;
  entryReason: string | null;
  initialConfidence: number | null;
  currentConfidence: number | null;
  regimeAtEntry: string | null;
  currentRegime: string | null;
  expectedHoldingDays: number | null;
  ageDays: number | null;
  invalidationPrice: number | null;
  invalidationCondition: string | null;
  targetPrice: number | null;
  exitLogic: string | null;
  riskContribution: number | null;
  /** True when the position was not opened by the platform. */
  external: boolean;
  dataFreshness: Freshness;
}

export type OrderState =
  | "new" | "queued" | "unconfirmed" | "confirmed" | "partially_filled" | "filled" | "pending_cancelled" | "cancelled"
  | "partially_filled_rest_cancelled" | "rejected" | "failed" | "voided" | "locating" | "locate_failed" | "unknown";

export interface Order {
  brokerOrderId: string;
  refId: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_market" | "stop_limit";
  state: OrderState;
  quantity: number | null;
  cumulativeQuantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  averagePrice: number | null;
  fees: number;
  timeInForce: string;
  marketHours: string;
  placedAgent: string | null;
  tradeId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewsItem {
  source: string;
  headline: string;
  at: string;
  url?: string | null;
  sentiment?: number | null;
  genuinelyNew?: boolean | null;
}

export interface ThesisHistoryEntry {
  thesisId: string;
  at: string;
  status: TradeThesis["status"];
  confidence: number;
  calibratedConfidence: number;
  expectedEdge: number;
  summary: string;
}

export interface PositionDetail extends PositionView {
  thesis: TradeThesis | null;
  thesisHistory: ThesisHistoryEntry[];
  modelVotes: ModelVote[];
  news: NewsItem[];
  reasonsToHold: string[];
  reasonsToExit: string[];
  similarTrades: HistoricalAnalog[];
  orders: Order[];
}
export interface ClosePositionResponse { tradeId: string; orderId: string | null }

// ---------------------------------------------------------------- trades, decisions
export type TradeLifecycleState =
  | "candidate" | "analyzing" | "approved" | "waiting_for_entry" | "order_submitted" | "partially_filled" | "filled"
  | "monitoring" | "reduce" | "exit_requested" | "closed" | "rejected" | "canceled";

export interface TradeView {
  id: string;
  mode: "live" | "shadow";
  symbol: string;
  strategyId: string;
  strategyKey?: string | null;
  strategyVersionId: string | null;
  thesisId: string | null;
  state: TradeLifecycleState;
  direction: "long";
  entryQuantity: number;
  openQuantity: number;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  realizedPnl: number;
  fees: number;
  maxAdverseExcursionPct: number | null;
  maxFavorableExcursionPct: number | null;
  initialConfidence: number;
  expectedEdge: number;
  expectedDownsidePct: number;
  regimeAtEntry: string;
  openedAt: string | null;
  closedAt: string | null;
  exitReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskCheck {
  code: string;
  passed: boolean;
  severity: "info" | "warning" | "blocking";
  detail: string;
  observed?: number | string | null;
  limit?: number | string | null;
}
export interface RiskDecision {
  id: string;
  candidateId: string | null;
  tradeId: string | null;
  symbol: string;
  action: string;
  verdict: "approve" | "reduce" | "reject";
  approvedQuantity: number;
  approvedNotional: number;
  requestedQuantity: number;
  checks: RiskCheck[];
  reasons: string[];
  riskEngineVersion: string;
  decidedAt: string;
  failedClosed: boolean;
}

export type FastAction = "BUY" | "SELL" | "HOLD" | "WAIT" | "REDUCE" | "EXIT" | "CANCEL_ORDER" | "REPRICE_ORDER";
export interface FastBrainOutput {
  symbol: string;
  probabilities: Record<FastAction, number>;
  action: FastAction;
  conviction: number;
  reasons: string[];
  modelVersion: string;
  decidedAt: string;
}

export interface Fill {
  brokerOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fees: number;
  derived: boolean;
  at: string;
}
export interface TradeEvent { at: string; from: TradeLifecycleState | null; to: TradeLifecycleState; note: string | null }

export type OutcomeClassification =
  | "good_win" | "bad_win" | "good_loss" | "bad_thesis" | "bad_timing" | "bad_execution" | "oversized"
  | "unexpected_event" | "model_error" | "data_error" | "regime_change";

export interface PostTradeReview {
  id: string;
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
  reviewedAt: string;
  reviewerVersion: string;
}

export interface TradeLesson {
  id: string;
  tradeId: string | null;
  strategyKey: string;
  regime: string;
  setup: string;
  expected: string;
  actual: string;
  lesson: string;
  action: string;
  tags: Record<string, string>;
  confidenceImpact: number;
  createdAt: string;
  timesConfirmed: number;
  timesContradicted: number;
}

export interface TradeDetailResponse {
  trade: TradeView;
  thesis: TradeThesis | null;
  events: TradeEvent[];
  orders: Order[];
  fills: Fill[];
  riskDecisions: RiskDecision[];
  review: PostTradeReview | null;
  lessons: TradeLesson[];
  explanation: string;
}

export type RejectionReason =
  | "insufficient_confidence" | "insufficient_expected_edge" | "portfolio_concentration" | "poor_liquidity"
  | "bad_risk_reward" | "event_risk" | "stale_data" | "strategy_disabled" | "risk_limit_exceeded" | "kill_switch"
  | "autonomy_level" | "no_thesis" | "devils_advocate" | "execution_cost" | "broker_unavailable" | "identity_uncertain" | "other";

export interface RejectedTrade {
  id: string;
  candidateId: string | null;
  symbol: string;
  strategyId: string;
  strategyKey?: string | null;
  reasons: RejectionReason[];
  detail: string;
  expectedEdge: number;
  confidence: number;
  regime: string;
  priceAtRejection: number | null;
  rejectedAt: string;
  subsequentReturnPct: Record<string, number> | null;
  reviewVerdict: "correct_rejection" | "missed_opportunity" | "undetermined" | null;
}

export interface Approval {
  id: string;
  tradeId: string | null;
  candidateId: string | null;
  symbol: string;
  action: string;
  quantity: number;
  notional: number;
  reason: string;
  requestedAt: string;
  expiresAt: string | null;
  status: "pending" | "approved" | "declined" | "expired";
}

// ---------------------------------------------------------------- strategies
export type StrategyFamily = "trend_momentum" | "mean_reversion" | "statistical" | "event" | "options_volatility" | "fundamental_variant";
export type StrategyStage =
  | "research" | "backtest" | "out_of_sample" | "walk_forward" | "live_shadow" | "limited_live" | "live" | "paused" | "retired";
export const STRATEGY_STAGE_ORDER: readonly StrategyStage[] = [
  "research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live", "live",
];

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

export interface UserStrategySettings {
  strategyId: string;
  enabled: boolean;
  stage: StrategyStage;
  capitalAllocation: number;
  maxPositionPct: number;
  maxLossPerTradePct: number;
  allowedSymbols: string[] | null;
  blockedSymbols: string[];
  optionsAllowed: boolean;
  minConfidence: number | null;
  minExpectedEdge: number | null;
}

/** Shape chosen for `StrategyScorecard` (contract leaves it open). */
export interface StrategyScorecard {
  mode: "live" | "shadow" | "backtest" | "all";
  stats: PerformanceStats;
  recent: PerformanceStats | null;
  lastTradeAt: string | null;
  updatedAt: string;
}

export interface AccountStrategyRow {
  id: string;
  key: string;
  name: string;
  family: StrategyFamily;
  description: string;
  visibility: string;
  globalStage: StrategyStage;
  globallyDisabled: boolean;
  settings: UserStrategySettings;
  scorecard: StrategyScorecard | null;
}
export interface AccountStrategiesResponse { strategies: AccountStrategyRow[] }

export interface StrategyDefinition {
  id: string;
  key: string;
  name: string;
  family: StrategyFamily;
  description: string;
  visibility: string;
  supportedRegimes: RegimeLabel[];
  stage: StrategyStage;
  currentVersionId: string | null;
  createdAt: string;
}
export interface StrategyVersion {
  id: string;
  strategyId: string;
  version: string;
  parameters: Record<string, number | string | boolean>;
  changeSummary: string;
  changeReason: string;
  proposedBy: { kind: "human" | "research_agent" | "learning_engine"; id: string };
  backtestResultId: string | null;
  outOfSampleResultId: string | null;
  walkForwardResultId: string | null;
  approvalStatus: "proposed" | "approved" | "rejected" | "superseded";
  approvedBy: string | null;
  deployedAt: string | null;
  createdAt: string;
}
export interface SharedStrategiesResponse {
  strategies: (StrategyDefinition & { scorecard: StrategyScorecard | null; versionCount?: number })[];
}

export interface CalibrationBucket {
  lower: number;
  upper: number;
  predictions: number;
  successes: number;
  observed: number | null;
  predicted: number | null;
}
export interface CalibrationProfile {
  key: string;
  buckets: CalibrationBucket[];
  brierScore: number | null;
  expectedCalibrationError: number | null;
  overconfidenceRatio: number | null;
  sampleSize: number;
  updatedAt: string;
}

export interface StrategyIntelligenceProfile {
  strategyId: string;
  strategyKey: string;
  mode: "live" | "shadow" | "backtest" | "all";
  overall: PerformanceStats;
  recent: PerformanceStats;
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
    recommendedAllocationDelta: number;
    recommendedStatus: "keep_live" | "move_to_shadow" | "pause" | "increase" | "insufficient_data";
    plainEnglish: string;
  };
  updatedAt: string;
}

export interface StrategyDetailResponse {
  strategy: StrategyDefinition;
  versions: StrategyVersion[];
  scorecards: { system: StrategyScorecard | null; byAccount: Record<string, StrategyScorecard | null> };
  profile: StrategyIntelligenceProfile | null;
}

// ---------------------------------------------------------------- risk view
export interface RiskViewResponse {
  settings: RiskSettings;
  utilization: Record<string, { used: number; limit: number }>;
  killSwitch: KillSwitchView;
  global: { liveExecutionDisabled: boolean; forceShadowMode: boolean; pausedByAdmin: boolean };
  recentDecisions: RiskDecision[];
  alerts: Alert[];
}

// ---------------------------------------------------------------- analytics
export interface TimePoint { time: string; value: number }
export interface AnalyticsResponse {
  performance: PerformanceStats;
  byStrategy: { strategyKey: string; name?: string; stats: PerformanceStats; realizedPnl: number | null }[];
  equityCurve: TimePoint[];
  drawdownCurve: TimePoint[];
  exposureHistory: TimePoint[];
  realizedPnlFromBroker: { total: number | null; asOf: string | null; period?: string; note?: string | null } | null;
}

// ---------------------------------------------------------------- journal
export interface JournalEntry {
  tradeId: string;
  symbol: string;
  strategyKey: string;
  openedAt: string | null;
  closedAt: string | null;
  returnPct: number | null;
  classification: OutcomeClassification | null;
  thesisSummary: string;
  lesson: string | null;
}
export interface JournalResponse { entries: JournalEntry[] }

// ---------------------------------------------------------------- learning
export interface Digest {
  period: "today" | "week" | string;
  generatedAt: string;
  summary: string;
  highlights: string[];
  tradesReviewed?: number;
}
export interface StrategyTrendItem {
  strategyKey: string;
  name?: string;
  trend: "improving" | "deteriorating" | "stable" | "insufficient_data";
  recentExpectancyPct: number | null;
  longTermExpectancyPct: number | null;
  note: string;
}
export interface SignalTrendItem {
  signalKey: string;
  recentPredictiveValue: number | null;
  historicalPredictiveValue: number | null;
  currentWeight: number;
  note: string;
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
  updatedAt: string;
}
export interface AgentIntelligenceProfile {
  agentName: string;
  decisionsInfluenced: number;
  valueAdded: number | null;
  vetoAccuracy: number | null;
  calibration: CalibrationProfile;
  influenceWeight: number;
  updatedAt: string;
}
export interface RepeatedMistake {
  pattern: string;
  occurrences: number;
  strategyKey: string | null;
  lastSeenAt: string;
  suggestedAction: string;
}
export interface RegimeInsight { regime: string; insight: string; evidence: string[] }
export interface ExecutionInsight { bucket: string; insight: string; avgSlippageBps: number | null; fillRate: number | null }
export interface AdaptationProposal {
  id: string;
  target: "signal_weight" | "strategy_allocation" | "confidence_calibration" | "execution_preference" | "model_routing" | "strategy_ranking";
  key: string;
  currentValue: number;
  proposedValue: number;
  bounds: { min: number; max: number; maxStepPerDay: number };
  evidence: string;
  autoApplicable: boolean;
  requiresValidationPipeline: boolean;
  createdAt: string;
  appliedAt: string | null;
}
export interface LearningHealth { status: HealthStatus; lastRunAt: string | null; frozen: boolean; reason: string | null }

export interface LearningView {
  today: Digest | null;
  week: Digest | null;
  strategiesImproving: StrategyTrendItem[];
  strategiesDeteriorating: StrategyTrendItem[];
  signalsImproving: SignalTrendItem[];
  signalsDeteriorating: SignalTrendItem[];
  calibration: CalibrationProfile[];
  models: ModelIntelligenceProfile[];
  agents: AgentIntelligenceProfile[];
  recentLessons: TradeLesson[];
  repeatedMistakes: RepeatedMistake[];
  missedOpportunities: RejectedTrade[];
  regimeInsights: RegimeInsight[];
  executionInsights: ExecutionInsight[];
  adaptationProposals: AdaptationProposal[];
  learningHealth: LearningHealth;
}

// ---------------------------------------------------------------- research & backtests
export interface Experiment {
  id: string;
  title: string;
  hypothesis: string;
  strategyKey: string | null;
  status: "proposed" | "running" | "completed" | "abandoned";
  method: string | null;
  conclusion: string | null;
  createdBy: { kind: "human" | "research_agent"; id: string; displayName?: string };
  createdAt: string;
  updatedAt: string;
}
export interface ExperimentsResponse { experiments: Experiment[] }
export interface CreateExperimentBody { title: string; hypothesis: string; strategyKey?: string | null; method?: string | null }

export type BacktestKind = "in_sample" | "out_of_sample" | "walk_forward" | "monte_carlo" | "stress" | "sensitivity";
export interface BacktestMetrics {
  cagr: number | null;
  totalReturnPct: number;
  annualizedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationBars: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  turnover: number;
  exposure: number;
  var95Pct: number | null;
  cvar95Pct: number | null;
  tradeCount: number;
  grossReturnPct: number;
  totalCosts: number;
  netReturnPct: number;
  byRegime: Record<string, { trades: number; returnPct: number; winRate: number | null }>;
}
export interface BacktestTrade {
  symbol: string;
  entryTime: string;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  side: "long";
  grossPnl: number;
  costs: number;
  netPnl: number;
  returnPct: number;
  holdingBars: number;
  regime: string;
  confidence: number;
  maePct: number;
  mfePct: number;
  exitReason: string;
}
export interface EquityPoint { time: string; equity: number; drawdownPct: number; exposure: number }
export interface BacktestResult {
  id: string;
  config: { strategyKey: string; strategyVersion: string; symbols: string[]; start: string; end: string; interval: string; initialCapital: number; parameters: Record<string, number | string | boolean> };
  kind: BacktestKind;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  warnings: string[];
  dataFingerprint: string;
  ranAt: string;
  durationMs: number;
}
export interface WalkForwardResult {
  folds: { train: [string, string]; test: [string, string]; metrics: BacktestMetrics; parameters: Record<string, number | string | boolean> }[];
  aggregate: BacktestMetrics;
  parameterStability: number | null;
  overfittingScore: number | null;
}
export interface MonteCarloResult {
  runs: number;
  medianReturnPct: number;
  p05ReturnPct: number;
  p95ReturnPct: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  probabilityOfLoss: number;
  /** Optional per-step bands for charting (requested addition, see report). */
  bands?: { time: string; p05: number; p50: number; p95: number }[] | null;
}
export interface BacktestRun {
  id: string;
  strategyKey: string;
  versionId: string | null;
  kind: BacktestKind;
  symbols: string[];
  start: string;
  end: string;
  status: "queued" | "running" | "completed" | "failed";
  requestedBy: string | null;
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
  summary: { totalReturnPct: number; sharpe: number | null; maxDrawdownPct: number; tradeCount: number } | null;
}
export interface BacktestsResponse { backtests: BacktestRun[] }
export interface BacktestDetailResponse {
  backtest: BacktestRun;
  result: BacktestResult | null;
  walkForward: WalkForwardResult | null;
  monteCarlo: MonteCarloResult | null;
}
export interface RunBacktestBody { strategyKey: string; versionId?: string; symbols: string[]; start: string; end: string; kind: BacktestKind }
export interface RunBacktestResponse { id: string; status: BacktestRun["status"] }

// ---------------------------------------------------------------- system & admin
export interface HealthComponent {
  name: string;
  status: HealthStatus;
  detail: string;
  checkedAt: string;
  metrics?: Record<string, number | string | null>;
}
export interface HealthResponse { overall: HealthStatus; components: HealthComponent[] }

export type AuditCategory =
  | "auth" | "session" | "settings" | "autonomy" | "broker" | "market_data" | "thesis" | "risk" | "order" | "fill"
  | "reconciliation" | "kill_switch" | "learning" | "admin" | "strategy" | "model" | "system";
export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  "auth", "session", "settings", "autonomy", "broker", "market_data", "thesis", "risk", "order", "fill",
  "reconciliation", "kill_switch", "learning", "admin", "strategy", "model", "system",
];
export interface AuditEvent {
  id: string;
  at: string;
  category: AuditCategory;
  action: string;
  userId: string | null;
  brokerAccountId: string | null;
  actorUserId: string | null;
  strategyId: string | null;
  tradeId: string | null;
  orderId: string | null;
  result: "ok" | "error" | "rejected" | "info";
  detail: Record<string, unknown>;
  error: string | null;
  ip: string | null;
}
export interface AuditResponse { events: AuditEvent[] }

export interface ComparisonRow {
  owner: { id: string; displayName: string };
  account: AccountSummary;
  dailyPnl: number | null;
  totalReturnPct: number | null;
  drawdownPct: number | null;
  exposurePct: number | null;
  riskUtilization: Record<string, { used: number; limit: number }>;
  activeStrategies: number;
  positions: number;
}
export interface ComparisonResponse { accounts: ComparisonRow[] }

export interface GlobalRiskState {
  liveExecutionDisabled: boolean;
  forceShadowMode: boolean;
  pausedUsers: string[];
  disabledStrategyIds: string[];
  globalKillSwitch: KillSwitchView;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ModelRegistryEntry {
  name: string;
  provider: string;
  version: string;
  role: string;
  enabled: boolean;
  configured: boolean;
  routingWeight: number;
  costPer1kTokensUsd: number | null;
  latencyMsP50: number | null;
  failureRate: number | null;
}
export interface ModelsResponse { models: ModelRegistryEntry[]; configured: boolean }
export interface AgentRegistryEntry {
  name: string;
  description: string;
  enabled: boolean;
  influenceWeight: number;
  model: string | null;
  promptVersion: string | null;
}
export interface AgentsResponse { agents: AgentRegistryEntry[] }

export interface AdminUser {
  id: string;
  username: string | null;
  email: string | null;
  displayName: string;
  role: UserRole;
  mfaEnabled: boolean;
  sessionsCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  accounts?: { id: string; label: string; kind: BrokerKind }[];
}
export interface AdminUsersResponse { users: AdminUser[] }

export interface JobRun {
  id: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  detail: Record<string, unknown> | null;
}
export interface JobsResponse { jobs: JobRun[] }

export interface SystemEvent { id: string; at: string; level: "info" | "warning" | "error"; source: string; message: string }
export interface SystemEventsResponse { events: SystemEvent[] }

export interface Quote {
  symbol: string;
  last: number;
  bid: number | null;
  ask: number | null;
  previousClose: number | null;
  lastTradeAt: string | null;
  session: string;
  instrumentState: string;
  provenance: { source: string; observedAt: string; receivedAt: string; reliability: number };
}
