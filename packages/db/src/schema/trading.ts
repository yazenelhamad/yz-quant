import { boolean, doublePrecision, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id, tenantColumns, ts, updatedAt } from "./_common.js";

export const riskSettings = pgTable("risk_settings", {
  id: id(),
  ...tenantColumns(),
  settings: jsonb("settings").notNull(),
  version: doublePrecision("version").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  updatedAt: updatedAt(),
}, (t) => [index("risk_settings_scope_idx").on(t.userId, t.brokerAccountId)]);

export const tradeTheses = pgTable("trade_theses", {
  id: id(),
  ...tenantColumns(),
  candidateId: text("candidate_id"),
  tradeId: text("trade_id"),
  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  strategyVersionId: text("strategy_version_id"),
  direction: text("direction").notNull(),
  expectedEdge: doublePrecision("expected_edge").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  calibratedConfidence: doublePrecision("calibrated_confidence").notNull(),
  marketRegime: text("market_regime").notNull(),
  status: text("status").notNull().default("draft"),
  thesis: jsonb("thesis").notNull(), // full TradeThesis
  modelName: text("model_name").notNull(),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("trade_theses_scope_idx").on(t.userId, t.brokerAccountId, t.createdAt), index("trade_theses_trade_idx").on(t.tradeId)]);

export const riskDecisions = pgTable("risk_decisions", {
  id: id(),
  ...tenantColumns(),
  candidateId: text("candidate_id"),
  tradeId: text("trade_id"),
  symbol: text("symbol").notNull(),
  action: text("action").notNull(),
  verdict: text("verdict").notNull(),
  requestedQuantity: doublePrecision("requested_quantity").notNull(),
  approvedQuantity: doublePrecision("approved_quantity").notNull(),
  approvedNotional: doublePrecision("approved_notional").notNull(),
  checks: jsonb("checks").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  failedClosed: boolean("failed_closed").notNull().default(false),
  riskEngineVersion: text("risk_engine_version").notNull(),
  decidedAt: ts("decided_at").notNull(),
}, (t) => [index("risk_decisions_scope_idx").on(t.userId, t.brokerAccountId, t.decidedAt)]);

export const trades = pgTable("trades", {
  id: id(),
  ...tenantColumns(),
  mode: text("mode").$type<"live" | "shadow">().notNull(),
  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  strategyVersionId: text("strategy_version_id"),
  thesisId: text("thesis_id"),
  candidateId: text("candidate_id"),
  state: text("state").notNull().default("candidate"),
  direction: text("direction").notNull().default("long"),
  entryQuantity: doublePrecision("entry_quantity").notNull().default(0),
  openQuantity: doublePrecision("open_quantity").notNull().default(0),
  averageEntryPrice: doublePrecision("average_entry_price"),
  averageExitPrice: doublePrecision("average_exit_price"),
  realizedPnl: doublePrecision("realized_pnl").notNull().default(0),
  fees: doublePrecision("fees").notNull().default(0),
  maxAdverseExcursionPct: doublePrecision("mae_pct"),
  maxFavorableExcursionPct: doublePrecision("mfe_pct"),
  initialConfidence: doublePrecision("initial_confidence").notNull(),
  expectedEdge: doublePrecision("expected_edge").notNull(),
  expectedDownsidePct: doublePrecision("expected_downside_pct").notNull(),
  invalidationPrice: doublePrecision("invalidation_price"),
  targetPrice: doublePrecision("target_price"),
  expectedHoldingDays: doublePrecision("expected_holding_days"),
  regimeAtEntry: text("regime_at_entry").notNull(),
  openedAt: ts("opened_at"),
  closedAt: ts("closed_at"),
  exitReason: text("exit_reason"),
  /** Versions used for the entry decision, for full reconstruction. */
  versions: jsonb("versions").notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("trades_scope_idx").on(t.userId, t.brokerAccountId, t.createdAt), index("trades_state_idx").on(t.userId, t.brokerAccountId, t.state)]);

export const tradeEvents = pgTable("trade_events", {
  id: id(),
  ...tenantColumns(),
  tradeId: text("trade_id").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  reason: text("reason").notNull(),
  detail: jsonb("detail"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("trade_events_trade_idx").on(t.tradeId, t.at)]);

export const rejectedTrades = pgTable("rejected_trades", {
  id: id(),
  ...tenantColumns(),
  candidateId: text("candidate_id"),
  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  detail: text("detail").notNull(),
  expectedEdge: doublePrecision("expected_edge").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  regime: text("regime").notNull(),
  priceAtRejection: doublePrecision("price_at_rejection"),
  rejectedAt: ts("rejected_at").notNull().defaultNow(),
  subsequentReturnPct: jsonb("subsequent_return_pct").$type<Record<string, number>>(),
  reviewVerdict: text("review_verdict"),
  reviewedAt: ts("reviewed_at"),
}, (t) => [index("rejected_trades_scope_idx").on(t.userId, t.brokerAccountId, t.rejectedAt)]);

export const approvalRequests = pgTable("approval_requests", {
  id: id(),
  ...tenantColumns(),
  tradeId: text("trade_id").notNull(),
  thesisId: text("thesis_id"),
  symbol: text("symbol").notNull(),
  action: text("action").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  notional: doublePrecision("notional").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | declined | expired
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("approval_requests_scope_idx").on(t.userId, t.brokerAccountId, t.status)]);

export const executionOutcomes = pgTable("execution_outcomes", {
  id: id(),
  ...tenantColumns(),
  orderId: text("order_id").notNull(),
  brokerOrderId: text("broker_order_id"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  expectedPrice: doublePrecision("expected_price").notNull(),
  arrivalPrice: doublePrecision("arrival_price").notNull(),
  fillPrice: doublePrecision("fill_price"),
  expectedSlippageBps: doublePrecision("expected_slippage_bps").notNull(),
  actualSlippageBps: doublePrecision("actual_slippage_bps"),
  timeToFillSeconds: doublePrecision("time_to_fill_seconds"),
  partial: boolean("partial").notNull().default(false),
  missed: boolean("missed").notNull().default(false),
  reprices: doublePrecision("reprices").notNull().default(0),
  cancelled: boolean("cancelled").notNull().default(false),
  liquidityBucket: text("liquidity_bucket").notNull(),
  session: text("session").notNull(),
  mode: text("mode").$type<"live" | "shadow">().notNull(),
  at: ts("at").notNull(),
}, (t) => [index("execution_outcomes_scope_idx").on(t.userId, t.brokerAccountId, t.at)]);

export const performanceSnapshots = pgTable("performance_snapshots", {
  id: id(),
  ...tenantColumns(),
  period: text("period").notNull(), // day | week | month | all
  asOf: ts("as_of").notNull(),
  mode: text("mode").$type<"live" | "shadow">().notNull(),
  stats: jsonb("stats").notNull(),
  byStrategy: jsonb("by_strategy").notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("performance_snapshots_scope_idx").on(t.userId, t.brokerAccountId, t.asOf)]);
