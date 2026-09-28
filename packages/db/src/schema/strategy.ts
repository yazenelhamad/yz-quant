import { boolean, doublePrecision, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, tenantColumns, ts, updatedAt } from "./_common.js";

export const strategies = pgTable("strategies", {
  id: id(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  family: text("family").notNull(),
  description: text("description").notNull().default(""),
  /** "shared" or a user id. */
  visibility: text("visibility").notNull().default("shared"),
  supportedRegimes: jsonb("supported_regimes").$type<string[]>().notNull().default([]),
  stage: text("stage").notNull().default("research"),
  currentVersionId: text("current_version_id"),
  /** Admin can disable a strategy globally regardless of user settings. */
  globallyDisabled: boolean("globally_disabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("strategies_key_uq").on(t.key)]);

export const strategyVersions = pgTable("strategy_versions", {
  id: id(),
  strategyId: text("strategy_id").notNull(),
  version: text("version").notNull(),
  parameters: jsonb("parameters").$type<Record<string, number | string | boolean>>().notNull(),
  changeSummary: text("change_summary").notNull(),
  changeReason: text("change_reason").notNull(),
  proposedByKind: text("proposed_by_kind").notNull(),
  proposedById: text("proposed_by_id").notNull(),
  backtestResultId: text("backtest_result_id"),
  outOfSampleResultId: text("out_of_sample_result_id"),
  walkForwardResultId: text("walk_forward_result_id"),
  shadowResultSummary: jsonb("shadow_result_summary").$type<Record<string, number>>(),
  approvalStatus: text("approval_status").notNull().default("proposed"),
  approvedBy: text("approved_by"),
  deployedAt: ts("deployed_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("strategy_versions_uq").on(t.strategyId, t.version)]);

export const strategyStageTransitions = pgTable("strategy_stage_transitions", {
  id: id(),
  strategyId: text("strategy_id").notNull(),
  /** Null = global stage change; otherwise a per-user stage change. */
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  fromStage: text("from_stage").notNull(),
  toStage: text("to_stage").notNull(),
  reason: text("reason").notNull(),
  evidence: jsonb("evidence"),
  decidedBy: text("decided_by").notNull(),
  at: ts("at").notNull().defaultNow(),
});

export const userStrategySettings = pgTable("user_strategy_settings", {
  id: id(),
  ...tenantColumns(),
  strategyId: text("strategy_id").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  stage: text("stage").notNull().default("research"),
  capitalAllocation: doublePrecision("capital_allocation").notNull().default(0),
  maxPositionPct: doublePrecision("max_position_pct").notNull().default(0.05),
  maxLossPerTradePct: doublePrecision("max_loss_per_trade_pct").notNull().default(0.01),
  allowedSymbols: jsonb("allowed_symbols").$type<string[] | null>(),
  blockedSymbols: jsonb("blocked_symbols").$type<string[]>().notNull().default([]),
  optionsAllowed: boolean("options_allowed").notNull().default(false),
  minConfidence: doublePrecision("min_confidence"),
  minExpectedEdge: doublePrecision("min_expected_edge"),
  /** Learned bounded overrides (signal weights etc.) applied only within this scope. */
  adaptiveOverrides: jsonb("adaptive_overrides").$type<Record<string, number>>().notNull().default({}),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("user_strategy_settings_uq").on(t.userId, t.brokerAccountId, t.strategyId)]);

export const predictions = pgTable("predictions", {
  id: id(),
  modelName: text("model_name").notNull(),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version"),
  featureVersion: text("feature_version"),
  symbol: text("symbol").notNull(),
  kind: text("kind").notNull(), // direction | return | regime | fill | ...
  horizonDays: doublePrecision("horizon_days"),
  predicted: jsonb("predicted").notNull(),
  confidence: doublePrecision("confidence"),
  asOf: ts("as_of").notNull(),
  realized: jsonb("realized"),
  correct: boolean("correct"),
  resolvedAt: ts("resolved_at"),
  latencyMs: doublePrecision("latency_ms"),
  costUsd: doublePrecision("cost_usd"),
  createdAt: createdAt(),
}, (t) => [index("predictions_model_time_idx").on(t.modelName, t.asOf), index("predictions_symbol_idx").on(t.symbol, t.asOf)]);

export const candidates = pgTable("candidates", {
  id: id(),
  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  strategyKey: text("strategy_key").notNull(),
  strategyVersionId: text("strategy_version_id"),
  direction: text("direction").notNull(),
  ensemble: jsonb("ensemble").notNull(),
  expectedUpsidePct: doublePrecision("expected_upside_pct").notNull(),
  expectedDownsidePct: doublePrecision("expected_downside_pct").notNull(),
  holdingPeriodDays: doublePrecision("holding_period_days").notNull(),
  catalyst: text("catalyst"),
  catalystAt: ts("catalyst_at"),
  liquidityScore: doublePrecision("liquidity_score").notNull(),
  regimeFit: doublePrecision("regime_fit").notNull(),
  historicalSimilarity: jsonb("historical_similarity"),
  status: text("status").notNull().default("candidate"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("candidates_time_idx").on(t.createdAt), index("candidates_symbol_idx").on(t.symbol)]);

/** Per-user evaluation of a shared candidate (portfolio fit is user-specific). */
export const candidateEvaluations = pgTable("candidate_evaluations", {
  id: id(),
  ...tenantColumns(),
  candidateId: text("candidate_id").notNull(),
  portfolioFit: doublePrecision("portfolio_fit").notNull(),
  sizeMultiplier: doublePrecision("size_multiplier").notNull(),
  proposedQuantity: doublePrecision("proposed_quantity").notNull(),
  fastBrain: jsonb("fast_brain"),
  riskDecisionId: text("risk_decision_id"),
  finalStatus: text("final_status").notNull(), // approved | rejected | waiting | shadow | needs_approval
  detail: jsonb("detail"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("candidate_evaluations_uq").on(t.userId, t.brokerAccountId, t.candidateId)]);
