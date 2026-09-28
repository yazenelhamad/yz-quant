import type { BrokerOrder, ExecutionPlan, OrderRequest, OrderReview, RejectionReason, RiskAction, TenantScope, TradeLifecycleState, TradeMode, TradeThesis } from "@yz/core";
import {
  CrossTenantError, EXECUTION_MODEL_VERSION, ENSEMBLE_VERSION, FAST_BRAIN_VERSION, FEATURE, FEATURE_VERSION, PORTFOLIO_ENGINE_VERSION, RISK_ENGINE_VERSION, SIZING_ENGINE_VERSION,
  assertSameScope, assertScope, evaluate as riskEvaluate, planExecution, sameScope,
} from "@yz/core";
import { REVIEW_MAX_AGE_MS, type BrokerAdapter } from "@yz/broker";
import type { OrderRow, TradeRow } from "@yz/db";
import { UNFILLED_END_STATES, errorMessage, isFiniteNumber, numOrNull } from "./common.js";
import { adapterMappingVerified, buildRiskInput, expectedEdgeBps, loadAccountContext, loadSymbolContext, recordRiskDecision, rejectionReasonsFromRisk, resolveExecutionAdapter, strategyContextForAccount, type AccountContext, type SymbolContext } from "./evaluate.js";
import { loadValidThesis, THESIS_BUILDER_VERSION } from "./thesis.js";
import type { EvaluationSnapshot, TradingRuntime } from "./types.js";

/** A risk decision older than this must be re-evaluated before it can authorise an order. */
export const RISK_DECISION_MAX_AGE_MS = 120_000;
export const APPROVAL_TTL_MS = 2 * 60 * 60_000;
export const EXECUTION_SETTINGS = { maxChaseBps: 20, defaultRepriceSeconds: 45 } as const;
/** Exits are risk-reducing: the execution planner is told the edge is large so cost never blocks an exit (session/quantity checks still apply). */
export const EXIT_EDGE_BPS = 10_000;

export type OpenTradeResult =
  | { ok: true; trade: TradeRow; order: OrderRow; duplicate: boolean }
  | { ok: false; reason: string; trade: TradeRow | null };

export interface SubmitOrderArgs {
  acct: AccountContext;
  adapter: BrokerAdapter;
  trade: TradeRow;
  side: "buy" | "sell";
  plan: ExecutionPlan;
  arrivalPrice: number;
  mode: TradeMode;
  reason: string;
  reprices?: number;
  originalLimitPrice?: number | null;
  /** Explicit quantity override (default plan.quantity). */
  quantity?: number;
}

export interface SubmitOrderResult { ok: boolean; order: OrderRow; brokerOrder: BrokerOrder | null; error: string | null }

async function placeWithRetry(adapter: BrokerAdapter, req: OrderRequest, review: OrderReview, attempts = 2): Promise<{ order: BrokerOrder }> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await adapter.placeOrder(req, review); // same refId every time: the broker de-duplicates
    } catch (err) {
      last = err;
      const msg = errorMessage(err);
      if (/review|constraint|invalid_request|CrossTenant/i.test(msg)) break; // not retryable
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * The only function that turns a plan into a broker order. Invariants:
 *  1. the `orders` row (with its idempotent `refId`) is written BEFORE the broker is called;
 *  2. `reviewOrder` must succeed and be younger than 60 s before `placeOrder`;
 *  3. the adapter is bound to this scope and account number (checked again here);
 *  4. retries re-send the same request with the same refId.
 */
export async function submitOrder(rt: TradingRuntime, a: SubmitOrderArgs): Promise<SubmitOrderResult> {
  const { acct, adapter, trade, plan } = a;
  const scope = acct.scope;
  assertSameScope(scope, adapter.binding.scope, "submitOrder(adapter)");
  assertSameScope(scope, { userId: trade.userId, brokerAccountId: trade.brokerAccountId }, "submitOrder(trade)");
  if (adapter.binding.accountNumber !== acct.account.accountNumber) throw new CrossTenantError("submitOrder: adapter bound to a different account number", scope, adapter.binding.scope);
  if (a.mode === "live" && adapter.binding.kind === "simulated" && acct.account.kind !== "simulated") throw new Error("submitOrder: refusing to send a live order to a simulated adapter");
  const quantity = a.quantity ?? plan.quantity;
  const refId = crypto.randomUUID();
  const order = await rt.repos.orders.create(scope, {
    refId, tradeId: trade.id, strategyId: trade.strategyId, strategyVersionId: trade.strategyVersionId, accountNumber: acct.account.accountNumber, symbol: trade.symbol, side: a.side, type: plan.orderType,
    quantity, dollarAmount: null, limitPrice: plan.limitPrice, stopPrice: plan.stopPrice, timeInForce: plan.timeInForce, marketHours: plan.marketHours, mode: a.mode, state: "new",
    arrivalPrice: a.arrivalPrice, expectedSlippageBps: plan.expectedSlippageBps, reprices: a.reprices ?? 0,
    raw: { plan, originalLimitPrice: a.originalLimitPrice ?? plan.limitPrice, reason: a.reason, adapterKind: adapter.binding.kind },
  });
  const req: OrderRequest = {
    scope, accountNumber: acct.account.accountNumber, symbol: trade.symbol, side: a.side, type: plan.orderType, quantity, dollarAmount: null, limitPrice: plan.limitPrice, stopPrice: plan.stopPrice,
    timeInForce: plan.timeInForce, marketHours: plan.marketHours, refId, tradeId: trade.id, strategyId: trade.strategyId, strategyVersionId: trade.strategyVersionId,
  };
  const fail = async (state: "rejected" | "failed", error: string): Promise<SubmitOrderResult> => {
    await rt.repos.orders.update(scope, order.id, { state, error: error.slice(0, 500) });
    await rt.audit.record({ category: "order", action: "order_failed", result: "error", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: trade.id, orderId: order.id, error, detail: { symbol: trade.symbol, side: a.side, mode: a.mode, refId } });
    return { ok: false, order: (await rt.repos.orders.byId(scope, order.id))!, brokerOrder: null, error };
  };
  let review: OrderReview;
  try {
    review = await adapter.reviewOrder(req);
  } catch (err) {
    return fail("failed", `review failed: ${errorMessage(err)}`);
  }
  await rt.repos.orders.update(scope, order.id, { review: { ok: review.ok, estimatedCost: review.estimatedCost, quote: review.quote, alerts: review.alerts, reviewedAt: review.reviewedAt }, reviewedAt: review.reviewedAt });
  if (!review.ok) return fail("rejected", `review not ok: ${review.alerts.filter((x) => x.severity === "blocking").map((x) => `${x.code} ${x.message}`).join("; ") || "unspecified"}`);
  const reviewAge = rt.clock().getTime() - Date.parse(review.reviewedAt);
  if (!Number.isFinite(reviewAge) || reviewAge > REVIEW_MAX_AGE_MS) return fail("failed", `review is ${Math.round(reviewAge / 1000)}s old (max ${REVIEW_MAX_AGE_MS / 1000}s)`);
  let placed: { order: BrokerOrder };
  try {
    placed = await placeWithRetry(adapter, req, review);
  } catch (err) {
    return fail("failed", `place failed: ${errorMessage(err)}`);
  }
  const bo = placed.order;
  assertSameScope(scope, bo.scope, "submitOrder(brokerOrder)");
  const nowIso = rt.clock().toISOString();
  await rt.repos.orders.update(scope, order.id, { brokerOrderId: bo.brokerOrderId, state: bo.state, cumulativeQuantity: bo.cumulativeQuantity, averagePrice: bo.averagePrice, fees: bo.fees, submittedAt: bo.createdAt ?? nowIso, lastBrokerSyncAt: nowIso, raw: { plan, originalLimitPrice: a.originalLimitPrice ?? plan.limitPrice, reason: a.reason, adapterKind: adapter.binding.kind, broker: bo.raw ?? null } });
  await rt.audit.record({ category: "order", action: "order_placed", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: trade.id, orderId: order.id, strategyId: trade.strategyId, detail: { symbol: trade.symbol, side: a.side, type: plan.orderType, quantity, limitPrice: plan.limitPrice, mode: a.mode, refId, brokerOrderId: bo.brokerOrderId, state: bo.state, reason: a.reason } });
  return { ok: true, order: (await rt.repos.orders.byId(scope, order.id))!, brokerOrder: bo, error: null };
}

function tradeVersions(ev: EvaluationSnapshot, thesis: TradeThesis): Record<string, string> {
  return {
    riskEngine: RISK_ENGINE_VERSION, sizingEngine: SIZING_ENGINE_VERSION, portfolioEngine: PORTFOLIO_ENGINE_VERSION, fastBrain: FAST_BRAIN_VERSION, ensemble: ENSEMBLE_VERSION, executionModel: EXECUTION_MODEL_VERSION,
    featureVersion: FEATURE_VERSION, strategyVersion: thesis.versions.strategyVersion, thesisBuilder: THESIS_BUILDER_VERSION, thesisModel: thesis.versions.modelName, thesisModelVersion: thesis.versions.modelVersion, thesisPrompt: thesis.versions.promptVersion, regimeAtEntry: ev.regime.primary,
  };
}

async function recordRejection(rt: TradingRuntime, scope: TenantScope, ev: { candidateId: string | null; symbol: string; strategyId: string; expectedEdge: number; confidence: number; regime: string; price: number | null }, reasons: RejectionReason[], detail: string): Promise<void> {
  await rt.repos.rejected.record(scope, { candidateId: ev.candidateId, symbol: ev.symbol, strategyId: ev.strategyId, reasons, detail: detail.slice(0, 4000), expectedEdge: ev.expectedEdge, confidence: ev.confidence, regime: ev.regime, priceAtRejection: ev.price, rejectedAt: rt.clock().toISOString() });
}

async function createTradeRow(rt: TradingRuntime, scope: TenantScope, ev: EvaluationSnapshot, thesis: TradeThesis, quantity: number): Promise<TradeRow> {
  const trade = await rt.repos.trades.create(scope, {
    mode: ev.mode, symbol: ev.candidate.symbol, strategyId: ev.strategyId, strategyVersionId: ev.strategyVersionId, thesisId: thesis.id, candidateId: ev.candidate.id, state: "approved", direction: "long",
    entryQuantity: quantity, openQuantity: 0, initialConfidence: thesis.calibratedConfidence, expectedEdge: thesis.expectedEdge, expectedDownsidePct: thesis.expectedDownsidePct,
    invalidationPrice: thesis.invalidationPrice, targetPrice: thesis.targetPrice, expectedHoldingDays: thesis.expectedHoldingPeriodDays, regimeAtEntry: ev.regime.primary, versions: tradeVersions(ev, thesis),
  });
  await rt.repos.theses.update(scope, thesis.id, { tradeId: trade.id, status: "active" });
  return trade;
}

/** Freshness gate on the risk decision carried by an evaluation. */
export function riskDecisionUsable(ev: EvaluationSnapshot, now: Date): { ok: boolean; reason: string } {
  const r = ev.risk;
  if (!r) return { ok: false, reason: "no risk decision" };
  if (r.failedClosed) return { ok: false, reason: "risk engine failed closed" };
  if (r.verdict !== "approve" && r.verdict !== "reduce") return { ok: false, reason: `risk verdict ${r.verdict}` };
  if (!(r.approvedQuantity > 0)) return { ok: false, reason: "approved quantity is zero" };
  const age = now.getTime() - Date.parse(r.decidedAt);
  if (!Number.isFinite(age) || age > RISK_DECISION_MAX_AGE_MS) return { ok: false, reason: `risk decision is ${Math.round(age / 1000)}s old (max ${RISK_DECISION_MAX_AGE_MS / 1000}s)` };
  return { ok: true, reason: "fresh" };
}

/** Plan the entry order from a fresh quote. Returns the plan or an abort reason. */
async function planEntry(rt: TradingRuntime, acct: AccountContext, sym: SymbolContext, ev: EvaluationSnapshot, quantity: number): Promise<{ plan: ExecutionPlan; arrival: number } | { abort: string }> {
  if (!sym.quote) return { abort: "no fresh quote for entry" };
  if (sym.quoteFreshness === "stale" || sym.quoteFreshness === "unknown") return { abort: `quote is ${sym.quoteFreshness}` };
  const learned = await learnedExecution(rt, acct.scope, sym.adv);
  const plan = planExecution({
    scope: acct.scope, symbol: sym.symbol, side: "buy", quantity, urgency: "normal", last: sym.quote.last, bid: sym.quote.bid, ask: sym.quote.ask, spreadBps: sym.spreadBps, adv: sym.adv,
    realizedVolDaily: numOrNull(sym.features[FEATURE.realizedVolDaily20]), session: acct.session, minutesToClose: sym.minutesToClose,
    expectedEdgeBps: expectedEdgeBps(ev.ensemble.expectedEdge, ev.candidate.expectedUpsidePct), fractionalAllowed: sym.instrument.fractional, extendedHoursAllowed: acct.settings.tradingHours.allowExtendedHours, learned,
  }, { maxSpreadBps: acct.settings.maxSpreadBps, ...EXECUTION_SETTINGS });
  if (plan.abort) return { abort: plan.abortReason ?? "execution plan aborted" };
  return { plan, arrival: sym.quote.last };
}

/** Learned execution statistics for the liquidity bucket from this account's own execution outcomes. */
export async function learnedExecution(rt: TradingRuntime, scope: TenantScope, adv: number | null): Promise<{ avgSlippageBps: number | null; fillRateLimitAtMid: number | null; avgTimeToFillSec: number | null } | null> {
  const bucket = adv === null || adv < 5_000_000 ? "low" : adv < 50_000_000 ? "medium" : "high";
  const rows = (await rt.repos.executionOutcomes.recent(scope, 200)).filter((o) => o.liquidityBucket === bucket);
  if (rows.length < 5) return null;
  const filled = rows.filter((o) => !o.missed && isFiniteNumber(o.actualSlippageBps));
  const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { avgSlippageBps: avg(filled.map((o) => o.actualSlippageBps as number)), fillRateLimitAtMid: rows.length ? filled.length / rows.length : null, avgTimeToFillSec: avg(filled.map((o) => o.timeToFillSeconds).filter(isFiniteNumber)) };
}

/**
 * Turn an approved evaluation into a trade and a broker order. Preconditions (all fail closed):
 * a fresh approve/reduce risk decision, a stored and valid TradeThesis, an adapter bound to this
 * scope and account, and no existing trade for the candidate / open trade for the symbol.
 */
export async function openTrade(rt: TradingRuntime, scope: TenantScope, ev: EvaluationSnapshot): Promise<OpenTradeResult> {
  assertScope(scope, "openTrade");
  assertSameScope(scope, ev.scope, "openTrade(evaluation)");
  const { repos, store } = rt;
  const now = rt.clock();
  const c = ev.candidate;
  const rejInfo = { candidateId: c.id, symbol: c.symbol, strategyId: ev.strategyId, expectedEdge: ev.ensemble.expectedEdge, confidence: ev.calibratedConfidence, regime: ev.regime.primary, price: ev.price };

  // Duplicate protection: one trade per candidate per scope, one open trade per symbol per mode.
  // A trade that ended without a fill (cancelled or rejected) does not count: the candidate was
  // re-evaluated after it, and the new decision gets a new trade and order.
  const latestTrade = await store.tradeForCandidate(scope, c.id);
  const existingTrade = latestTrade && !UNFILLED_END_STATES.has(latestTrade.state) ? latestTrade : undefined;
  if (existingTrade) {
    const orders = await repos.orders.forTrade(scope, existingTrade.id);
    const order = orders[0];
    if (order) return { ok: true, trade: existingTrade, order, duplicate: true };
    return { ok: false, reason: `trade ${existingTrade.id} already exists for this candidate (state ${existingTrade.state})`, trade: existingTrade };
  }
  if (ev.finalStatus !== "approved" && ev.finalStatus !== "shadow") return { ok: false, reason: `evaluation status ${ev.finalStatus} does not authorise execution`, trade: null };
  const fresh = riskDecisionUsable(ev, now);
  if (!fresh.ok) return { ok: false, reason: fresh.reason, trade: null };
  if (!ev.thesisId) { await recordRejection(rt, scope, rejInfo, ["no_thesis"], "no thesis id on evaluation"); return { ok: false, reason: "no thesis (no thesis = no trade)", trade: null }; }
  const thesis = await loadValidThesis(repos, scope, ev.thesisId);
  if (!thesis) { await recordRejection(rt, scope, rejInfo, ["no_thesis"], "thesis missing or failed validation"); return { ok: false, reason: "thesis missing or invalid (no thesis = no trade)", trade: null }; }
  const acct = await loadAccountContext(rt, scope);
  if (!acct) throw new CrossTenantError("openTrade: account not in scope", scope, scope);
  if (acct.account.autonomyLevel === "research_only") return { ok: false, reason: "autonomy research_only: nothing is executed", trade: null };
  if (ev.mode === "live" && (acct.account.autonomyLevel === "shadow" || acct.account.autonomyLevel === "research_only")) return { ok: false, reason: `autonomy ${acct.account.autonomyLevel} never touches the live adapter`, trade: null };
  if (await repos.trades.openForSymbol(scope, c.symbol, ev.mode)) return { ok: false, reason: `open ${ev.mode} trade already exists for ${c.symbol}`, trade: null };
  const adapter = await resolveExecutionAdapter(rt, acct, ev.mode).catch(() => null);
  if (!adapter || !adapterMappingVerified(adapter, acct)) {
    await recordRejection(rt, scope, rejInfo, ["broker_unavailable"], "no adapter bound to this account for the requested mode");
    return { ok: false, reason: "no adapter bound to this scope/account (fail closed)", trade: null };
  }
  if (adapter.binding.accountNumber !== ev.accountNumber) return { ok: false, reason: "evaluation was made for a different account number", trade: null };
  const quantity = ev.risk!.approvedQuantity;
  const trade = await createTradeRow(rt, scope, ev, thesis, quantity);
  return executeEntry(rt, acct, adapter, trade, ev, quantity, "entry");
}

/** Shared tail of `openTrade` and `approve`: plan from a fresh quote, submit, advance the trade. */
async function executeEntry(rt: TradingRuntime, acct: AccountContext, adapter: BrokerAdapter, trade: TradeRow, ev: EvaluationSnapshot, quantity: number, reason: string): Promise<OpenTradeResult> {
  const { repos } = rt;
  const scope = acct.scope;
  const sym = await loadSymbolContext(rt, acct, trade.symbol, ev.candidate.holdingPeriodDays);
  const rejInfo = { candidateId: trade.candidateId, symbol: trade.symbol, strategyId: trade.strategyId, expectedEdge: trade.expectedEdge, confidence: trade.initialConfidence, regime: trade.regimeAtEntry, price: sym.quote?.last ?? null };
  const planned = await planEntry(rt, acct, sym, ev, quantity);
  if ("abort" in planned) {
    const rejected = await repos.trades.transition(scope, trade.id, "rejected", planned.abort, { stage: "execution_plan" });
    await recordRejection(rt, scope, rejInfo, [/quote|stale/.test(planned.abort) ? "stale_data" : "execution_cost"], `execution plan aborted: ${planned.abort}`);
    return { ok: false, reason: planned.abort, trade: rejected };
  }
  const sub = await submitOrder(rt, { acct, adapter, trade, side: "buy", plan: planned.plan, arrivalPrice: planned.arrival, mode: ev.mode, reason });
  if (!sub.ok) {
    const rejected = await repos.trades.transition(scope, trade.id, "rejected", sub.error ?? "order failed", { orderId: sub.order.id });
    await recordRejection(rt, scope, rejInfo, ["broker_unavailable"], `order not accepted: ${sub.error ?? "unknown"}`);
    return { ok: false, reason: sub.error ?? "order failed", trade: rejected };
  }
  const submitted = await repos.trades.transition(scope, trade.id, "order_submitted", `order ${sub.order.id} placed`, { orderId: sub.order.id, brokerOrderId: sub.brokerOrder?.brokerOrderId ?? null });
  return { ok: true, trade: submitted, order: sub.order, duplicate: false };
}

// ---------------------------------------------------------------------------------------------
// Manual approval
// ---------------------------------------------------------------------------------------------

export async function requestApproval(rt: TradingRuntime, scope: TenantScope, ev: EvaluationSnapshot): Promise<{ trade: TradeRow; approvalId: string } | { trade: TradeRow | null; approvalId: null; reason: string }> {
  assertScope(scope, "requestApproval");
  assertSameScope(scope, ev.scope, "requestApproval(evaluation)");
  if (ev.finalStatus !== "needs_approval") return { trade: null, approvalId: null, reason: `evaluation status ${ev.finalStatus} does not need approval` };
  if (!ev.thesisId || !ev.risk) return { trade: null, approvalId: null, reason: "no thesis or risk decision" };
  const latest = await rt.store.tradeForCandidate(scope, ev.candidate.id);
  const existing = latest && !UNFILLED_END_STATES.has(latest.state) ? latest : undefined;
  if (existing) {
    const pending = (await rt.repos.approvals.pending(scope)).find((a) => a.tradeId === existing.id);
    return pending ? { trade: existing, approvalId: pending.id } : { trade: existing, approvalId: null, reason: "trade already exists for this candidate" };
  }
  const thesis = await loadValidThesis(rt.repos, scope, ev.thesisId);
  if (!thesis) return { trade: null, approvalId: null, reason: "thesis missing or invalid" };
  const quantity = ev.risk.approvedQuantity;
  const created = await createTradeRow(rt, scope, ev, thesis, quantity);
  const trade = await rt.repos.trades.transition(scope, created.id, "waiting_for_entry", "manual approval required");
  const approvalId = await rt.repos.approvals.create(scope, {
    tradeId: trade.id, thesisId: thesis.id, symbol: trade.symbol, action: "enter", quantity, notional: ev.risk.approvedNotional, summary: thesis.plainEnglish.slice(0, 600), status: "pending",
    expiresAt: new Date(rt.clock().getTime() + APPROVAL_TTL_MS).toISOString(),
  });
  await rt.audit.record({ category: "order", action: "approval_requested", result: "info", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: trade.id, detail: { approvalId, symbol: trade.symbol, quantity, notional: ev.risk.approvedNotional } });
  return { trade, approvalId };
}

export type ApprovalOutcome = { ok: true; status: "approved" | "declined" | "expired"; trade: TradeRow; order: OrderRow | null; reason: string } | { ok: false; reason: string };

/**
 * Decide a pending approval. Approving re-runs the risk engine on fresh data (a decision made two
 * hours ago authorises nothing); only a fresh approve/reduce lets the order out.
 */
export async function decideApproval(rt: TradingRuntime, scope: TenantScope, approvalId: string, decision: "approve" | "decline", decidedBy: string): Promise<ApprovalOutcome> {
  assertScope(scope, "decideApproval");
  const { repos, store } = rt;
  const approval = await repos.approvals.byId(scope, approvalId);
  if (!approval) return { ok: false, reason: "approval not found in scope" };
  if (approval.status !== "pending") return { ok: false, reason: `approval already ${approval.status}` };
  const trade = await repos.trades.byId(scope, approval.tradeId);
  if (!trade) return { ok: false, reason: "trade not found in scope" };
  const now = rt.clock();
  const auditBase = { category: "order" as const, userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: decidedBy, tradeId: trade.id };
  if (Date.parse(approval.expiresAt) < now.getTime()) {
    await repos.approvals.decide(scope, approvalId, "expired", null);
    const t = trade.state === "waiting_for_entry" ? await repos.trades.transition(scope, trade.id, "canceled", "approval expired") : trade;
    await rt.audit.record({ ...auditBase, action: "approval_expired", result: "info", detail: { approvalId } });
    return { ok: true, status: "expired", trade: t, order: null, reason: "approval expired" };
  }
  if (decision === "decline") {
    await repos.approvals.decide(scope, approvalId, "declined", decidedBy);
    const t = trade.state === "waiting_for_entry" ? await repos.trades.transition(scope, trade.id, "rejected", `declined by ${decidedBy}`) : trade;
    await repos.rejected.record(scope, { candidateId: trade.candidateId, symbol: trade.symbol, strategyId: trade.strategyId, reasons: ["other"], detail: `declined by user ${decidedBy}`, expectedEdge: trade.expectedEdge, confidence: trade.initialConfidence, regime: trade.regimeAtEntry, priceAtRejection: null, rejectedAt: now.toISOString() });
    await rt.audit.record({ ...auditBase, action: "approval_declined", result: "ok", detail: { approvalId } });
    return { ok: true, status: "declined", trade: t, order: null, reason: "declined" };
  }
  if (trade.state !== "waiting_for_entry") return { ok: false, reason: `trade is ${trade.state}, not waiting for entry` };
  const thesis = trade.thesisId ? await loadValidThesis(repos, scope, trade.thesisId) : null;
  if (!thesis) return { ok: false, reason: "thesis missing or invalid (no thesis = no trade)" };
  const candidate = trade.candidateId ? await store.candidateById(trade.candidateId) : undefined;
  if (!candidate) return { ok: false, reason: "candidate missing" };
  const acct = await loadAccountContext(rt, scope);
  if (!acct) throw new CrossTenantError("decideApproval: account not in scope", scope, scope);
  const strategyRow = await store.strategyById(trade.strategyId);
  const strat = strategyRow ? strategyContextForAccount(acct, strategyRow, await store.userStrategySetting(scope, trade.strategyId)) : null;
  const sym = await loadSymbolContext(rt, acct, trade.symbol, thesis.expectedHoldingPeriodDays);
  const mode = trade.mode;
  const adapter = await resolveExecutionAdapter(rt, acct, mode).catch(() => null);
  const ensemble = candidate.ensemble as { expectedEdge: number; disagreement: number; uncertainty: number };
  const riskInput = buildRiskInput({
    acct, sym, strat, mode, action: "enter", side: "buy", quantity: approval.quantity, price: sym.quote?.last ?? null, candidateId: candidate.id, tradeId: trade.id, identityVerified: true, accountMappingVerified: adapterMappingVerified(adapter, acct),
    metrics: { expectedEdge: thesis.expectedEdge, confidence: thesis.calibratedConfidence, disagreement: ensemble.disagreement, uncertainty: ensemble.uncertainty, expectedDownsidePct: thesis.expectedDownsidePct / 100, annualizedVol: sym.annualizedVol, spreadBps: sym.spreadBps, adv: sym.adv, liquidityScore: thesis.liquidity.score, beta: sym.instrument.beta },
    eventRiskWithinHorizon: sym.eventWithinHorizon,
  });
  const risk = riskEvaluate(riskInput);
  await recordRiskDecision(rt, scope, risk, trade.id);
  if (risk.verdict === "reject" || !(risk.approvedQuantity > 0)) {
    await repos.approvals.decide(scope, approvalId, "declined", "risk_engine");
    const t = await repos.trades.transition(scope, trade.id, "rejected", `risk engine rejected on approval: ${risk.reasons.slice(0, 3).join("; ")}`);
    await repos.rejected.record(scope, { candidateId: trade.candidateId, symbol: trade.symbol, strategyId: trade.strategyId, reasons: rejectionReasonsFromRisk(risk), detail: risk.reasons.join("; ").slice(0, 4000), expectedEdge: trade.expectedEdge, confidence: trade.initialConfidence, regime: trade.regimeAtEntry, priceAtRejection: sym.quote?.last ?? null, rejectedAt: now.toISOString() });
    await rt.audit.record({ ...auditBase, action: "approval_rejected_by_risk", result: "rejected", detail: { approvalId, reasons: risk.reasons.slice(0, 10) } });
    return { ok: true, status: "declined", trade: t, order: null, reason: `risk engine rejected: ${risk.reasons.slice(0, 2).join("; ")}` };
  }
  if (!adapter || !adapterMappingVerified(adapter, acct)) return { ok: false, reason: "no adapter bound to this scope/account" };
  await repos.approvals.decide(scope, approvalId, "approved", decidedBy);
  await rt.audit.record({ ...auditBase, action: "approval_approved", result: "ok", detail: { approvalId, quantity: risk.approvedQuantity } });
  const ev: EvaluationSnapshot = {
    scope, candidate, ensemble: candidate.ensemble as EvaluationSnapshot["ensemble"], regime: sym.regime, mode, finalStatus: "approved", reasons: [], rejectionReasons: [], price: sym.quote?.last ?? null, quantity: risk.approvedQuantity, notional: risk.approvedNotional,
    assessment: null, fit: null, sizing: null, fastBrain: null, risk, thesisId: thesis.id, thesis, calibratedConfidence: thesis.calibratedConfidence, strategyId: trade.strategyId, strategyVersionId: trade.strategyVersionId, accountNumber: acct.account.accountNumber, evaluatedAt: now.toISOString(), replay: false,
  };
  if (risk.approvedQuantity !== trade.entryQuantity) await repos.trades.update(scope, trade.id, { entryQuantity: risk.approvedQuantity });
  const result = await executeEntry(rt, acct, adapter, { ...trade, entryQuantity: risk.approvedQuantity }, ev, risk.approvedQuantity, `approved by ${decidedBy}`);
  if (!result.ok) return { ok: true, status: "approved", trade: result.trade ?? trade, order: null, reason: result.reason };
  return { ok: true, status: "approved", trade: result.trade, order: result.order, reason: "order placed" };
}

// ---------------------------------------------------------------------------------------------
// Exits (risk-reducing path): fast brain / human -> risk engine "reduce"/"exit" -> sell order
// ---------------------------------------------------------------------------------------------

export type ExitResult = { ok: true; trade: TradeRow; order: OrderRow; quantity: number } | { ok: false; reason: string; trade: TradeRow };

export interface SubmitExitArgs {
  trade: TradeRow;
  /** Requested quantity; capped to shares available for sells. */
  quantity: number;
  action: Extract<RiskAction, "reduce" | "exit">;
  reason: string;
  identityVerified: boolean;
  urgency?: "normal" | "high";
}

export async function sellableQuantity(rt: TradingRuntime, acct: AccountContext, adapter: BrokerAdapter, trade: TradeRow): Promise<number> {
  if (trade.mode === "live" || acct.account.kind === "simulated") {
    const pos = await rt.repos.positions.bySymbol(acct.scope, trade.symbol);
    if (pos) return Math.max(0, Math.min(pos.sharesAvailableForSells, trade.openQuantity > 0 ? trade.openQuantity : pos.sharesAvailableForSells));
    if (acct.account.kind !== "simulated") return 0;
  }
  // shadow book (or a simulated account not yet synced): ask the adapter that holds the shadow position
  try {
    const positions = await adapter.getPositions();
    const p = positions.find((x) => x.symbol === trade.symbol);
    return p ? Math.max(0, Math.min(p.sharesAvailableForSells, trade.openQuantity > 0 ? trade.openQuantity : p.sharesAvailableForSells)) : 0;
  } catch {
    return 0;
  }
}

export async function submitExit(rt: TradingRuntime, scope: TenantScope, a: SubmitExitArgs): Promise<ExitResult> {
  assertScope(scope, "submitExit");
  const { repos } = rt;
  const trade = a.trade;
  assertSameScope(scope, { userId: trade.userId, brokerAccountId: trade.brokerAccountId }, "submitExit(trade)");
  const acct = await loadAccountContext(rt, scope);
  if (!acct) throw new CrossTenantError("submitExit: account not in scope", scope, scope);
  const openStates: TradeLifecycleState[] = ["filled", "monitoring", "reduce", "partially_filled"];
  if (!openStates.includes(trade.state as TradeLifecycleState)) return { ok: false, reason: `trade is ${trade.state}; nothing to exit`, trade };
  const working = (await repos.orders.forTrade(scope, trade.id)).find((o) => o.side === "sell" && ["new", "queued", "unconfirmed", "confirmed", "partially_filled", "locating"].includes(o.state));
  if (working) return { ok: false, reason: `a sell order (${working.id}) is already working`, trade };
  const adapter = await resolveExecutionAdapter(rt, acct, trade.mode).catch(() => null);
  if (!adapter || !adapterMappingVerified(adapter, acct)) return { ok: false, reason: "no adapter bound to this scope/account", trade };
  const sellable = await sellableQuantity(rt, acct, adapter, trade);
  const quantity = Math.min(a.quantity, sellable);
  if (!(quantity > 0)) return { ok: false, reason: "no sellable quantity", trade };
  const sym = await loadSymbolContext(rt, acct, trade.symbol, trade.expectedHoldingDays ?? 5);
  const price = sym.quote?.last ?? null;
  if (price === null) return { ok: false, reason: "no quote for the symbol", trade };
  const strategyRow = await rt.store.strategyById(trade.strategyId);
  const strat = strategyRow ? strategyContextForAccount(acct, strategyRow, await rt.store.userStrategySetting(scope, trade.strategyId)) : null;
  const risk = riskEvaluate(buildRiskInput({
    acct, sym, strat, mode: trade.mode, action: a.action, side: "sell", quantity, price, candidateId: trade.candidateId, tradeId: trade.id, identityVerified: a.identityVerified, accountMappingVerified: true,
    metrics: { expectedEdge: trade.expectedEdge, confidence: trade.initialConfidence, disagreement: 0, uncertainty: 0, expectedDownsidePct: trade.expectedDownsidePct / 100, annualizedVol: sym.annualizedVol, spreadBps: sym.spreadBps, adv: sym.adv, liquidityScore: null, beta: sym.instrument.beta },
    eventRiskWithinHorizon: false,
  }));
  await recordRiskDecision(rt, scope, risk, trade.id);
  if (risk.verdict === "reject" || !(risk.approvedQuantity > 0)) {
    await rt.audit.record({ category: "risk", action: `${a.action}_rejected`, result: "rejected", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: trade.id, detail: { reasons: risk.reasons.slice(0, 10) } });
    return { ok: false, reason: `risk engine rejected ${a.action}: ${risk.reasons.slice(0, 3).join("; ")}`, trade };
  }
  const learned = await learnedExecution(rt, scope, sym.adv);
  const plan = planExecution({
    scope, symbol: trade.symbol, side: "sell", quantity: risk.approvedQuantity, urgency: a.urgency ?? "high", last: price, bid: sym.quote!.bid, ask: sym.quote!.ask, spreadBps: sym.spreadBps, adv: sym.adv,
    realizedVolDaily: numOrNull(sym.features[FEATURE.realizedVolDaily20]), session: acct.session, minutesToClose: sym.minutesToClose, expectedEdgeBps: EXIT_EDGE_BPS, fractionalAllowed: sym.instrument.fractional,
    extendedHoursAllowed: acct.settings.tradingHours.allowExtendedHours, learned,
  }, { maxSpreadBps: Math.max(acct.settings.maxSpreadBps, 100), ...EXECUTION_SETTINGS });
  if (plan.abort) return { ok: false, reason: plan.abortReason ?? "execution plan aborted", trade };
  const sub = await submitOrder(rt, { acct, adapter, trade, side: "sell", plan, arrivalPrice: price, mode: trade.mode, reason: a.reason });
  if (!sub.ok) return { ok: false, reason: sub.error ?? "sell order failed", trade };
  const target: TradeLifecycleState = a.action === "exit" || risk.approvedQuantity >= trade.openQuantity - 1e-9 ? "exit_requested" : "reduce";
  const from = trade.state as TradeLifecycleState;
  let next: TradeLifecycleState = target;
  if (from === "filled") { await repos.trades.transition(scope, trade.id, "monitoring", "exit requested from filled"); }
  if (from === "partially_filled" && target === "reduce") next = "exit_requested";
  const updated = await repos.trades.transition(scope, trade.id, next, a.reason, { orderId: sub.order.id, quantity: risk.approvedQuantity, action: a.action });
  return { ok: true, trade: updated, order: sub.order, quantity: risk.approvedQuantity };
}

export function isSameScopeTrade(scope: TenantScope, trade: TradeRow): boolean {
  return sameScope(scope, { userId: trade.userId, brokerAccountId: trade.brokerAccountId });
}
