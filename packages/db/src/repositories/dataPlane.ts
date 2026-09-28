import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { TenantScope } from "@yz/core";
import {
  candidates, candidateEvaluations, economicEvents, features, healthChecks, marketBars, marketRegimes, orders, portfolioSnapshots,
  postTradeReviews, strategies, tradeLessons, trades, userStrategySettings,
} from "../schema/index.js";
import { newId, Repository } from "./base.js";
import { scoped } from "../scope.js";

export type StrategyRow = typeof strategies.$inferSelect;
export type UserStrategySettingsRow = typeof userStrategySettings.$inferSelect;
export type CandidateRow = typeof candidates.$inferSelect;
export type PostTradeReviewRow = typeof postTradeReviews.$inferSelect;
export type TradeLessonRow = typeof tradeLessons.$inferSelect;
export type EconomicEventRow = typeof economicEvents.$inferSelect;

/**
 * Read-mostly queries used by the API data plane (market pipeline, dashboards). Shared tables
 * (candidates, strategies, features, regimes, economic events) carry no tenant columns; every
 * tenant table here is read through `scoped()` exactly like the other repositories.
 */
export class DataPlaneRepository extends Repository {
  // ---- shared: candidates / strategies -------------------------------------------------

  /** Distinct symbols of candidates in the given statuses (shared research universe input). */
  async candidateSymbols(statuses: string[] = ["candidate", "analyzing"]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.selectDistinct({ symbol: candidates.symbol }).from(candidates).where(inArray(candidates.status, statuses));
    return rows.map((r) => r.symbol);
  }
  async candidatesByIds(ids: string[]): Promise<CandidateRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(candidates).where(inArray(candidates.id, ids));
  }
  async allStrategies(): Promise<StrategyRow[]> {
    return this.db.select().from(strategies);
  }
  async strategiesByIds(ids: string[]): Promise<StrategyRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(strategies).where(inArray(strategies.id, ids));
  }
  /** Union of per-user allowed symbols across all strategy settings (symbols only; no tenant data). */
  async allowedSymbolsUnion(): Promise<string[]> {
    const rows = await this.db.select({ allowed: userStrategySettings.allowedSymbols }).from(userStrategySettings).where(eq(userStrategySettings.enabled, true));
    const out = new Set<string>();
    for (const r of rows) for (const s of r.allowed ?? []) out.add(s.toUpperCase());
    return [...out];
  }

  // ---- scoped: strategy settings / evaluations / reviews / lessons ---------------------

  async userStrategySettings(scope: TenantScope): Promise<UserStrategySettingsRow[]> {
    return this.db.select().from(userStrategySettings).where(scoped(userStrategySettings, scope));
  }
  async candidateEvaluations(scope: TenantScope, limit = 200) {
    return this.db.select().from(candidateEvaluations).where(scoped(candidateEvaluations, scope)).orderBy(desc(candidateEvaluations.createdAt)).limit(limit);
  }
  async postTradeReview(scope: TenantScope, tradeId: string): Promise<PostTradeReviewRow | undefined> {
    return (await this.db.select().from(postTradeReviews).where(scoped(postTradeReviews, scope, eq(postTradeReviews.tradeId, tradeId))).limit(1))[0];
  }
  async postTradeReviewsFor(scope: TenantScope, tradeIds: string[]): Promise<PostTradeReviewRow[]> {
    if (tradeIds.length === 0) return [];
    return this.db.select().from(postTradeReviews).where(scoped(postTradeReviews, scope, inArray(postTradeReviews.tradeId, tradeIds)));
  }
  async tradeLessons(scope: TenantScope, tradeId: string): Promise<TradeLessonRow[]> {
    return this.db.select().from(tradeLessons).where(and(eq(tradeLessons.userId, scope.userId), eq(tradeLessons.brokerAccountId, scope.brokerAccountId), eq(tradeLessons.tradeId, tradeId))).orderBy(desc(tradeLessons.createdAt));
  }
  async tradeLessonsFor(scope: TenantScope, tradeIds: string[]): Promise<TradeLessonRow[]> {
    if (tradeIds.length === 0) return [];
    return this.db.select().from(tradeLessons).where(and(eq(tradeLessons.userId, scope.userId), eq(tradeLessons.brokerAccountId, scope.brokerAccountId), inArray(tradeLessons.tradeId, tradeIds))).orderBy(desc(tradeLessons.createdAt));
  }

  // ---- scoped: orders / snapshots / trades windows --------------------------------------

  async ordersSince(scope: TenantScope, sinceIso: string, limit = 500) {
    return this.db.select().from(orders).where(scoped(orders, scope, gte(orders.createdAt, sinceIso))).orderBy(desc(orders.createdAt)).limit(limit);
  }
  async snapshotsSince(scope: TenantScope, sinceIso: string | null, limit = 5000) {
    const extra = sinceIso ? gte(portfolioSnapshots.asOf, sinceIso) : undefined;
    const rows = await this.db.select().from(portfolioSnapshots).where(scoped(portfolioSnapshots, scope, extra)).orderBy(desc(portfolioSnapshots.asOf)).limit(limit);
    return rows.reverse();
  }
  async closedTradesSince(scope: TenantScope, sinceIso: string | null, limit = 1000) {
    const conds = [eq(trades.state, "closed")];
    if (sinceIso) conds.push(gte(trades.closedAt, sinceIso));
    return this.db.select().from(trades).where(scoped(trades, scope, and(...conds))).orderBy(desc(trades.closedAt)).limit(limit);
  }

  // ---- shared: market -------------------------------------------------------------------

  /** Latest feature row per symbol for a feature version. */
  async latestFeaturesFor(symbols: string[], featureVersion: string) {
    if (symbols.length === 0) return [];
    const rows = await this.db.select().from(features).where(and(inArray(features.symbol, symbols), eq(features.featureVersion, featureVersion))).orderBy(desc(features.asOf)).limit(symbols.length * 3);
    const seen = new Map<string, typeof rows[number]>();
    for (const r of rows) if (!seen.has(r.symbol)) seen.set(r.symbol, r);
    return [...seen.values()];
  }
  /** Latest bar time per symbol for an interval (bar freshness). */
  async latestBarTimes(symbols: string[], interval: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (symbols.length === 0) return out;
    const rows = await this.db.select({ symbol: marketBars.symbol, t: sql<string>`max(${marketBars.time})` }).from(marketBars).where(and(inArray(marketBars.symbol, symbols), eq(marketBars.interval, interval))).groupBy(marketBars.symbol);
    for (const r of rows) if (r.t) out.set(r.symbol, r.t);
    return out;
  }
  async regimesResolved(limit = 500) {
    return this.db.select().from(marketRegimes).where(sql`${marketRegimes.forwardReturn5d} is not null`).orderBy(desc(marketRegimes.asOf)).limit(limit);
  }
  async economicEventsBetween(fromIso: string, toIso: string): Promise<EconomicEventRow[]> {
    return this.db.select().from(economicEvents).where(and(gte(economicEvents.scheduledAt, fromIso), lte(economicEvents.scheduledAt, toIso))).orderBy(economicEvents.scheduledAt);
  }
  async upsertEconomicEvent(row: Omit<typeof economicEvents.$inferInsert, "id">): Promise<void> {
    const existing = (await this.db.select().from(economicEvents).where(and(eq(economicEvents.name, row.name), eq(economicEvents.scheduledAt, row.scheduledAt))).limit(1))[0];
    if (existing) await this.db.update(economicEvents).set(row).where(eq(economicEvents.id, existing.id));
    else await this.db.insert(economicEvents).values({ ...row, id: newId() });
  }
  async healthCheck(name: string) {
    return (await this.db.select().from(healthChecks).where(eq(healthChecks.name, name)).limit(1))[0];
  }
}
