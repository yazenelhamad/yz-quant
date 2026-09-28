import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { TenantScope, TradeLifecycleState } from "@yz/core";
import { TRADE_TRANSITIONS } from "@yz/core";
import { approvalRequests, executionOutcomes, fills, orders, positions, portfolioSnapshots, rejectedTrades, riskDecisions, tradeEvents, trades, tradeTheses, candidateEvaluations, reconciliations } from "../schema/index.js";
import { newId, nowIso, Repository } from "./base.js";
import { scoped, stamp, verifyRowScope } from "../scope.js";

export type OrderRow = typeof orders.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
}

export class OrdersRepository extends Repository {
  async create(scope: TenantScope, input: Omit<typeof orders.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt" | "updatedAt"> & { id?: string }): Promise<OrderRow> {
    const id = input.id ?? newId();
    await this.db.insert(orders).values(stamp(scope, { ...input, id }));
    return (await this.byId(scope, id))!;
  }
  async byId(scope: TenantScope, id: string): Promise<OrderRow | undefined> {
    const row = (await this.db.select().from(orders).where(scoped(orders, scope, eq(orders.id, id))).limit(1))[0];
    return verifyRowScope(scope, row, "orders.byId");
  }
  async byRefId(scope: TenantScope, refId: string): Promise<OrderRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(orders).where(scoped(orders, scope, eq(orders.refId, refId))).limit(1))[0], "orders.byRefId");
  }
  async byBrokerOrderId(scope: TenantScope, brokerOrderId: string): Promise<OrderRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(orders).where(scoped(orders, scope, eq(orders.brokerOrderId, brokerOrderId))).limit(1))[0], "orders.byBrokerOrderId");
  }
  async update(scope: TenantScope, id: string, patch: Partial<typeof orders.$inferInsert>): Promise<void> {
    delete (patch as { userId?: string }).userId;
    delete (patch as { brokerAccountId?: string }).brokerAccountId;
    await this.db.update(orders).set({ ...patch, updatedAt: nowIso() }).where(scoped(orders, scope, eq(orders.id, id)));
  }
  async open(scope: TenantScope): Promise<OrderRow[]> {
    return this.db.select().from(orders).where(scoped(orders, scope, inArray(orders.state, ["new", "queued", "unconfirmed", "confirmed", "partially_filled", "pending_cancelled", "locating"]))).orderBy(desc(orders.createdAt));
  }
  async recent(scope: TenantScope, limit = 100): Promise<OrderRow[]> {
    return this.db.select().from(orders).where(scoped(orders, scope)).orderBy(desc(orders.createdAt)).limit(limit);
  }
  async forTrade(scope: TenantScope, tradeId: string): Promise<OrderRow[]> {
    return this.db.select().from(orders).where(scoped(orders, scope, eq(orders.tradeId, tradeId))).orderBy(desc(orders.createdAt));
  }
}

export class FillsRepository extends Repository {
  async record(scope: TenantScope, input: Omit<typeof fills.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt">): Promise<void> {
    await this.db.insert(fills).values(stamp(scope, { ...input, id: newId() }));
  }
  async forOrder(scope: TenantScope, orderId: string) {
    return this.db.select().from(fills).where(scoped(fills, scope, eq(fills.orderId, orderId)));
  }
  async recent(scope: TenantScope, limit = 200) {
    return this.db.select().from(fills).where(scoped(fills, scope)).orderBy(desc(fills.at)).limit(limit);
  }
}

export class PositionsRepository extends Repository {
  async list(scope: TenantScope): Promise<PositionRow[]> {
    return this.db.select().from(positions).where(scoped(positions, scope));
  }
  async bySymbol(scope: TenantScope, symbol: string): Promise<PositionRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(positions).where(scoped(positions, scope, eq(positions.symbol, symbol))).limit(1))[0], "positions.bySymbol");
  }
  /** Replace the account's position set with the broker's view (Robinhood is the source of truth). */
  async replaceAll(scope: TenantScope, rows: Omit<typeof positions.$inferInsert, "id" | "userId" | "brokerAccountId" | "updatedAt">[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await tx.select().from(positions).where(scoped(positions, scope));
      const bySymbol = new Map(existing.map((p) => [`${p.symbol}:${p.assetClass}`, p]));
      const keep = new Set<string>();
      for (const r of rows) {
        const key = `${r.symbol}:${r.assetClass ?? "equity"}`;
        keep.add(key);
        const prev = bySymbol.get(key);
        if (prev) {
          await tx.update(positions).set({ ...r, tradeId: r.tradeId ?? prev.tradeId, strategyId: r.strategyId ?? prev.strategyId, updatedAt: nowIso() }).where(scoped(positions, scope, eq(positions.id, prev.id)));
        } else {
          await tx.insert(positions).values(stamp(scope, { ...r, id: newId() }));
        }
      }
      for (const [key, p] of bySymbol) {
        if (!keep.has(key)) await tx.delete(positions).where(scoped(positions, scope, eq(positions.id, p.id)));
      }
    });
  }
  async attachTrade(scope: TenantScope, symbol: string, tradeId: string | null, strategyId: string | null): Promise<void> {
    await this.db.update(positions).set({ tradeId, strategyId, updatedAt: nowIso() }).where(scoped(positions, scope, eq(positions.symbol, symbol)));
  }
}

export class PortfolioSnapshotsRepository extends Repository {
  async record(scope: TenantScope, input: Omit<typeof portfolioSnapshots.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt">): Promise<void> {
    await this.db.insert(portfolioSnapshots).values(stamp(scope, { ...input, id: newId() }));
  }
  async latest(scope: TenantScope) {
    return verifyRowScope(scope, (await this.db.select().from(portfolioSnapshots).where(scoped(portfolioSnapshots, scope)).orderBy(desc(portfolioSnapshots.asOf)).limit(1))[0], "snapshots.latest");
  }
  async history(scope: TenantScope, limit = 500) {
    return this.db.select().from(portfolioSnapshots).where(scoped(portfolioSnapshots, scope)).orderBy(desc(portfolioSnapshots.asOf)).limit(limit);
  }
  /** Earliest snapshot at or after a given time (for daily/weekly P&L baselines). */
  async firstSince(scope: TenantScope, sinceIso: string) {
    return (await this.db.select().from(portfolioSnapshots).where(scoped(portfolioSnapshots, scope, sql`${portfolioSnapshots.asOf} >= ${sinceIso}`)).orderBy(portfolioSnapshots.asOf).limit(1))[0];
  }
  async peak(scope: TenantScope): Promise<number | null> {
    const r = (await this.db.select({ m: sql<number>`max(${portfolioSnapshots.totalValue})` }).from(portfolioSnapshots).where(scoped(portfolioSnapshots, scope)))[0];
    return r?.m == null ? null : Number(r.m);
  }
}

export class TradesRepository extends Repository {
  async create(scope: TenantScope, input: Omit<typeof trades.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt" | "updatedAt"> & { id?: string }): Promise<TradeRow> {
    const id = input.id ?? newId();
    await this.db.insert(trades).values(stamp(scope, { ...input, id }));
    await this.db.insert(tradeEvents).values(stamp(scope, { id: newId(), tradeId: id, fromState: null, toState: input.state ?? "candidate", reason: "created" }));
    return (await this.byId(scope, id))!;
  }
  async byId(scope: TenantScope, id: string): Promise<TradeRow | undefined> {
    return verifyRowScope(scope, (await this.db.select().from(trades).where(scoped(trades, scope, eq(trades.id, id))).limit(1))[0], "trades.byId");
  }
  async list(scope: TenantScope, opts: { states?: TradeLifecycleState[]; mode?: "live" | "shadow"; limit?: number } = {}): Promise<TradeRow[]> {
    const conds = [];
    if (opts.states?.length) conds.push(inArray(trades.state, opts.states));
    if (opts.mode) conds.push(eq(trades.mode, opts.mode));
    const extra = conds.length ? and(...conds) : undefined;
    return this.db.select().from(trades).where(scoped(trades, scope, extra)).orderBy(desc(trades.createdAt)).limit(opts.limit ?? 200);
  }
  async openForSymbol(scope: TenantScope, symbol: string, mode: "live" | "shadow"): Promise<TradeRow | undefined> {
    const openStates: TradeLifecycleState[] = ["approved", "waiting_for_entry", "order_submitted", "partially_filled", "filled", "monitoring", "reduce", "exit_requested"];
    return (await this.db.select().from(trades).where(scoped(trades, scope, and(eq(trades.symbol, symbol), eq(trades.mode, mode), inArray(trades.state, openStates)))).limit(1))[0];
  }
  async update(scope: TenantScope, id: string, patch: Partial<typeof trades.$inferInsert>): Promise<void> {
    delete (patch as { userId?: string }).userId;
    delete (patch as { brokerAccountId?: string }).brokerAccountId;
    await this.db.update(trades).set({ ...patch, updatedAt: nowIso() }).where(scoped(trades, scope, eq(trades.id, id)));
  }
  /** Enforced lifecycle transition. Throws on illegal transitions. */
  async transition(scope: TenantScope, id: string, to: TradeLifecycleState, reason: string, detail?: Record<string, unknown>, patch?: Partial<typeof trades.$inferInsert>): Promise<TradeRow> {
    const current = await this.byId(scope, id);
    if (!current) throw new Error(`Trade ${id} not found in scope`);
    const from = current.state as TradeLifecycleState;
    if (from !== to && !TRADE_TRANSITIONS[from].includes(to)) {
      throw new InvalidTransitionError(`Illegal trade transition ${from} -> ${to} for trade ${id}`);
    }
    await this.db.update(trades).set({ ...(patch ?? {}), state: to, updatedAt: nowIso() }).where(scoped(trades, scope, eq(trades.id, id)));
    await this.db.insert(tradeEvents).values(stamp(scope, { id: newId(), tradeId: id, fromState: from, toState: to, reason, detail: detail ?? null }));
    return (await this.byId(scope, id))!;
  }
  async events(scope: TenantScope, tradeId: string) {
    return this.db.select().from(tradeEvents).where(scoped(tradeEvents, scope, eq(tradeEvents.tradeId, tradeId))).orderBy(tradeEvents.at);
  }
}

export class ThesesRepository extends Repository {
  async create(scope: TenantScope, input: Omit<typeof tradeTheses.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt" | "updatedAt"> & { id?: string }) {
    const id = input.id ?? newId();
    await this.db.insert(tradeTheses).values(stamp(scope, { ...input, id }));
    return id;
  }
  async byId(scope: TenantScope, id: string) {
    return verifyRowScope(scope, (await this.db.select().from(tradeTheses).where(scoped(tradeTheses, scope, eq(tradeTheses.id, id))).limit(1))[0], "theses.byId");
  }
  async forTrade(scope: TenantScope, tradeId: string) {
    return this.db.select().from(tradeTheses).where(scoped(tradeTheses, scope, eq(tradeTheses.tradeId, tradeId))).orderBy(desc(tradeTheses.createdAt));
  }
  async forSymbol(scope: TenantScope, symbol: string, limit = 10) {
    return this.db.select().from(tradeTheses).where(scoped(tradeTheses, scope, eq(tradeTheses.symbol, symbol))).orderBy(desc(tradeTheses.createdAt)).limit(limit);
  }
  async update(scope: TenantScope, id: string, patch: Partial<typeof tradeTheses.$inferInsert>) {
    delete (patch as { userId?: string }).userId;
    delete (patch as { brokerAccountId?: string }).brokerAccountId;
    await this.db.update(tradeTheses).set({ ...patch, updatedAt: nowIso() }).where(scoped(tradeTheses, scope, eq(tradeTheses.id, id)));
  }
  async recent(scope: TenantScope, limit = 50) {
    return this.db.select().from(tradeTheses).where(scoped(tradeTheses, scope)).orderBy(desc(tradeTheses.createdAt)).limit(limit);
  }
}

export class RiskDecisionsRepository extends Repository {
  async record(scope: TenantScope, input: Omit<typeof riskDecisions.$inferInsert, "userId" | "brokerAccountId">) {
    await this.db.insert(riskDecisions).values(stamp(scope, input));
  }
  async recent(scope: TenantScope, limit = 100) {
    return this.db.select().from(riskDecisions).where(scoped(riskDecisions, scope)).orderBy(desc(riskDecisions.decidedAt)).limit(limit);
  }
}

export class RejectedTradesRepository extends Repository {
  async record(scope: TenantScope, input: Omit<typeof rejectedTrades.$inferInsert, "id" | "userId" | "brokerAccountId"> & { id?: string }) {
    const id = input.id ?? newId();
    await this.db.insert(rejectedTrades).values(stamp(scope, { ...input, id }));
    return id;
  }
  async recent(scope: TenantScope, limit = 100) {
    return this.db.select().from(rejectedTrades).where(scoped(rejectedTrades, scope)).orderBy(desc(rejectedTrades.rejectedAt)).limit(limit);
  }
  async unreviewedOlderThan(scope: TenantScope, beforeIso: string, limit = 100) {
    return this.db.select().from(rejectedTrades).where(scoped(rejectedTrades, scope, and(sql`${rejectedTrades.reviewedAt} is null`, sql`${rejectedTrades.rejectedAt} <= ${beforeIso}`))).limit(limit);
  }
  async review(scope: TenantScope, id: string, patch: { subsequentReturnPct: Record<string, number>; reviewVerdict: string }) {
    await this.db.update(rejectedTrades).set({ ...patch, reviewedAt: nowIso() }).where(scoped(rejectedTrades, scope, eq(rejectedTrades.id, id)));
  }
}

export class ApprovalRequestsRepository extends Repository {
  async create(scope: TenantScope, input: Omit<typeof approvalRequests.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt">) {
    const id = newId();
    await this.db.insert(approvalRequests).values(stamp(scope, { ...input, id }));
    return id;
  }
  async pending(scope: TenantScope) {
    return this.db.select().from(approvalRequests).where(scoped(approvalRequests, scope, eq(approvalRequests.status, "pending"))).orderBy(desc(approvalRequests.createdAt));
  }
  async byId(scope: TenantScope, id: string) {
    return verifyRowScope(scope, (await this.db.select().from(approvalRequests).where(scoped(approvalRequests, scope, eq(approvalRequests.id, id))).limit(1))[0], "approvals.byId");
  }
  async decide(scope: TenantScope, id: string, status: "approved" | "declined" | "expired", decidedBy: string | null) {
    await this.db.update(approvalRequests).set({ status, decidedBy, decidedAt: nowIso() }).where(scoped(approvalRequests, scope, eq(approvalRequests.id, id)));
  }
}

export class ExecutionOutcomesRepository extends Repository {
  async record(scope: TenantScope, input: Omit<typeof executionOutcomes.$inferInsert, "id" | "userId" | "brokerAccountId">) {
    await this.db.insert(executionOutcomes).values(stamp(scope, { ...input, id: newId() }));
  }
  async recent(scope: TenantScope, limit = 200) {
    return this.db.select().from(executionOutcomes).where(scoped(executionOutcomes, scope)).orderBy(desc(executionOutcomes.at)).limit(limit);
  }
}

export class CandidateEvaluationsRepository extends Repository {
  async upsert(scope: TenantScope, input: Omit<typeof candidateEvaluations.$inferInsert, "id" | "userId" | "brokerAccountId" | "createdAt">) {
    const existing = (await this.db.select().from(candidateEvaluations).where(scoped(candidateEvaluations, scope, eq(candidateEvaluations.candidateId, input.candidateId))).limit(1))[0];
    if (existing) {
      await this.db.update(candidateEvaluations).set(input).where(scoped(candidateEvaluations, scope, eq(candidateEvaluations.id, existing.id)));
      return existing.id;
    }
    const id = newId();
    await this.db.insert(candidateEvaluations).values(stamp(scope, { ...input, id }));
    return id;
  }
  async recent(scope: TenantScope, limit = 100) {
    return this.db.select().from(candidateEvaluations).where(scoped(candidateEvaluations, scope)).orderBy(desc(candidateEvaluations.createdAt)).limit(limit);
  }
}

export class ReconciliationsRepository extends Repository {
  async record(scope: TenantScope, input: Omit<typeof reconciliations.$inferInsert, "id" | "userId" | "brokerAccountId">) {
    await this.db.insert(reconciliations).values(stamp(scope, { ...input, id: newId() }));
  }
  async latest(scope: TenantScope) {
    return (await this.db.select().from(reconciliations).where(scoped(reconciliations, scope)).orderBy(desc(reconciliations.at)).limit(1))[0];
  }
}
