import { doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_common.js";

export const consensusSnapshots = pgTable("consensus_snapshots", {
  id: id(),
  ticker: text("ticker").notNull(),
  asOf: ts("as_of").notNull(),
  model: jsonb("model").notNull(), // ConsensusModel
  createdAt: createdAt(),
}, (t) => [index("consensus_snapshots_idx").on(t.ticker, t.asOf)]);

export const internalForecasts = pgTable("internal_forecasts", {
  id: id(),
  ticker: text("ticker").notNull(),
  asOf: ts("as_of").notNull(),
  forecast: jsonb("forecast").notNull(),
  modelName: text("model_name").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: createdAt(),
}, (t) => [index("internal_forecasts_idx").on(t.ticker, t.asOf)]);

export const variantViews = pgTable("variant_views", {
  id: id(),
  ticker: text("ticker").notNull(),
  asOf: ts("as_of").notNull(),
  score: doublePrecision("score").notNull(),
  recommendedAction: text("recommended_action").notNull(),
  view: jsonb("view").notNull(), // VariantView
  /** Evaluated later. */
  outcomeReturnPct: doublePrecision("outcome_return_pct"),
  outcomeCorrect: text("outcome_correct"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
}, (t) => [index("variant_views_idx").on(t.ticker, t.asOf)]);

export const catalysts = pgTable("catalysts", {
  id: id(),
  ticker: text("ticker").notNull(),
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  expectedDate: ts("expected_date"),
  probability: doublePrecision("probability").notNull(),
  potentialImpactPct: doublePrecision("potential_impact_pct").notNull(),
  consensusExpectsIt: text("consensus_expects_it").notNull().default("unknown"),
  pricedInScore: doublePrecision("priced_in_score").notNull(),
  reactionSpeed: text("reaction_speed").notNull(),
  status: text("status").notNull().default("upcoming"), // upcoming | occurred | cancelled
  outcome: jsonb("outcome"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("catalysts_ticker_idx").on(t.ticker, t.expectedDate)]);

export const expectationsRecords = pgTable("expectations_records", {
  id: id(),
  ticker: text("ticker").notNull(),
  catalyst: text("catalyst").notNull(),
  eventAt: ts("event_at").notNull(),
  consensus: jsonb("consensus").notNull(),
  narrative: text("narrative").notNull(),
  optionsImpliedMovePct: doublePrecision("options_implied_move_pct"),
  priceBefore: doublePrecision("price_before").notNull(),
  systemForecast: jsonb("system_forecast").notNull(),
  systemConfidence: doublePrecision("system_confidence").notNull(),
  actualResult: jsonb("actual_result"),
  priceAfter: doublePrecision("price_after"),
  reactionPct: doublePrecision("reaction_pct"),
  recordedAt: ts("recorded_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
}, (t) => [index("expectations_records_idx").on(t.ticker, t.eventAt)]);

export const analystRevisions = pgTable("analyst_revisions", {
  id: id(),
  ticker: text("ticker").notNull(),
  asOf: ts("as_of").notNull(),
  epsUp: integer("eps_up").notNull().default(0),
  epsDown: integer("eps_down").notNull().default(0),
  revenueUp: integer("revenue_up").notNull().default(0),
  revenueDown: integer("revenue_down").notNull().default(0),
  ratingUpgrades: integer("rating_upgrades").notNull().default(0),
  ratingDowngrades: integer("rating_downgrades").notNull().default(0),
  priceTargetMean: doublePrecision("price_target_mean"),
  priceTargetChangePct: doublePrecision("price_target_change_pct"),
  epsMean: doublePrecision("eps_mean"),
  epsStdDev: doublePrecision("eps_std_dev"),
  epsLow: doublePrecision("eps_low"),
  epsHigh: doublePrecision("eps_high"),
  analystCount: integer("analyst_count"),
  source: text("source").notNull(),
  createdAt: createdAt(),
}, (t) => [index("analyst_revisions_idx").on(t.ticker, t.asOf)]);

export const companyProfiles = pgTable("company_profiles", {
  ticker: text("ticker").primaryKey(),
  profile: jsonb("profile").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

export const companyProfileHistory = pgTable("company_profile_history", {
  id: id(),
  ticker: text("ticker").notNull(),
  version: integer("version").notNull(),
  profile: jsonb("profile").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("company_profile_history_uq").on(t.ticker, t.version)]);
