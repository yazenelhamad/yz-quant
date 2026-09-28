import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_common.js";

export const postTradeReviews = pgTable("post_trade_reviews", {
  id: id(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  tradeId: text("trade_id").notNull(),
  classification: text("classification").notNull(),
  review: jsonb("review").notNull(), // full PostTradeReview
  reviewerVersion: text("reviewer_version").notNull(),
  reviewedAt: ts("reviewed_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("post_trade_reviews_trade_uq").on(t.tradeId)]);

export const tradeLessons = pgTable("trade_lessons", {
  id: id(),
  /** Null when derived only from shared features; otherwise scoped. */
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  tradeId: text("trade_id"),
  strategyKey: text("strategy_key").notNull(),
  regime: text("regime").notNull(),
  setup: text("setup").notNull(),
  expected: text("expected").notNull(),
  actual: text("actual").notNull(),
  lesson: text("lesson").notNull(),
  action: text("action").notNull(),
  tags: jsonb("tags").$type<Record<string, string>>().notNull().default({}),
  confidenceImpact: doublePrecision("confidence_impact").notNull().default(1),
  timesConfirmed: integer("times_confirmed").notNull().default(0),
  timesContradicted: integer("times_contradicted").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("trade_lessons_strategy_idx").on(t.strategyKey, t.regime)]);

/** Structured historical trade memory used for analog retrieval. */
export const tradeMemory = pgTable("trade_memory", {
  tradeId: text("trade_id").primaryKey(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  mode: text("mode").$type<"live" | "shadow">().notNull(),
  symbol: text("symbol").notNull(),
  sector: text("sector"),
  strategyKey: text("strategy_key").notNull(),
  regime: text("regime").notNull(),
  signals: jsonb("signals").$type<Record<string, number>>().notNull(),
  features: jsonb("features").$type<Record<string, number>>().notNull(),
  /** Normalised feature vector for similarity search. */
  vector: jsonb("vector").$type<number[]>().notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  exitPrice: doublePrecision("exit_price"),
  holdingDays: doublePrecision("holding_days"),
  positionPct: doublePrecision("position_pct").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  expectedEdge: doublePrecision("expected_edge").notNull(),
  predictedDownsidePct: doublePrecision("predicted_downside_pct").notNull(),
  actualReturnPct: doublePrecision("actual_return_pct"),
  maePct: doublePrecision("mae_pct"),
  mfePct: doublePrecision("mfe_pct"),
  slippageBps: doublePrecision("slippage_bps"),
  executionQuality: doublePrecision("execution_quality"),
  exitReason: text("exit_reason"),
  reviewClassification: text("review_classification"),
  lessons: jsonb("lessons").$type<string[]>().notNull().default([]),
  openedAt: ts("opened_at").notNull(),
  closedAt: ts("closed_at"),
  updatedAt: updatedAt(),
}, (t) => [index("trade_memory_strategy_idx").on(t.strategyKey, t.regime), index("trade_memory_symbol_idx").on(t.symbol)]);

export const strategyIntelligenceProfiles = pgTable("strategy_intelligence_profiles", {
  id: id(),
  strategyId: text("strategy_id").notNull(),
  strategyKey: text("strategy_key").notNull(),
  /** Null = system-wide. */
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  mode: text("mode").notNull(),
  profile: jsonb("profile").notNull(),
  updatedAt: updatedAt(),
}, (t) => [index("sip_strategy_idx").on(t.strategyId, t.userId, t.brokerAccountId, t.mode)]);

export const signalIntelligenceProfiles = pgTable("signal_intelligence_profiles", {
  signalKey: text("signal_key").primaryKey(),
  profile: jsonb("profile").notNull(),
  updatedAt: updatedAt(),
});

export const modelIntelligenceProfiles = pgTable("model_intelligence_profiles", {
  id: id(),
  modelName: text("model_name").notNull(),
  modelVersion: text("model_version").notNull(),
  profile: jsonb("profile").notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("mip_uq").on(t.modelName, t.modelVersion)]);

export const agentIntelligenceProfiles = pgTable("agent_intelligence_profiles", {
  agentName: text("agent_name").primaryKey(),
  profile: jsonb("profile").notNull(),
  updatedAt: updatedAt(),
});

export const confidenceCalibration = pgTable("confidence_calibration", {
  key: text("key").primaryKey(), // "system" | strategy key | model | agent
  profile: jsonb("profile").notNull(),
  /** Multiplier applied to raw confidence, bounded by safe adaptation. */
  adjustment: doublePrecision("adjustment").notNull().default(1),
  updatedAt: updatedAt(),
});

export const adaptationProposals = pgTable("adaptation_proposals", {
  id: id(),
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  target: text("target").notNull(),
  key: text("key").notNull(),
  currentValue: doublePrecision("current_value").notNull(),
  proposedValue: doublePrecision("proposed_value").notNull(),
  bounds: jsonb("bounds").notNull(),
  evidence: text("evidence").notNull(),
  autoApplicable: boolean("auto_applicable").notNull(),
  requiresValidationPipeline: boolean("requires_validation_pipeline").notNull(),
  status: text("status").notNull().default("proposed"), // proposed | applied | rejected | expired
  appliedAt: ts("applied_at"),
  createdAt: createdAt(),
}, (t) => [index("adaptation_proposals_time_idx").on(t.createdAt)]);

/** Daily digest of what the system learned, for the Learning dashboard. */
export const learningDigests = pgTable("learning_digests", {
  id: id(),
  period: text("period").notNull(), // day | week
  periodStart: ts("period_start").notNull(),
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  digest: jsonb("digest").notNull(),
  createdAt: createdAt(),
}, (t) => [index("learning_digests_idx").on(t.period, t.periodStart)]);

export const backtests = pgTable("backtests", {
  id: id(),
  strategyKey: text("strategy_key").notNull(),
  strategyVersionId: text("strategy_version_id"),
  kind: text("kind").notNull(),
  config: jsonb("config").notNull(),
  metrics: jsonb("metrics").notNull(),
  equityCurve: jsonb("equity_curve").notNull(),
  trades: jsonb("trades").notNull(),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  dataFingerprint: text("data_fingerprint").notNull(),
  requestedBy: text("requested_by").notNull(),
  durationMs: doublePrecision("duration_ms").notNull(),
  ranAt: ts("ran_at").notNull().defaultNow(),
}, (t) => [index("backtests_strategy_idx").on(t.strategyKey, t.ranAt)]);

export const experiments = pgTable("experiments", {
  id: id(),
  title: text("title").notNull(),
  hypothesis: text("hypothesis").notNull(),
  kind: text("kind").notNull(), // strategy_proposal | ablation | sensitivity | regime | overfitting | mistake_analysis
  status: text("status").notNull().default("proposed"),
  proposedBy: text("proposed_by").notNull(),
  design: jsonb("design").notNull(),
  results: jsonb("results"),
  conclusion: text("conclusion"),
  recommendation: text("recommendation"),
  linkedStrategyId: text("linked_strategy_id"),
  linkedBacktestIds: jsonb("linked_backtest_ids").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
