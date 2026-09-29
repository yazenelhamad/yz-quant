import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { TenantScope } from "@yz/core";
import type { Database } from "@yz/db";
import {
  approvalRequests, candidateEvaluations, candidates, confidenceCalibration, modelOutputs, signalIntelligenceProfiles, strategies, strategyIntelligenceProfiles,
  strategyVersions, tradeMemory, trades, userStrategySettings, scoped, stamp, verifyRowScope,
} from "@yz/db";

export type StrategyRecord = typeof strategies.$inferSelect;
export type StrategyVersionRecord = typeof strategyVersions.$inferSelect;
export type UserStrategySettingsRecord = typeof userStrategySettings.$inferSelect;
export type CandidateRecord = typeof candidates.$inferSelect;
export type CandidateEvaluationRecord = typeof candidateEvaluations.$inferSelect;
export type TradeMemoryRecord = typeof tradeMemory.$inferSelect;
export type SignalProfileRecord = typeof signalIntelligenceProfiles.$inferSelect;
export type CalibrationRecord = typeof confidenceCalibration.$inferSelect;
export type StrategyProfileRecord = typeof strategyIntelligenceProfiles.$inferSelect;

const newId = (): string => crypto.randomUUID();
const nowIso = (): string => new Date().toISOString();

/**
 * Queries the trading cycle needs on tables that have no repository in `Repos` (strategies,
 * candidates, learning profiles, model outputs). Shared tables carry no tenant columns; every
 * tenant table is read/written through `scoped()` / `stamp()` exactly like the repositories in
 * `@yz/db`. This store lives inside the trading service so it never collides with repositories the
 * pipeline or learning services add to the shared package.
 */
export class TradingStore {
  constructor(private readonly db: Database) {}

  // ---- strategies (shared) ---------------------------------------------------------------

  async strategies(): Promise<StrategyRecord[]> {
    return this.db.select().from(strategies);
  }
  async strategyByKey(key: string): Promise<StrategyRecord | undefined> {
    return (await this.db.select().from(strategies).where(eq(strategies.key, key)).limit(1))[0];
  }
  async strategyById(id: string): Promise<StrategyRecord | undefined> {
    return (await this.db.select().from(strategies).where(eq(strategies.id, id)).limit(1))[0];
  }
  async insertStrategy(row: typeof strategies.$inferInsert): Promise<void> {
    await this.db.insert(strategies).values(row).onConflictDoNothing({ target: strategies.key });
  }
  async updateStrategy(id: string, patch: Partial<typeof strategies.$inferInsert>): Promise<void> {
    await this.db.update(strategies).set({ ...patch, updatedAt: nowIso() }).where(eq(strategies.id, id));
  }
  async insertStrategyVersion(row: typeof strategyVersions.$inferInsert): Promise<void> {
    await this.db.insert(strategyVersions).values(row).onConflictDoNothing({ target: [strategyVersions.strategyId, strategyVersions.version] });
  }
  async strategyVersion(id: string): Promise<StrategyVersionRecord | undefined> {
    return (await this.db.select().from(strategyVersions).where(eq(strategyVersions.id, id)).limit(1))[0];
  }
  async strategyVersionsFor(strategyId: string): Promise<StrategyVersionRecord[]> {
    return this.db.select().from(strategyVersions).where(eq(strategyVersions.strategyId, strategyId)).orderBy(desc(strategyVersions.createdAt));
  }

  // ---- user strategy settings (tenant) ----------------------------------------------------

  async userStrategySettings(scope: TenantScope): Promise<UserStrategySettingsRecord[]> {
    return this.db.select().from(userStrategySettings).where(scoped(userStrategySettings, scope));
  }
  async userStrategySetting(scope: TenantScope, strategyId: string): Promise<UserStrategySettingsRecord | undefined> {
    const row = (await this.db.select().from(userStrategySettings).where(scoped(userStrategySettings, scope, eq(userStrategySettings.strategyId, strategyId))).limit(1))[0];
    return verifyRowScope(scope, row, "userStrategySettings");
  }
  async upsertUserStrategySetting(scope: TenantScope, strategyId: string, patch: Partial<Omit<typeof userStrategySettings.$inferInsert, "id" | "userId" | "brokerAccountId" | "strategyId">>): Promise<void> {
    const existing = await this.userStrategySetting(scope, strategyId);
    if (existing) {
      await this.db.update(userStrategySettings).set({ ...patch, updatedAt: nowIso() }).where(scoped(userStrategySettings, scope, eq(userStrategySettings.id, existing.id)));
    } else {
      await this.db.insert(userStrategySettings).values(stamp(scope, { ...patch, id: newId(), strategyId }));
    }
  }
  /**
   * Strategy ids enabled by at least one user. Only the strategy id and the enabled flag leave the
   * tenant table: the shared candidate generator needs to know which strategies to run, never whose.
   */
  async strategyIdsEnabledByAnyUser(): Promise<Set<string>> {
    const rows = await this.db.selectDistinct({ strategyId: userStrategySettings.strategyId }).from(userStrategySettings).where(eq(userStrategySettings.enabled, true));
    return new Set(rows.map((r) => r.strategyId));
  }

  // ---- candidates (shared) --------------------------------------------------------------

  async insertCandidate(row: Omit<typeof candidates.$inferInsert, "id"> & { id?: string }): Promise<CandidateRecord> {
    const id = row.id ?? newId();
    await this.db.insert(candidates).values({ ...row, id });
    return (await this.candidateById(id))!;
  }
  async candidateById(id: string): Promise<CandidateRecord | undefined> {
    return (await this.db.select().from(candidates).where(eq(candidates.id, id)).limit(1))[0];
  }
  /** Unexpired candidates in status `candidate` (or `analyzing`), newest first. */
  async freshCandidates(nowIso: string, limit = 500): Promise<CandidateRecord[]> {
    return this.db.select().from(candidates)
      .where(and(inArray(candidates.status, ["candidate", "analyzing"]), gt(candidates.expiresAt, nowIso)))
      .orderBy(desc(candidates.createdAt)).limit(limit);
  }
  async recentCandidates(limit = 200): Promise<CandidateRecord[]> {
    return this.db.select().from(candidates).orderBy(desc(candidates.createdAt)).limit(limit);
  }
  async expireCandidates(nowIso: string): Promise<number> {
    const rows = await this.db.update(candidates).set({ status: "expired" })
      .where(and(inArray(candidates.status, ["candidate", "analyzing"]), lte(candidates.expiresAt, nowIso))).returning();
    return rows.length;
  }
  /** Expire every fresh candidate of the given strategies (intraday candidates at the close). */
  async expireCandidatesForStrategies(strategyKeys: string[]): Promise<number> {
    if (strategyKeys.length === 0) return 0;
    const rows = await this.db.update(candidates).set({ status: "expired" })
      .where(and(inArray(candidates.status, ["candidate", "analyzing"]), inArray(candidates.strategyKey, strategyKeys))).returning();
    return rows.length;
  }
  async updateCandidateStatus(id: string, status: string): Promise<void> {
    await this.db.update(candidates).set({ status }).where(eq(candidates.id, id));
  }

  // ---- candidate evaluations (tenant) -------------------------------------------------------

  async evaluationForCandidate(scope: TenantScope, candidateId: string): Promise<CandidateEvaluationRecord | undefined> {
    const row = (await this.db.select().from(candidateEvaluations).where(scoped(candidateEvaluations, scope, eq(candidateEvaluations.candidateId, candidateId))).limit(1))[0];
    return verifyRowScope(scope, row, "candidateEvaluations");
  }
  async evaluationsForCandidates(scope: TenantScope, candidateIds: string[]): Promise<CandidateEvaluationRecord[]> {
    if (candidateIds.length === 0) return [];
    return this.db.select().from(candidateEvaluations).where(scoped(candidateEvaluations, scope, inArray(candidateEvaluations.candidateId, candidateIds)));
  }

  // ---- approvals (tenant) --------------------------------------------------------------------

  async approvalsRecent(scope: TenantScope, limit = 100) {
    return this.db.select().from(approvalRequests).where(scoped(approvalRequests, scope)).orderBy(desc(approvalRequests.createdAt)).limit(limit);
  }

  // ---- trades (tenant) ---------------------------------------------------------------------

  async tradeForCandidate(scope: TenantScope, candidateId: string) {
    const row = (await this.db.select().from(trades).where(scoped(trades, scope, eq(trades.candidateId, candidateId))).orderBy(desc(trades.createdAt)).limit(1))[0];
    return verifyRowScope(scope, row, "trades.forCandidate");
  }

  // ---- learning profiles (shared; read-only for the trading cycle) ----------------------------

  /**
   * Closed trades from every user's live and shadow memory. Analog retrieval is evidence only:
   * rows are read, scored and summarised, never written and never exposed with their scope.
   */
  async closedTradeMemory(limit = 5000): Promise<TradeMemoryRecord[]> {
    return this.db.select().from(tradeMemory).where(sql`${tradeMemory.actualReturnPct} is not null`).orderBy(desc(tradeMemory.closedAt)).limit(limit);
  }
  async signalProfiles(): Promise<SignalProfileRecord[]> {
    return this.db.select().from(signalIntelligenceProfiles);
  }
  async calibration(key: string): Promise<CalibrationRecord | undefined> {
    return (await this.db.select().from(confidenceCalibration).where(eq(confidenceCalibration.key, key)).limit(1))[0];
  }
  /** System-wide (user_id IS NULL) strategy profile for a strategy key; prefers mode "all", then "live", then "shadow". */
  async systemStrategyProfile(strategyKey: string): Promise<StrategyProfileRecord | undefined> {
    const rows = await this.db.select().from(strategyIntelligenceProfiles)
      .where(and(eq(strategyIntelligenceProfiles.strategyKey, strategyKey), sql`${strategyIntelligenceProfiles.userId} is null`));
    const order = ["all", "live", "shadow", "backtest"];
    return rows.sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode))[0];
  }

  // ---- model outputs (audit of LLM enrichment) ---------------------------------------------------

  async recordModelOutput(row: Omit<typeof modelOutputs.$inferInsert, "id">): Promise<void> {
    await this.db.insert(modelOutputs).values({ ...row, id: newId() });
  }
}
