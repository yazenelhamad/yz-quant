import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { TenantScope } from "@yz/core";
import {
  adaptationProposals, agentIntelligenceProfiles, agentRegistry, analystRevisions, backtests, candidates, catalysts, companyProfileHistory, companyProfiles,
  confidenceCalibration, consensusSnapshots, executionOutcomes, expectationsRecords, experiments, features, fills, learningDigests, marketRegimes,
  modelIntelligenceProfiles, modelOutputs, modelRegistry, orders, postTradeReviews, predictions, signalIntelligenceProfiles, signals, strategies,
  strategyIntelligenceProfiles, strategyStageTransitions, strategyVersions, tradeLessons, tradeMemory, trades, userStrategySettings, variantViews,
} from "../schema/index.js";
import { newId, nowIso, Repository } from "./base.js";
import { scoped, stamp, verifyRowScope } from "../scope.js";

export type LearningReviewRow = typeof postTradeReviews.$inferSelect;
export type LearningLessonRow = typeof tradeLessons.$inferSelect;
export type TradeMemoryRow = typeof tradeMemory.$inferSelect;
export type StrategyProfileRow = typeof strategyIntelligenceProfiles.$inferSelect;
export type AdaptationProposalRow = typeof adaptationProposals.$inferSelect;
export type LearningDigestRow = typeof learningDigests.$inferSelect;
export type BacktestRow = typeof backtests.$inferSelect;
export type ExperimentRow = typeof experiments.$inferSelect;
export type StrategyCatalogRow = typeof strategies.$inferSelect;
export type StrategyVersionRow = typeof strategyVersions.$inferSelect;
export type StrategyStageTransitionRow = typeof strategyStageTransitions.$inferSelect;
export type StrategySettingsRow = typeof userStrategySettings.$inferSelect;
export type ModelRegistryRow = typeof modelRegistry.$inferSelect;
export type AgentRegistryRow = typeof agentRegistry.$inferSelect;
export type ModelOutputRow = typeof modelOutputs.$inferSelect;
export type PredictionRow = typeof predictions.$inferSelect;
export type CalibrationRow = typeof confidenceCalibration.$inferSelect;
export type LearningCandidateRow = typeof candidates.$inferSelect;

/** Optional scope filter: `null` = shared rows only (user_id IS NULL), undefined = everything. */
function optionalScope(t: { userId: typeof tradeLessons.userId; brokerAccountId: typeof tradeLessons.brokerAccountId }, scope: TenantScope | null | undefined) {
  if (scope === undefined) return undefined;
  if (scope === null) return isNull(t.userId);
  return scoped(t as never, scope);
}

// -------------------------------------------------------------------------------------------
// Post-trade reviews, lessons, memory (scoped writes; shared reads for statistics)
// -------------------------------------------------------------------------------------------

export class PostTradeReviewsRepository extends Repository {
  async upsert(scope: TenantScope, input: { tradeId: string; classification: string; review: unknown; reviewerVersion: string; reviewedAt: string }): Promise<string> {
    const existing = (await this.db.select().from(postTradeReviews).where(scoped(postTradeReviews, scope, eq(postTradeReviews.tradeId, input.tradeId))).limit(1))[0];
    if (existing) {
      await this.db.update(postTradeReviews).set({ classification: input.classification, review: input.review, reviewerVersion: input.reviewerVersion, reviewedAt: input.reviewedAt }).where(scoped(postTradeReviews, scope, eq(postTradeReviews.id, existing.id)));
      return existing.id;
    }
    const id = newId();
    await this.db.insert(postTradeReviews).values(stamp(scope, { ...input, id }));
    return id;
  }
  async forTrade(scope: TenantScope, tradeId: string): Promise<LearningReviewRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(postTradeReviews).where(scoped(postTradeReviews, scope, eq(postTradeReviews.tradeId, tradeId))).limit(1))[0], "reviews.forTrade");
  }
  async recent(scope: TenantScope, limit = 200): Promise<LearningReviewRow[]> {
    return this.db.select().from(postTradeReviews).where(scoped(postTradeReviews, scope)).orderBy(desc(postTradeReviews.reviewedAt)).limit(limit);
  }
  /** Shared read across both users (statistics only; rows carry their scope). */
  async recentAll(limit = 500, sinceIso?: string): Promise<LearningReviewRow[]> {
    const q = this.db.select().from(postTradeReviews);
    const rows = sinceIso ? await q.where(gte(postTradeReviews.reviewedAt, sinceIso)).orderBy(desc(postTradeReviews.reviewedAt)).limit(limit) : await q.orderBy(desc(postTradeReviews.reviewedAt)).limit(limit);
    return rows;
  }
}

export class TradeLessonsRepository extends Repository {
  /** Insert or update by id (lesson ids are deterministic per trade + reviewer version). */
  async upsert(row: Omit<typeof tradeLessons.$inferInsert, "createdAt"> & { createdAt?: string }): Promise<void> {
    const existing = (await this.db.select().from(tradeLessons).where(eq(tradeLessons.id, row.id)).limit(1))[0];
    if (existing) {
      if ((existing.userId ?? null) !== (row.userId ?? null) || (existing.brokerAccountId ?? null) !== (row.brokerAccountId ?? null)) {
        throw new Error(`lesson ${row.id} belongs to a different scope`);
      }
      const { id: _id, createdAt: _c, ...patch } = row;
      await this.db.update(tradeLessons).set(patch).where(eq(tradeLessons.id, row.id));
    } else {
      await this.db.insert(tradeLessons).values(row);
    }
  }
  async forScope(scope: TenantScope, opts: { strategyKey?: string; limit?: number } = {}): Promise<LearningLessonRow[]> {
    const extra = opts.strategyKey ? eq(tradeLessons.strategyKey, opts.strategyKey) : undefined;
    return this.db.select().from(tradeLessons).where(scoped(tradeLessons as never, scope, extra)).orderBy(desc(tradeLessons.createdAt)).limit(opts.limit ?? 500);
  }
  async forTrade(scope: TenantScope, tradeId: string): Promise<LearningLessonRow[]> {
    return this.db.select().from(tradeLessons).where(scoped(tradeLessons as never, scope, eq(tradeLessons.tradeId, tradeId)));
  }
  /** Shared read (both scopes plus shared lessons). */
  async recentAll(limit = 500, sinceIso?: string): Promise<LearningLessonRow[]> {
    const q = this.db.select().from(tradeLessons);
    return sinceIso ? q.where(gte(tradeLessons.createdAt, sinceIso)).orderBy(desc(tradeLessons.createdAt)).limit(limit) : q.orderBy(desc(tradeLessons.createdAt)).limit(limit);
  }
}

export class TradeMemoryRepository extends Repository {
  async upsert(scope: TenantScope, row: Omit<typeof tradeMemory.$inferInsert, "userId" | "brokerAccountId" | "updatedAt">): Promise<void> {
    const stamped = stamp(scope, { ...row, updatedAt: nowIso() });
    const existing = (await this.db.select().from(tradeMemory).where(eq(tradeMemory.tradeId, row.tradeId)).limit(1))[0];
    if (existing) {
      verifyRowScope(scope, existing, "tradeMemory.upsert");
      await this.db.update(tradeMemory).set(stamped).where(scoped(tradeMemory, scope, eq(tradeMemory.tradeId, row.tradeId)));
    } else {
      await this.db.insert(tradeMemory).values(stamped);
    }
  }
  async forScope(scope: TenantScope, opts: { strategyKey?: string; limit?: number } = {}): Promise<TradeMemoryRow[]> {
    const extra = opts.strategyKey ? eq(tradeMemory.strategyKey, opts.strategyKey) : undefined;
    return this.db.select().from(tradeMemory).where(scoped(tradeMemory, scope, extra)).orderBy(desc(tradeMemory.openedAt)).limit(opts.limit ?? 5000);
  }
  async byTrade(scope: TenantScope, tradeId: string): Promise<TradeMemoryRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(tradeMemory).where(scoped(tradeMemory, scope, eq(tradeMemory.tradeId, tradeId))).limit(1))[0], "tradeMemory.byTrade");
  }
  /** Shared read over both users' shadow + live memory (statistics only; never mutated through this path). */
  async all(limit = 10_000): Promise<TradeMemoryRow[]> {
    return this.db.select().from(tradeMemory).orderBy(desc(tradeMemory.openedAt)).limit(limit);
  }
}

// -------------------------------------------------------------------------------------------
// Intelligence profiles and calibration
// -------------------------------------------------------------------------------------------

export class StrategyProfilesRepository extends Repository {
  async upsert(input: { strategyId: string; strategyKey: string; scope: TenantScope | null; mode: string; profile: unknown }): Promise<void> {
    const conds = [eq(strategyIntelligenceProfiles.strategyId, input.strategyId), eq(strategyIntelligenceProfiles.mode, input.mode)];
    conds.push(input.scope ? eq(strategyIntelligenceProfiles.userId, input.scope.userId) : isNull(strategyIntelligenceProfiles.userId));
    conds.push(input.scope ? eq(strategyIntelligenceProfiles.brokerAccountId, input.scope.brokerAccountId) : isNull(strategyIntelligenceProfiles.brokerAccountId));
    const existing = (await this.db.select().from(strategyIntelligenceProfiles).where(and(...conds)).limit(1))[0];
    if (existing) {
      await this.db.update(strategyIntelligenceProfiles).set({ profile: input.profile, strategyKey: input.strategyKey, updatedAt: nowIso() }).where(eq(strategyIntelligenceProfiles.id, existing.id));
    } else {
      await this.db.insert(strategyIntelligenceProfiles).values({ id: newId(), strategyId: input.strategyId, strategyKey: input.strategyKey, userId: input.scope?.userId ?? null, brokerAccountId: input.scope?.brokerAccountId ?? null, mode: input.mode, profile: input.profile });
    }
  }
  async get(strategyId: string, scope: TenantScope | null, mode: string): Promise<StrategyProfileRow | undefined> {
    const conds = [eq(strategyIntelligenceProfiles.strategyId, strategyId), eq(strategyIntelligenceProfiles.mode, mode), scope ? eq(strategyIntelligenceProfiles.userId, scope.userId) : isNull(strategyIntelligenceProfiles.userId), scope ? eq(strategyIntelligenceProfiles.brokerAccountId, scope.brokerAccountId) : isNull(strategyIntelligenceProfiles.brokerAccountId)];
    return (await this.db.select().from(strategyIntelligenceProfiles).where(and(...conds)).limit(1))[0];
  }
  async shared(): Promise<StrategyProfileRow[]> {
    return this.db.select().from(strategyIntelligenceProfiles).where(isNull(strategyIntelligenceProfiles.userId));
  }
  async forScope(scope: TenantScope): Promise<StrategyProfileRow[]> {
    return this.db.select().from(strategyIntelligenceProfiles).where(scoped(strategyIntelligenceProfiles as never, scope));
  }
  async all(): Promise<StrategyProfileRow[]> {
    return this.db.select().from(strategyIntelligenceProfiles);
  }
}

export class SignalProfilesRepository extends Repository {
  async upsert(signalKey: string, profile: unknown): Promise<void> {
    await this.db.insert(signalIntelligenceProfiles).values({ signalKey, profile }).onConflictDoUpdate({ target: signalIntelligenceProfiles.signalKey, set: { profile, updatedAt: nowIso() } });
  }
  async all() { return this.db.select().from(signalIntelligenceProfiles); }
}

export class ModelProfilesRepository extends Repository {
  async upsert(modelName: string, modelVersion: string, profile: unknown): Promise<void> {
    await this.db.insert(modelIntelligenceProfiles).values({ id: newId(), modelName, modelVersion, profile }).onConflictDoUpdate({ target: [modelIntelligenceProfiles.modelName, modelIntelligenceProfiles.modelVersion], set: { profile, updatedAt: nowIso() } });
  }
  async all() { return this.db.select().from(modelIntelligenceProfiles); }
}

export class AgentProfilesRepository extends Repository {
  async upsert(agentName: string, profile: unknown): Promise<void> {
    await this.db.insert(agentIntelligenceProfiles).values({ agentName, profile }).onConflictDoUpdate({ target: agentIntelligenceProfiles.agentName, set: { profile, updatedAt: nowIso() } });
  }
  async all() { return this.db.select().from(agentIntelligenceProfiles); }
}

export class CalibrationRepository extends Repository {
  async get(key: string): Promise<CalibrationRow | undefined> {
    return (await this.db.select().from(confidenceCalibration).where(eq(confidenceCalibration.key, key)).limit(1))[0];
  }
  async all(): Promise<CalibrationRow[]> { return this.db.select().from(confidenceCalibration); }
  async upsertProfile(key: string, profile: unknown): Promise<void> {
    await this.db.insert(confidenceCalibration).values({ key, profile, adjustment: 1 }).onConflictDoUpdate({ target: confidenceCalibration.key, set: { profile, updatedAt: nowIso() } });
  }
  async setAdjustment(key: string, adjustment: number): Promise<void> {
    await this.db.update(confidenceCalibration).set({ adjustment, updatedAt: nowIso() }).where(eq(confidenceCalibration.key, key));
  }
}

export class AdaptationProposalsRepository extends Repository {
  async create(scope: TenantScope | null, input: { target: string; key: string; currentValue: number; proposedValue: number; bounds: unknown; evidence: string; autoApplicable: boolean; requiresValidationPipeline: boolean; createdAt?: string }): Promise<string> {
    const id = newId();
    await this.db.insert(adaptationProposals).values({ id, userId: scope?.userId ?? null, brokerAccountId: scope?.brokerAccountId ?? null, ...input });
    return id;
  }
  async byId(id: string): Promise<AdaptationProposalRow | undefined> {
    return (await this.db.select().from(adaptationProposals).where(eq(adaptationProposals.id, id)).limit(1))[0];
  }
  async setStatus(id: string, status: "proposed" | "applied" | "rejected" | "expired", appliedAt: string | null): Promise<void> {
    await this.db.update(adaptationProposals).set({ status, appliedAt }).where(eq(adaptationProposals.id, id));
  }
  /** scope: undefined = all rows, null = shared only, TenantScope = that scope only. */
  async recent(scope: TenantScope | null | undefined, limit = 200): Promise<AdaptationProposalRow[]> {
    const cond = optionalScope(adaptationProposals as never, scope);
    const q = this.db.select().from(adaptationProposals);
    return cond ? q.where(cond).orderBy(desc(adaptationProposals.createdAt)).limit(limit) : q.orderBy(desc(adaptationProposals.createdAt)).limit(limit);
  }
  async expireOlderThan(beforeIso: string): Promise<number> {
    const rows = await this.db.update(adaptationProposals).set({ status: "expired" }).where(and(eq(adaptationProposals.status, "proposed"), lte(adaptationProposals.createdAt, beforeIso))).returning();
    return rows.length;
  }
}

export class LearningDigestsRepository extends Repository {
  async create(period: string, periodStart: string, scope: TenantScope | null, digest: unknown): Promise<string> {
    const id = newId();
    await this.db.insert(learningDigests).values({ id, period, periodStart, userId: scope?.userId ?? null, brokerAccountId: scope?.brokerAccountId ?? null, digest });
    return id;
  }
  async latest(period: string, scope: TenantScope | null): Promise<LearningDigestRow | undefined> {
    const cond = optionalScope(learningDigests as never, scope);
    return (await this.db.select().from(learningDigests).where(and(eq(learningDigests.period, period), cond)).orderBy(desc(learningDigests.periodStart)).limit(1))[0];
  }
  async recent(scope: TenantScope | null | undefined, limit = 30): Promise<LearningDigestRow[]> {
    const cond = optionalScope(learningDigests as never, scope);
    const q = this.db.select().from(learningDigests);
    return cond ? q.where(cond).orderBy(desc(learningDigests.createdAt)).limit(limit) : q.orderBy(desc(learningDigests.createdAt)).limit(limit);
  }
}

// -------------------------------------------------------------------------------------------
// Learning inputs read from other tables (scoped where the table is tenant-scoped)
// -------------------------------------------------------------------------------------------

export class LearningInputsRepository extends Repository {
  async candidateById(id: string): Promise<LearningCandidateRow | undefined> {
    return (await this.db.select().from(candidates).where(eq(candidates.id, id)).limit(1))[0];
  }
  /** Latest features row for a symbol at or before `asOf`, any feature version. */
  async featuresAt(symbol: string, asOf: string) {
    return (await this.db.select().from(features).where(and(eq(features.symbol, symbol), lte(features.asOf, asOf))).orderBy(desc(features.asOf)).limit(1))[0];
  }
  async regimeAt(asOf: string) {
    return (await this.db.select().from(marketRegimes).where(lte(marketRegimes.asOf, asOf)).orderBy(desc(marketRegimes.asOf)).limit(1))[0];
  }
  async resolvedRegimes(limit = 1000) {
    return this.db.select().from(marketRegimes).where(sql`${marketRegimes.forwardReturn5d} is not null`).orderBy(desc(marketRegimes.asOf)).limit(limit);
  }
  async fillsForTrade(scope: TenantScope, tradeId: string) {
    return this.db.select().from(fills).where(scoped(fills, scope, eq(fills.tradeId, tradeId))).orderBy(fills.at);
  }
  async ordersForTrade(scope: TenantScope, tradeId: string) {
    return this.db.select().from(orders).where(scoped(orders, scope, eq(orders.tradeId, tradeId)));
  }
  async executionOutcomesForOrders(scope: TenantScope, orderIds: string[]) {
    if (orderIds.length === 0) return [];
    return this.db.select().from(executionOutcomes).where(scoped(executionOutcomes, scope, inArray(executionOutcomes.orderId, orderIds)));
  }
  async executionOutcomesForScope(scope: TenantScope, limit = 2000) {
    return this.db.select().from(executionOutcomes).where(scoped(executionOutcomes, scope)).orderBy(desc(executionOutcomes.at)).limit(limit);
  }
  async closedTrades(scope: TenantScope, limit = 2000) {
    return this.db.select().from(trades).where(scoped(trades, scope, eq(trades.state, "closed"))).orderBy(desc(trades.closedAt)).limit(limit);
  }
  /** Map signal key -> strategy key, from recorded signals. */
  async signalStrategyKeys(): Promise<Record<string, string>> {
    const rows = await this.db.selectDistinct({ key: signals.key, strategyKey: signals.strategyKey }).from(signals);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.strategyKey;
    return out;
  }
  async modelOutputsRecent(limit = 2000, sinceIso?: string): Promise<ModelOutputRow[]> {
    const q = this.db.select().from(modelOutputs);
    return sinceIso ? q.where(gte(modelOutputs.createdAt, sinceIso)).orderBy(desc(modelOutputs.createdAt)).limit(limit) : q.orderBy(desc(modelOutputs.createdAt)).limit(limit);
  }
  async resolvedPredictions(limit = 5000): Promise<PredictionRow[]> {
    return this.db.select().from(predictions).where(sql`${predictions.correct} is not null`).orderBy(desc(predictions.asOf)).limit(limit);
  }
}

// -------------------------------------------------------------------------------------------
// Strategy catalog: strategies, versions, stage transitions, per-user settings
// -------------------------------------------------------------------------------------------

export class StrategyCatalogRepository extends Repository {
  async list(): Promise<StrategyCatalogRow[]> { return this.db.select().from(strategies).orderBy(strategies.key); }
  async byId(id: string): Promise<StrategyCatalogRow | undefined> { return (await this.db.select().from(strategies).where(eq(strategies.id, id)).limit(1))[0]; }
  async byKey(key: string): Promise<StrategyCatalogRow | undefined> { return (await this.db.select().from(strategies).where(eq(strategies.key, key)).limit(1))[0]; }
  async insertIfMissing(row: Omit<typeof strategies.$inferInsert, "createdAt" | "updatedAt">): Promise<StrategyCatalogRow> {
    await this.db.insert(strategies).values(row).onConflictDoNothing({ target: strategies.key });
    return (await this.byKey(row.key))!;
  }
  async update(id: string, patch: Partial<typeof strategies.$inferInsert>): Promise<void> {
    await this.db.update(strategies).set({ ...patch, updatedAt: nowIso() }).where(eq(strategies.id, id));
  }
  async versions(strategyId: string): Promise<StrategyVersionRow[]> {
    return this.db.select().from(strategyVersions).where(eq(strategyVersions.strategyId, strategyId)).orderBy(desc(strategyVersions.createdAt));
  }
  async versionById(id: string): Promise<StrategyVersionRow | undefined> {
    return (await this.db.select().from(strategyVersions).where(eq(strategyVersions.id, id)).limit(1))[0];
  }
  async createVersion(row: Omit<typeof strategyVersions.$inferInsert, "createdAt">): Promise<StrategyVersionRow> {
    await this.db.insert(strategyVersions).values(row).onConflictDoNothing({ target: [strategyVersions.strategyId, strategyVersions.version] });
    return (await this.db.select().from(strategyVersions).where(and(eq(strategyVersions.strategyId, row.strategyId), eq(strategyVersions.version, row.version))).limit(1))[0]!;
  }
  async updateVersion(id: string, patch: Partial<typeof strategyVersions.$inferInsert>): Promise<void> {
    await this.db.update(strategyVersions).set(patch).where(eq(strategyVersions.id, id));
  }
  async recordTransition(row: Omit<typeof strategyStageTransitions.$inferInsert, "id" | "at"> & { at?: string }): Promise<string> {
    const id = newId();
    await this.db.insert(strategyStageTransitions).values({ ...row, id });
    return id;
  }
  async transitions(strategyId: string, limit = 100): Promise<StrategyStageTransitionRow[]> {
    return this.db.select().from(strategyStageTransitions).where(eq(strategyStageTransitions.strategyId, strategyId)).orderBy(desc(strategyStageTransitions.at)).limit(limit);
  }
  async recentTransitions(limit = 200): Promise<StrategyStageTransitionRow[]> {
    return this.db.select().from(strategyStageTransitions).orderBy(desc(strategyStageTransitions.at)).limit(limit);
  }
}

export class StrategySettingsRepository extends Repository {
  async get(scope: TenantScope, strategyId: string): Promise<StrategySettingsRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(userStrategySettings).where(scoped(userStrategySettings, scope, eq(userStrategySettings.strategyId, strategyId))).limit(1))[0], "strategySettings.get");
  }
  async listForScope(scope: TenantScope): Promise<StrategySettingsRow[]> {
    return this.db.select().from(userStrategySettings).where(scoped(userStrategySettings, scope));
  }
  async upsert(scope: TenantScope, strategyId: string, patch: Partial<Omit<typeof userStrategySettings.$inferInsert, "id" | "userId" | "brokerAccountId" | "strategyId">>): Promise<StrategySettingsRow> {
    const existing = await this.get(scope, strategyId);
    if (existing) {
      await this.db.update(userStrategySettings).set({ ...patch, updatedAt: nowIso() }).where(scoped(userStrategySettings, scope, eq(userStrategySettings.id, existing.id)));
    } else {
      await this.db.insert(userStrategySettings).values(stamp(scope, { id: newId(), strategyId, ...patch }));
    }
    return (await this.get(scope, strategyId))!;
  }
  /** Replace the learned overrides for one strategy inside this scope only. */
  async setAdaptiveOverrides(scope: TenantScope, strategyId: string, overrides: Record<string, number>): Promise<void> {
    const existing = await this.get(scope, strategyId);
    if (!existing) throw new Error(`no strategy settings for ${strategyId} in scope`);
    await this.db.update(userStrategySettings).set({ adaptiveOverrides: overrides, updatedAt: nowIso() }).where(scoped(userStrategySettings, scope, eq(userStrategySettings.id, existing.id)));
  }
}

// -------------------------------------------------------------------------------------------
// Research: backtests and experiments
// -------------------------------------------------------------------------------------------

export class BacktestsRepository extends Repository {
  async create(row: Omit<typeof backtests.$inferInsert, "id"> & { id?: string }): Promise<BacktestRow> {
    const id = row.id ?? newId();
    await this.db.insert(backtests).values({ ...row, id });
    return (await this.byId(id))!;
  }
  async byId(id: string): Promise<BacktestRow | undefined> { return (await this.db.select().from(backtests).where(eq(backtests.id, id)).limit(1))[0]; }
  async update(id: string, patch: Partial<typeof backtests.$inferInsert>): Promise<void> {
    await this.db.update(backtests).set(patch).where(eq(backtests.id, id));
  }
  async list(opts: { strategyKey?: string; limit?: number } = {}): Promise<BacktestRow[]> {
    const q = this.db.select().from(backtests);
    return opts.strategyKey ? q.where(eq(backtests.strategyKey, opts.strategyKey)).orderBy(desc(backtests.ranAt)).limit(opts.limit ?? 100) : q.orderBy(desc(backtests.ranAt)).limit(opts.limit ?? 100);
  }
}

export class ExperimentsRepository extends Repository {
  async create(row: Omit<typeof experiments.$inferInsert, "id" | "createdAt" | "updatedAt">): Promise<ExperimentRow> {
    const id = newId();
    await this.db.insert(experiments).values({ ...row, id });
    return (await this.byId(id))!;
  }
  async byId(id: string): Promise<ExperimentRow | undefined> { return (await this.db.select().from(experiments).where(eq(experiments.id, id)).limit(1))[0]; }
  async list(limit = 100): Promise<ExperimentRow[]> { return this.db.select().from(experiments).orderBy(desc(experiments.createdAt)).limit(limit); }
  async update(id: string, patch: Partial<typeof experiments.$inferInsert>): Promise<void> {
    await this.db.update(experiments).set({ ...patch, updatedAt: nowIso() }).where(eq(experiments.id, id));
  }
}

// -------------------------------------------------------------------------------------------
// Model / agent registries
// -------------------------------------------------------------------------------------------

export class ModelRegistryRepository extends Repository {
  async all(): Promise<ModelRegistryRow[]> { return this.db.select().from(modelRegistry).orderBy(modelRegistry.role); }
  async upsert(row: Omit<typeof modelRegistry.$inferInsert, "id" | "createdAt" | "updatedAt">): Promise<void> {
    await this.db.insert(modelRegistry).values({ ...row, id: newId() }).onConflictDoNothing({ target: [modelRegistry.name, modelRegistry.version] });
  }
  async update(name: string, patch: Partial<Pick<typeof modelRegistry.$inferInsert, "enabled" | "routingWeight">>): Promise<number> {
    const rows = await this.db.update(modelRegistry).set({ ...patch, updatedAt: nowIso() }).where(eq(modelRegistry.name, name)).returning();
    return rows.length;
  }
}

export class AgentRegistryRepository extends Repository {
  async all(): Promise<AgentRegistryRow[]> { return this.db.select().from(agentRegistry).orderBy(agentRegistry.name); }
  async upsert(row: typeof agentRegistry.$inferInsert): Promise<void> {
    await this.db.insert(agentRegistry).values(row).onConflictDoUpdate({ target: agentRegistry.name, set: { promptVersion: row.promptVersion, modelRole: row.modelRole, description: row.description, updatedAt: nowIso() } });
  }
  async update(name: string, patch: Partial<Pick<typeof agentRegistry.$inferInsert, "enabled" | "influenceWeight">>): Promise<number> {
    const rows = await this.db.update(agentRegistry).set({ ...patch, updatedAt: nowIso() }).where(eq(agentRegistry.name, name)).returning();
    return rows.length;
  }
}

// -------------------------------------------------------------------------------------------
// Variant perception storage (shared research data)
// -------------------------------------------------------------------------------------------

export class VariantRepository extends Repository {
  async latestView(ticker: string) { return (await this.db.select().from(variantViews).where(eq(variantViews.ticker, ticker)).orderBy(desc(variantViews.asOf)).limit(1))[0]; }
  async recordView(row: Omit<typeof variantViews.$inferInsert, "id">): Promise<string> { const id = newId(); await this.db.insert(variantViews).values({ ...row, id }); return id; }
  async latestConsensus(ticker: string) { return (await this.db.select().from(consensusSnapshots).where(eq(consensusSnapshots.ticker, ticker)).orderBy(desc(consensusSnapshots.asOf)).limit(1))[0]; }
  async recordConsensus(ticker: string, asOf: string, model: unknown): Promise<void> { await this.db.insert(consensusSnapshots).values({ id: newId(), ticker, asOf, model }); }
  async catalystsFor(ticker: string, limit = 50) { return this.db.select().from(catalysts).where(eq(catalysts.ticker, ticker)).orderBy(desc(catalysts.createdAt)).limit(limit); }
  async replaceUpcomingCatalysts(ticker: string, rows: Omit<typeof catalysts.$inferInsert, "id" | "ticker" | "createdAt" | "updatedAt">[]): Promise<void> {
    await this.db.delete(catalysts).where(and(eq(catalysts.ticker, ticker), eq(catalysts.status, "upcoming")));
    if (rows.length > 0) await this.db.insert(catalysts).values(rows.map((r) => ({ ...r, id: newId(), ticker })));
  }
  async expectationsFor(ticker: string, limit = 100) { return this.db.select().from(expectationsRecords).where(eq(expectationsRecords.ticker, ticker)).orderBy(desc(expectationsRecords.eventAt)).limit(limit); }
  async allExpectations(limit = 2000) { return this.db.select().from(expectationsRecords).orderBy(desc(expectationsRecords.eventAt)).limit(limit); }
  async latestRevisions(ticker: string, limit = 5) { return this.db.select().from(analystRevisions).where(eq(analystRevisions.ticker, ticker)).orderBy(desc(analystRevisions.asOf)).limit(limit); }
  async companyProfile(ticker: string) { return (await this.db.select().from(companyProfiles).where(eq(companyProfiles.ticker, ticker)).limit(1))[0]; }
  async saveCompanyProfile(ticker: string, profile: unknown, version: number): Promise<void> {
    await this.db.insert(companyProfiles).values({ ticker, profile, version }).onConflictDoUpdate({ target: companyProfiles.ticker, set: { profile, version, updatedAt: nowIso() } });
    await this.db.insert(companyProfileHistory).values({ id: newId(), ticker, version, profile }).onConflictDoNothing({ target: [companyProfileHistory.ticker, companyProfileHistory.version] });
  }
  async companyProfileHistory(ticker: string, limit = 20) { return this.db.select().from(companyProfileHistory).where(eq(companyProfileHistory.ticker, ticker)).orderBy(desc(companyProfileHistory.version)).limit(limit); }
}
