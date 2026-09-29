import { boolean, doublePrecision, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_common.js";

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  at: ts("at").notNull().defaultNow(),
  category: text("category").notNull(),
  action: text("action").notNull(),
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  actorUserId: text("actor_user_id"),
  strategyId: text("strategy_id"),
  strategyVersionId: text("strategy_version_id"),
  modelName: text("model_name"),
  modelVersion: text("model_version"),
  promptVersion: text("prompt_version"),
  tradeId: text("trade_id"),
  orderId: text("order_id"),
  result: text("result").notNull(),
  detail: jsonb("detail").notNull().default({}),
  error: text("error"),
  ip: text("ip"),
  sessionId: text("session_id"),
}, (t) => [index("audit_logs_time_idx").on(t.at), index("audit_logs_user_idx").on(t.userId, t.at), index("audit_logs_category_idx").on(t.category, t.at)]);

export const systemEvents = pgTable("system_events", {
  id: id(),
  at: ts("at").notNull().defaultNow(),
  component: text("component").notNull(),
  level: text("level").notNull(), // info | warning | error | critical
  message: text("message").notNull(),
  detail: jsonb("detail"),
}, (t) => [index("system_events_time_idx").on(t.at)]);

export const alerts = pgTable("alerts", {
  id: id(),
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  severity: text("severity").notNull(), // info | warning | critical
  kind: text("kind").notNull(), // risk | execution | data | broker | learning | system
  title: text("title").notNull(),
  message: text("message").notNull(),
  acknowledged: boolean("acknowledged").notNull().default(false),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: ts("acknowledged_at"),
  createdAt: createdAt(),
}, (t) => [index("alerts_scope_idx").on(t.userId, t.brokerAccountId, t.createdAt)]);

export const healthChecks = pgTable("health_checks", {
  name: text("name").primaryKey(),
  status: text("status").notNull(),
  detail: text("detail").notNull().default(""),
  metrics: jsonb("metrics"),
  checkedAt: ts("checked_at").notNull().defaultNow(),
});

/** Single-row global risk state (id = "global"). */
export const globalRiskState = pgTable("global_risk_state", {
  id: text("id").primaryKey(),
  liveExecutionDisabled: boolean("live_execution_disabled").notNull().default(false),
  forceShadowMode: boolean("force_shadow_mode").notNull().default(false),
  pausedUsers: jsonb("paused_users").$type<string[]>().notNull().default([]),
  disabledStrategyIds: jsonb("disabled_strategy_ids").$type<string[]>().notNull().default([]),
  killSwitchActive: boolean("kill_switch_active").notNull().default(false),
  killSwitchReasons: jsonb("kill_switch_reasons").$type<string[]>().notNull().default([]),
  killSwitchNote: text("kill_switch_note"),
  killSwitchTriggeredAt: ts("kill_switch_triggered_at"),
  killSwitchTriggeredBy: text("kill_switch_triggered_by"),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});

export const killSwitches = pgTable("kill_switches", {
  id: id(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  active: boolean("active").notNull().default(false),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  allowRiskReducingExits: boolean("allow_risk_reducing_exits").notNull().default(true),
  triggeredAt: ts("triggered_at"),
  triggeredBy: text("triggered_by"),
  note: text("note"),
  releasedAt: ts("released_at"),
  releasedBy: text("released_by"),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("kill_switches_scope_uq").on(t.userId, t.brokerAccountId)]);

export const modelRegistry = pgTable("model_registry", {
  id: id(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  provider: text("provider").notNull(),
  role: text("role").notNull(), // slow_brain | research | fast | statistical | ml
  enabled: boolean("enabled").notNull().default(true),
  routingWeight: doublePrecision("routing_weight").notNull().default(1),
  costPerMTokIn: doublePrecision("cost_per_mtok_in"),
  costPerMTokOut: doublePrecision("cost_per_mtok_out"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("model_registry_uq").on(t.name, t.version)]);

export const agentRegistry = pgTable("agent_registry", {
  name: text("name").primaryKey(),
  description: text("description").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  influenceWeight: doublePrecision("influence_weight").notNull().default(1),
  promptVersion: text("prompt_version").notNull(),
  modelRole: text("model_role").notNull(),
  updatedAt: updatedAt(),
});

export const modelOutputs = pgTable("model_outputs", {
  id: id(),
  agentName: text("agent_name").notNull(),
  modelName: text("model_name").notNull(),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  symbol: text("symbol"),
  candidateId: text("candidate_id"),
  thesisId: text("thesis_id"),
  input: jsonb("input"),
  output: jsonb("output"),
  valid: boolean("valid").notNull(),
  validationError: text("validation_error"),
  latencyMs: doublePrecision("latency_ms"),
  inputTokens: doublePrecision("input_tokens"),
  outputTokens: doublePrecision("output_tokens"),
  costUsd: doublePrecision("cost_usd"),
  createdAt: createdAt(),
}, (t) => [index("model_outputs_time_idx").on(t.createdAt), index("model_outputs_agent_idx").on(t.agentName, t.createdAt)]);

export const jobRuns = pgTable("job_runs", {
  id: id(),
  name: text("name").notNull(),
  userId: text("user_id"),
  brokerAccountId: text("broker_account_id"),
  status: text("status").notNull(), // running | ok | error | skipped
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  detail: jsonb("detail"),
  error: text("error"),
}, (t) => [index("job_runs_name_idx").on(t.name, t.startedAt)]);

/** Platform-level secrets set from the admin console (e.g. an AI provider key), sealed with the SecretBox. */
export const appSecrets = pgTable("app_secrets", {
  name: text("name").primaryKey(),
  envelope: text("envelope").notNull(),
  /** Last four characters, so an admin can tell which key is set without seeing it. */
  hint: text("hint").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});
