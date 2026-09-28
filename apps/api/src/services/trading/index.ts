import type { FastifyInstance } from "fastify";
import type { TenantScope, TradeThesis } from "@yz/core";
import { CrossTenantError, assertScope, marketSessionAt } from "@yz/core";
import type { TradeRow } from "@yz/db";
import type { AppContext } from "../../http/app.js";
import { service } from "../registry.js";
import type { Scheduler } from "../scheduler.js";
import { registerApprovalRoutes } from "../../routes/approvals.js";
import { registerDecisionRoutes } from "../../routes/decisions.js";
import { registerOpportunityRoutes } from "../../routes/opportunities.js";
import { registerPositionsCloseRoutes } from "../../routes/positionsClose.js";
import { registerRiskRoutes } from "../../routes/risk.js";
import { generateCandidates, type GenerateCandidatesSummary } from "./candidates.js";
import { candidateGeneration, tradingCycle, type CycleSummary } from "./cycle.js";
import { evaluateCandidateForAccount, loadAccountContext, type AccountContext } from "./evaluate.js";
import { tradingEvents } from "./events.js";
import { decideApproval, openTrade, requestApproval, submitExit, type ApprovalOutcome, type ExitResult, type OpenTradeResult, type SubmitExitArgs } from "./execute.js";
import { explainTrade, type ExplainDecisionInput, type ExplainTradeInput } from "./explain.js";
import { ordersMonitor, positionsManage, type OrdersMonitorSummary, type PositionsManageSummary } from "./monitor.js";
import { ShadowBooks } from "./shadow.js";
import { TradingStore, type CandidateRecord } from "./store.js";
import { ensureStrategyRows } from "./strategyRows.js";
import type { EvaluateOptions, EvaluationSnapshot, TradingDeps, TradingRuntime } from "./types.js";

export * from "./types.js";
export { tradingEvents, type TradingEventMap } from "./events.js";
export { TradingStore } from "./store.js";
export type { CandidateRecord, StrategyRecord, UserStrategySettingsRecord } from "./store.js";
export { ensureStrategyRows } from "./strategyRows.js";
export { ShadowBooks } from "./shadow.js";
export { generateCandidates } from "./candidates.js";
export { evaluateCandidateForAccount, loadAccountContext, loadSymbolContext, resolveMode } from "./evaluate.js";
export { openTrade, requestApproval, decideApproval, submitExit, submitOrder } from "./execute.js";
export { ordersMonitor, positionsManage, finalizeClose } from "./monitor.js";
export { tradingCycle, evaluateKillSwitch, dataQualityGate } from "./cycle.js";
export { buildThesis, loadValidThesis } from "./thesis.js";
export { explainTrade } from "./explain.js";
export type { CycleSummary, OrdersMonitorSummary, PositionsManageSummary, GenerateCandidatesSummary, OpenTradeResult, ApprovalOutcome, ExitResult };

export type ClosePositionResult =
  | { ok: true; tradeId: string; orderId: string; quantity: number }
  | { ok: false; code: "broker_not_connected" | "no_sellable_quantity" | "refused"; reason: string };

export interface TradingService {
  readonly runtime: TradingRuntime;
  readonly store: TradingStore;
  readonly shadowBooks: ShadowBooks;
  readonly events: typeof tradingEvents;
  ensureStrategyRows(): Promise<void>;
  generateCandidates(asOf?: Date): Promise<GenerateCandidatesSummary>;
  evaluateCandidateForAccount(scope: TenantScope, candidate: CandidateRecord, opts: EvaluateOptions): Promise<EvaluationSnapshot>;
  openTrade(scope: TenantScope, evaluation: EvaluationSnapshot): Promise<OpenTradeResult>;
  requestApproval(scope: TenantScope, evaluation: EvaluationSnapshot): ReturnType<typeof requestApproval>;
  decideApproval(scope: TenantScope, approvalId: string, decision: "approve" | "decline", decidedBy: string): Promise<ApprovalOutcome>;
  submitExit(scope: TenantScope, args: SubmitExitArgs): Promise<ExitResult>;
  closePosition(scope: TenantScope, symbol: string, reason: string, decidedBy: string): Promise<ClosePositionResult>;
  ordersMonitor(scope: TenantScope): Promise<OrdersMonitorSummary>;
  positionsManage(scope: TenantScope): Promise<PositionsManageSummary>;
  tradingCycle(scope: TenantScope): Promise<CycleSummary>;
  accountContext(scope: TenantScope): Promise<AccountContext | null>;
  explainTrade(trade: ExplainTradeInput, thesis: TradeThesis | null, decisions: ExplainDecisionInput[]): string;
}

export const TRADING_SERVICE_KEY = "trading";

/**
 * Compose the trading service. Registers itself under `ctx.services.trading` so routes and jobs
 * can find it; the composition root only has to call this once with the broker, market-data and
 * model-client services it built.
 */
export function createTradingService(ctx: AppContext, deps: TradingDeps): TradingService {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.log ?? { info() {}, warn() {}, error() {} };
  const store = new TradingStore(ctx.repos.sessionsDb());
  const shadowBooks = new ShadowBooks(ctx.repos, { getQuotes: (symbols, maxAge) => deps.marketData.getQuotes(symbols, maxAge ?? 30) }, clock);
  const runtime: TradingRuntime = { repos: ctx.repos, store, broker: deps.broker, marketData: deps.marketData, modelClient: deps.modelClient, shadowBooks, audit: ctx.audit, clock, log };

  const svc: TradingService = {
    runtime, store, shadowBooks, events: tradingEvents,
    ensureStrategyRows: async () => { await ensureStrategyRows(ctx.repos.sessionsDb()); },
    generateCandidates: (asOf) => generateCandidates(ctx, { asOf: asOf ?? clock(), log }),
    evaluateCandidateForAccount: (scope, candidate, opts) => evaluateCandidateForAccount(runtime, scope, candidate, opts),
    openTrade: (scope, evaluation) => openTrade(runtime, scope, evaluation),
    requestApproval: (scope, evaluation) => requestApproval(runtime, scope, evaluation),
    decideApproval: (scope, approvalId, decision, decidedBy) => decideApproval(runtime, scope, approvalId, decision, decidedBy),
    submitExit: (scope, args) => submitExit(runtime, scope, args),
    closePosition: (scope, symbol, reason, decidedBy) => closePosition(runtime, scope, symbol, reason, decidedBy),
    ordersMonitor: (scope) => ordersMonitor(runtime, scope),
    positionsManage: (scope) => positionsManage(runtime, scope),
    tradingCycle: (scope) => tradingCycle(runtime, scope),
    accountContext: (scope) => loadAccountContext(runtime, scope),
    explainTrade,
  };
  ctx.services[TRADING_SERVICE_KEY] = svc;
  return svc;
}

export function tradingService(ctx: AppContext): TradingService {
  return service<TradingService>(ctx, TRADING_SERVICE_KEY);
}

/**
 * Human-initiated exit: the position's managing trade (or a synthetic "manual" trade for an
 * external position) goes through the risk engine's exit path and the execution engine.
 */
export async function closePosition(rt: TradingRuntime, scope: TenantScope, symbol: string, reason: string, decidedBy: string): Promise<ClosePositionResult> {
  assertScope(scope, "closePosition");
  const acct = await loadAccountContext(rt, scope);
  if (!acct) throw new CrossTenantError("closePosition: account not in scope", scope, scope);
  const sym = symbol.toUpperCase();
  if (acct.account.kind === "robinhood_agentic" && acct.account.status !== "connected") return { ok: false, code: "broker_not_connected", reason: `broker ${acct.account.status}` };
  let trade: TradeRow | undefined = await rt.repos.trades.openForSymbol(scope, sym, "live");
  if (!trade) trade = await rt.repos.trades.openForSymbol(scope, sym, "shadow");
  if (trade && (trade.state === "approved" || trade.state === "waiting_for_entry" || trade.state === "order_submitted")) {
    return { ok: false, code: "no_sellable_quantity", reason: `trade ${trade.id} has no filled quantity yet (state ${trade.state}); cancel the order instead` };
  }
  if (!trade) {
    const position = await rt.repos.positions.bySymbol(scope, sym);
    if (!position || position.sharesAvailableForSells <= 0) return { ok: false, code: "no_sellable_quantity", reason: "no position with sellable shares" };
    const regime = await rt.repos.market.latestRegime();
    trade = await rt.repos.trades.create(scope, {
      mode: acct.account.kind === "simulated" ? "shadow" : "live", symbol: sym, strategyId: "manual", strategyVersionId: null, thesisId: null, candidateId: null, state: "monitoring", direction: "long",
      entryQuantity: position.quantity, openQuantity: position.quantity, averageEntryPrice: position.averageCost, initialConfidence: 0, expectedEdge: 0, expectedDownsidePct: 0,
      regimeAtEntry: regime?.primary ?? "unknown", openedAt: position.asOf, versions: { origin: "external_position", createdBy: decidedBy },
    });
    await rt.repos.positions.attachTrade(scope, sym, trade.id, null).catch(() => undefined);
  }
  const res = await submitExit(rt, scope, { trade, quantity: trade.openQuantity, action: "exit", reason: `manual close by ${decidedBy}: ${reason}`.slice(0, 300), identityVerified: true, urgency: "high" });
  await rt.audit.record({ category: "order", action: res.ok ? "manual_close_submitted" : "manual_close_refused", result: res.ok ? "ok" : "rejected", userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: decidedBy, tradeId: trade.id, detail: { symbol: sym, reason, outcome: res.ok ? { orderId: res.order.id, quantity: res.quantity } : res.reason } });
  if (!res.ok) return { ok: false, code: /sellable/.test(res.reason) ? "no_sellable_quantity" : "refused", reason: res.reason };
  return { ok: true, tradeId: res.trade.id, orderId: res.order.id, quantity: res.quantity };
}

/** Route modules owned by the trading service. */
export async function registerTradingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await registerOpportunityRoutes(app, ctx);
  await registerApprovalRoutes(app, ctx);
  await registerDecisionRoutes(app, ctx);
  await registerRiskRoutes(app, ctx);
  await registerPositionsCloseRoutes(app, ctx);
}

export const TRADING_JOBS = {
  candidateGeneration: { name: "candidate_generation", everyMs: 5 * 60_000 },
  tradingCycle: { name: "trading_cycle", everyMs: 60_000, extendedEveryMs: 5 * 60_000 },
  ordersMonitor: { name: "orders_monitor", everyMs: 30_000 },
  positionsManage: { name: "positions_manage", everyMs: 60_000 },
} as const;

/**
 * Scheduler wiring. Jobs are registered on their base interval and gate themselves on the market
 * session: nothing runs while the market is closed; the trading cycle slows to every five minutes
 * in extended sessions. Per-account jobs receive their scope from the scheduler and never look at
 * another account.
 */
export function registerTradingJobs(scheduler: Scheduler, ctx: AppContext): void {
  const svc = () => tradingService(ctx);
  const clock = () => svc().runtime.clock();
  const lastCycle = new Map<string, number>();
  scheduler.register({
    name: TRADING_JOBS.candidateGeneration.name, everyMs: TRADING_JOBS.candidateGeneration.everyMs, kind: "global", timeoutMs: 4 * 60_000,
    run: async () => {
      const session = marketSessionAt(clock());
      if (session === "closed") return { skipped: true, session };
      return candidateGeneration(ctx, svc().runtime);
    },
  }, { runImmediately: true });
  scheduler.register({
    name: TRADING_JOBS.tradingCycle.name, everyMs: TRADING_JOBS.tradingCycle.everyMs, kind: "per_account", timeoutMs: 110_000,
    run: async ({ scope }) => {
      if (!scope) return { skipped: true, reason: "no scope" };
      const now = clock();
      const session = marketSessionAt(now);
      if (session === "closed") return { skipped: true, session };
      const key = `${scope.userId}/${scope.brokerAccountId}`;
      const interval = session === "regular" ? TRADING_JOBS.tradingCycle.everyMs : TRADING_JOBS.tradingCycle.extendedEveryMs;
      const last = lastCycle.get(key) ?? 0;
      if (now.getTime() - last < interval - 1000) return { skipped: true, session, reason: "cadence" };
      lastCycle.set(key, now.getTime());
      return svc().tradingCycle(scope);
    },
  });
  scheduler.register({
    name: TRADING_JOBS.ordersMonitor.name, everyMs: TRADING_JOBS.ordersMonitor.everyMs, kind: "per_account", timeoutMs: 60_000,
    run: async ({ scope }) => {
      if (!scope) return { skipped: true, reason: "no scope" };
      if (marketSessionAt(clock()) === "closed") return { skipped: true, session: "closed" };
      return svc().ordersMonitor(scope);
    },
  });
  scheduler.register({
    name: TRADING_JOBS.positionsManage.name, everyMs: TRADING_JOBS.positionsManage.everyMs, kind: "per_account", timeoutMs: 110_000,
    run: async ({ scope }) => {
      if (!scope) return { skipped: true, reason: "no scope" };
      if (marketSessionAt(clock()) === "closed") return { skipped: true, session: "closed" };
      return svc().positionsManage(scope);
    },
  });
}
