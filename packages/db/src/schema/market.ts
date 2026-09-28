import { boolean, doublePrecision, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_common.js";

/** Shared (non-tenant) instrument reference data. */
export const instruments = pgTable("instruments", {
  symbol: text("symbol").primaryKey(),
  name: text("name"),
  sector: text("sector"),
  industry: text("industry"),
  assetClass: text("asset_class").notNull().default("equity"),
  state: text("state").notNull().default("unknown"),
  tradeable: boolean("tradeable"),
  fractional: boolean("fractional"),
  marketCap: doublePrecision("market_cap"),
  avgDollarVolume20: doublePrecision("avg_dollar_volume_20"),
  beta: doublePrecision("beta"),
  delistedAt: ts("delisted_at"),
  meta: jsonb("meta"),
  updatedAt: updatedAt(),
});

export const marketQuotes = pgTable("market_quotes", {
  id: id(),
  symbol: text("symbol").notNull(),
  last: doublePrecision("last").notNull(),
  bid: doublePrecision("bid"),
  ask: doublePrecision("ask"),
  previousClose: doublePrecision("previous_close"),
  lastTradeAt: ts("last_trade_at"),
  session: text("session").notNull().default("unknown"),
  instrumentState: text("instrument_state").notNull().default("unknown"),
  source: text("source").notNull(),
  observedAt: ts("observed_at").notNull(),
  receivedAt: ts("received_at").notNull(),
  reliability: doublePrecision("reliability").notNull().default(1),
}, (t) => [index("market_quotes_symbol_time_idx").on(t.symbol, t.receivedAt)]);

export const marketBars = pgTable("market_bars", {
  id: id(),
  symbol: text("symbol").notNull(),
  interval: text("interval").notNull(),
  time: ts("time").notNull(),
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: doublePrecision("volume").notNull(),
  interpolated: boolean("interpolated").notNull().default(false),
  adjusted: text("adjusted").notNull().default("split"),
  source: text("source").notNull(),
  receivedAt: ts("received_at").notNull(),
}, (t) => [uniqueIndex("market_bars_uq").on(t.symbol, t.interval, t.time, t.adjusted)]);

export const features = pgTable("features", {
  id: id(),
  symbol: text("symbol").notNull(),
  asOf: ts("as_of").notNull(),
  featureVersion: text("feature_version").notNull(),
  values: jsonb("values").$type<Record<string, number | null>>().notNull(),
  freshness: text("freshness").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("features_uq").on(t.symbol, t.asOf, t.featureVersion)]);

export const signals = pgTable("signals", {
  id: id(),
  key: text("key").notNull(),
  strategyKey: text("strategy_key").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  value: doublePrecision("value").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  horizonDays: doublePrecision("horizon_days").notNull(),
  asOf: ts("as_of").notNull(),
  featureVersion: text("feature_version").notNull(),
  inputFreshness: text("input_freshness").notNull(),
  explanation: text("explanation").notNull().default(""),
  /** Filled by the learning engine once the horizon elapses. */
  realizedReturnPct: doublePrecision("realized_return_pct"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
}, (t) => [index("signals_key_time_idx").on(t.key, t.asOf), index("signals_symbol_time_idx").on(t.symbol, t.asOf)]);

export const marketRegimes = pgTable("market_regimes", {
  id: id(),
  asOf: ts("as_of").notNull(),
  primary: text("primary").notNull(),
  probabilities: jsonb("probabilities").$type<Record<string, number>>().notNull(),
  confidence: doublePrecision("confidence").notNull(),
  abnormality: doublePrecision("abnormality").notNull(),
  metrics: jsonb("metrics").notNull(),
  familyBias: jsonb("family_bias").$type<Record<string, number>>().notNull(),
  explanation: jsonb("explanation").$type<string[]>().notNull(),
  dataQuality: text("data_quality").notNull(),
  engineVersion: text("engine_version").notNull(),
  /** Evaluated later: forward SPY return and realized vol for usefulness scoring. */
  forwardReturn5d: doublePrecision("forward_return_5d"),
  forwardVol5d: doublePrecision("forward_vol_5d"),
  createdAt: createdAt(),
}, (t) => [index("market_regimes_time_idx").on(t.asOf)]);

export const newsEvents = pgTable("news_events", {
  id: id(),
  contentHash: text("content_hash").notNull(),
  symbols: jsonb("symbols").$type<string[]>().notNull(),
  headline: text("headline").notNull(),
  summary: text("summary"),
  source: text("source").notNull(),
  sourceTier: doublePrecision("source_tier").notNull().default(7),
  publishedAt: ts("published_at").notNull(),
  receivedAt: ts("received_at").notNull(),
  url: text("url"),
  /** Structured interpretation by the news agent (data, not instructions). */
  interpretation: jsonb("interpretation"),
  genuinelyNew: boolean("genuinely_new"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("news_events_hash_uq").on(t.contentHash), index("news_events_time_idx").on(t.publishedAt)]);

export const economicEvents = pgTable("economic_events", {
  id: id(),
  name: text("name").notNull(),
  scheduledAt: ts("scheduled_at").notNull(),
  importance: text("importance").notNull().default("medium"),
  consensus: text("consensus"),
  actual: text("actual"),
  source: text("source").notNull(),
  createdAt: createdAt(),
}, (t) => [index("economic_events_time_idx").on(t.scheduledAt)]);

export const earningsEvents = pgTable("earnings_events", {
  id: id(),
  symbol: text("symbol").notNull(),
  reportAt: ts("report_at").notNull(),
  timing: text("timing"), // bmo | amc | unknown
  epsEstimate: doublePrecision("eps_estimate"),
  epsActual: doublePrecision("eps_actual"),
  revenueEstimate: doublePrecision("revenue_estimate"),
  revenueActual: doublePrecision("revenue_actual"),
  source: text("source").notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("earnings_events_uq").on(t.symbol, t.reportAt)]);
