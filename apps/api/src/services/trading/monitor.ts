import type { BrokerOrder, BrokerOrderState, ExecutionPlan, FastBrainInput, TenantScope, TradeLifecycleState } from "@yz/core";
import { CrossTenantError, TERMINAL_ORDER_STATES, assertScope, computeRiskCapacity, decide, evaluateOutcome, minutesToClose as minutesToSessionClose, nextStateForOrderState, regimeSupport, shouldCancel, shouldReprice, type MarketSnapshot, type OpenOrderState } from "@yz/core";
import { deriveFills, type BrokerAdapter } from "@yz/broker";
import type { OrderRow, TradeRow } from "@yz/db";
import { errorMessage, isFiniteNumber } from "./common.js";
import { emitSafe } from "./events.js";
import { adapterMappingVerified, loadAccountContext, loadSymbolContext, resolveExecutionAdapter, type AccountContext } from "./evaluate.js";
import { submitExit, submitOrder } from "./execute.js";
import { loadValidThesis } from "./thesis.js";
import type { TradingRuntime } from "./types.js";

const WORKING_ORDER_STATES: ReadonlySet<string> = new Set(["new", "queued", "unconfirmed", "confirmed", "partially_filled", "locating"]);
const CANCEL_STATES: ReadonlySet<BrokerOrderState> = new Set<BrokerOrderState>(["cancelled", "partially_filled_rest_cancelled"]);

export interface OrdersMonitorSummary { scope: TenantScope; refused: boolean; orders: number; synced: number; fills: number; reprices: number; cancels: number; closed: number; errors: string[] }
export interface PositionsManageSummary { scope: TenantScope; refused: boolean; trades: number; exits: number; reduces: number; closed: number; holds: number; errors: string[] }

function rowToBrokerOrder(scope: TenantScope, o: OrderRow): BrokerOrder | null {
  if (!o.brokerOrderId) return null;
  return {
    scope, brokerOrderId: o.brokerOrderId, refId: o.refId, symbol: o.symbol, side: o.side, type: o.type as BrokerOrder["type"], state: o.state as BrokerOrderState, quantity: o.quantity, cumulativeQuantity: o.cumulativeQuantity,
    limitPrice: o.limitPrice, stopPrice: o.stopPrice, averagePrice: o.averagePrice, fees: o.fees, timeInForce: o.timeInForce as BrokerOrder["timeInForce"], marketHours: o.marketHours as BrokerOrder["marketHours"], placedAgent: null,
    createdAt: o.submittedAt ?? o.createdAt, updatedAt: o.lastBrokerSyncAt ?? o.updatedAt,
  };
}

function rawOf(o: OrderRow): Record<string, unknown> {
  return o.raw && typeof o.raw === "object" ? { ...(o.raw as Record<string, unknown>) } : {};
}

/** Apply derived fills to the trade's open quantity, average prices, fees and realized P&L. */
async function applyFillsToTrade(rt: TradingRuntime, scope: TenantScope, trade: TradeRow, fills: { side: "buy" | "sell"; quantity: number; price: number; fees: number; at: string }[]): Promise<TradeRow> {
  let open = trade.openQuantity;
  let avgEntry = trade.averageEntryPrice ?? 0;
  let fees = trade.fees;
  let realized = trade.realizedPnl;
  let openedAt = trade.openedAt;
  let exitedQty = 0;
  let exitedValue = 0;
  if (trade.averageExitPrice !== null) {
    const prior = (await rt.repos.fills.recent(scope, 500)).filter((f) => f.tradeId === trade.id && f.side === "sell");
    exitedQty = prior.reduce((s, f) => s + f.quantity, 0);
    exitedValue = prior.reduce((s, f) => s + f.quantity * f.price, 0);
  }
  for (const f of fills) {
    if (f.side === "buy") {
      const newOpen = open + f.quantity;
      avgEntry = newOpen > 0 ? (avgEntry * open + f.price * f.quantity) / newOpen : avgEntry;
      open = newOpen;
      if (!openedAt) openedAt = f.at;
    } else {
      realized += (f.price - avgEntry) * f.quantity - f.fees;
      exitedQty += f.quantity;
      exitedValue += f.quantity * f.price;
      open = Math.max(0, open - f.quantity);
    }
    fees += f.fees;
  }
  const patch = { openQuantity: Math.round(open * 1e6) / 1e6, averageEntryPrice: avgEntry > 0 ? Math.round(avgEntry * 1e6) / 1e6 : trade.averageEntryPrice, fees: Math.round(fees * 100) / 100, realizedPnl: Math.round(realized * 100) / 100, openedAt, averageExitPrice: exitedQty > 0 ? Math.round((exitedValue / exitedQty) * 1e6) / 1e6 : trade.averageExitPrice };
  await rt.repos.trades.update(scope, trade.id, patch);
  return { ...trade, ...patch };
}

/** Close a flat trade: state closed, closedAt, exit reason; thesis closed; `tradeClosed` emitted. */
export async function finalizeClose(rt: TradingRuntime, scope: TenantScope, trade: TradeRow, exitReason: string): Promise<TradeRow> {
  const from = trade.state as TradeLifecycleState;
  let current = trade;
  if (from === "filled") current = await rt.repos.trades.transition(scope, trade.id, "monitoring", "flat after fill");
  if (from === "partially_filled") current = await rt.repos.trades.transition(scope, trade.id, "exit_requested", "flat after partial fill");
  const closed = await rt.repos.trades.transition(scope, current.id, "closed", exitReason, { realizedPnl: current.realizedPnl }, { closedAt: rt.clock().toISOString(), exitReason: exitReason.slice(0, 200), openQuantity: 0 });
  if (closed.thesisId) await rt.repos.theses.update(scope, closed.thesisId, { status: "closed" }).catch(() => undefined);
  await rt.repos.positions.attachTrade(scope, closed.symbol, null, null).catch(() => undefined);
  await rt.audit.record({ category: "order", action: "trade_closed", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: closed.id, detail: { symbol: closed.symbol, realizedPnl: closed.realizedPnl, exitReason } });
  emitSafe("tradeClosed", scope, closed.id);
  return closed;
}

async function recordOutcome(rt: TradingRuntime, acct: AccountContext, order: OrderRow, bo: BrokerOrder): Promise<void> {
  const raw = rawOf(order);
  if (raw["outcomeRecorded"] === true) return;
  const inst = acct.instruments.get(order.symbol) ?? (await rt.repos.market.instrument(order.symbol).then((i) => (i ? { adv: i.avgDollarVolume20 } : null)).catch(() => null));
  const arrival = order.arrivalPrice ?? order.limitPrice ?? bo.averagePrice ?? 0;
  const submittedMs = Date.parse(order.submittedAt ?? order.createdAt);
  const updatedMs = Date.parse(bo.updatedAt);
  const outcome = evaluateOutcome(
    { scope: acct.scope, brokerOrderId: bo.brokerOrderId, symbol: order.symbol, side: order.side, expectedPrice: order.limitPrice ?? arrival, arrivalPrice: arrival, expectedSlippageBps: order.expectedSlippageBps ?? 0, requestedQuantity: order.quantity ?? bo.cumulativeQuantity, adv: inst?.adv ?? null, session: acct.session },
    { fillPrice: bo.averagePrice, filledQuantity: bo.cumulativeQuantity, timeToFillSeconds: Number.isFinite(submittedMs) && Number.isFinite(updatedMs) ? Math.max(0, (updatedMs - submittedMs) / 1000) : null, reprices: order.reprices, cancelled: CANCEL_STATES.has(bo.state), at: rt.clock().toISOString() },
  );
  await rt.repos.executionOutcomes.record(acct.scope, {
    orderId: order.id, brokerOrderId: bo.brokerOrderId, symbol: outcome.symbol, side: outcome.side, expectedPrice: outcome.expectedPrice, arrivalPrice: outcome.arrivalPrice, fillPrice: outcome.fillPrice, expectedSlippageBps: outcome.expectedSlippageBps,
    actualSlippageBps: outcome.actualSlippageBps, timeToFillSeconds: outcome.timeToFillSeconds, partial: outcome.partial, missed: outcome.missed, reprices: outcome.reprices, cancelled: outcome.cancelled, liquidityBucket: outcome.liquidityBucket, session: outcome.session, mode: order.mode, at: outcome.at,
  });
  await rt.repos.orders.update(acct.scope, order.id, { raw: { ...raw, outcomeRecorded: true } });
}

/** Re-place a cancelled-for-reprice order at its new limit for the remaining quantity (new refId, reprices + 1). */
async function replaceForReprice(rt: TradingRuntime, acct: AccountContext, adapter: BrokerAdapter, order: OrderRow, bo: BrokerOrder, trade: TradeRow, newLimit: number): Promise<OrderRow | null> {
  const raw = rawOf(order);
  const plan = raw["plan"] as ExecutionPlan | undefined;
  if (!plan) return null;
  const remaining = Math.round(((order.quantity ?? 0) - bo.cumulativeQuantity) * 1e6) / 1e6;
  if (!(remaining > 0)) return null;
  const replaced = await submitOrder(rt, {
    acct, adapter, trade, side: order.side, plan: { ...plan, limitPrice: newLimit, quantity: remaining }, arrivalPrice: order.arrivalPrice ?? newLimit, mode: order.mode, reason: `reprice ${order.reprices + 1}: ${String(raw["repriceReason"] ?? "")}`.trim(),
    reprices: order.reprices + 1, originalLimitPrice: (raw["originalLimitPrice"] as number | null | undefined) ?? order.limitPrice, quantity: remaining,
  });
  await rt.repos.orders.update(acct.scope, order.id, { raw: { ...raw, repricePending: null, replacedBy: replaced.order.id } });
  return replaced.ok ? replaced.order : null;
}

/**
 * Sync one open order with the broker: derive fills, advance the trade lifecycle, record the
 * execution outcome when the order ends, and apply the repricing / cancellation rules. Returns
 * counters for the job summary.
 */
export async function syncOrder(rt: TradingRuntime, acct: AccountContext, adapter: BrokerAdapter, order: OrderRow, out: OrdersMonitorSummary): Promise<void> {
  const scope = acct.scope;
  const prev = rowToBrokerOrder(scope, order);
  if (!prev) return;
  const bo = await adapter.getOrder(prev.brokerOrderId);
  if (!bo) return;
  if (!(bo.scope.userId === scope.userId && bo.scope.brokerAccountId === scope.brokerAccountId)) throw new CrossTenantError("syncOrder: broker order outside scope", scope, bo.scope);
  const now = rt.clock();
  const nowIso = now.toISOString();
  const fills = deriveFills(prev, bo);
  for (const f of fills) {
    await rt.repos.fills.record(scope, { orderId: order.id, brokerOrderId: bo.brokerOrderId, tradeId: order.tradeId, symbol: f.symbol, side: f.side, quantity: f.quantity, price: f.price, fees: f.fees, derived: true, mode: order.mode, at: f.at });
    out.fills += 1;
  }
  const raw = rawOf(order);
  await rt.repos.orders.update(scope, order.id, { state: bo.state, cumulativeQuantity: bo.cumulativeQuantity, averagePrice: bo.averagePrice, fees: bo.fees, lastBrokerSyncAt: nowIso, raw: { ...raw, broker: bo.raw ?? raw["broker"] ?? null } });
  const synced: OrderRow = { ...order, state: bo.state, cumulativeQuantity: bo.cumulativeQuantity, averagePrice: bo.averagePrice, fees: bo.fees };
  out.synced += 1;

  let trade = order.tradeId ? await rt.repos.trades.byId(scope, order.tradeId) : undefined;
  if (trade && fills.length > 0) {
    const wasFlat = trade.openQuantity <= 0;
    trade = await applyFillsToTrade(rt, scope, trade, fills);
    if (wasFlat && trade.openQuantity > 0 && order.side === "buy") {
      await rt.repos.positions.attachTrade(scope, trade.symbol, trade.id, trade.strategyId).catch(() => undefined);
      emitSafe("tradeOpened", scope, trade.id);
    }
  }
  const terminal = TERMINAL_ORDER_STATES.has(bo.state);
  const repricePending = raw["repricePending"] as { newLimitPrice: number } | null | undefined;

  if (terminal) {
    await recordOutcome(rt, acct, synced, bo).catch((err) => out.errors.push(`outcome ${order.id}: ${errorMessage(err)}`));
    if (trade && CANCEL_STATES.has(bo.state) && repricePending) {
      const replaced = await replaceForReprice(rt, acct, adapter, synced, bo, trade, repricePending.newLimitPrice).catch((err) => { out.errors.push(`reprice ${order.id}: ${errorMessage(err)}`); return null; });
      if (replaced) { out.reprices += 1; return; } // the trade keeps its state; the new order carries on
    }
  }
  if (trade) {
    const next = nextStateForOrderState(bo.state, trade.state as TradeLifecycleState);
    if (next && next !== trade.state) {
      trade = await rt.repos.trades.transition(scope, trade.id, next, `order ${bo.brokerOrderId} ${bo.state}`, { orderId: order.id, cumulativeQuantity: bo.cumulativeQuantity });
      if (next === "filled") trade = await rt.repos.trades.transition(scope, trade.id, "monitoring", "position open; monitoring");
      if (next === "closed") {
        await rt.repos.trades.update(scope, trade.id, { closedAt: nowIso, exitReason: String(raw["reason"] ?? "exit").slice(0, 200), openQuantity: 0 });
        if (trade.thesisId) await rt.repos.theses.update(scope, trade.thesisId, { status: "closed" }).catch(() => undefined);
        await rt.repos.positions.attachTrade(scope, trade.symbol, null, null).catch(() => undefined);
        await rt.audit.record({ category: "order", action: "trade_closed", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: trade.id, detail: { symbol: trade.symbol, realizedPnl: trade.realizedPnl, exitReason: raw["reason"] ?? "exit" } });
        emitSafe("tradeClosed", scope, trade.id);
        out.closed += 1;
      }
    }
    // A sell that leaves nothing open closes the trade even when the order state alone did not say so.
    if (terminal && order.side === "sell" && trade.openQuantity <= 1e-9 && ["monitoring", "reduce", "exit_requested", "partially_filled"].includes(trade.state)) {
      await finalizeClose(rt, scope, trade, String(raw["reason"] ?? "exit"));
      out.closed += 1;
    }
  }
  if (terminal || !WORKING_ORDER_STATES.has(bo.state)) return;

  // ---- Working order: cancellation / repricing rules ------------------------------------------
  const plan = raw["plan"] as ExecutionPlan | undefined;
  if (!plan) return;
  const quotes = await rt.marketData.getQuotes([order.symbol], 30).catch(() => []);
  const q = quotes.find((x) => x.symbol === order.symbol);
  if (!q) return;
  const snapshot: MarketSnapshot = { bid: q.bid, ask: q.ask, last: q.last, asOf: q.provenance.observedAt, session: acct.session };
  const state: OpenOrderState = {
    side: order.side, orderType: order.type as OpenOrderState["orderType"], limitPrice: order.limitPrice, originalLimitPrice: (raw["originalLimitPrice"] as number | null | undefined) ?? order.limitPrice,
    placedAt: order.submittedAt ?? order.createdAt, lastRepricedAt: null, reprices: order.reprices, quantity: order.quantity ?? bo.cumulativeQuantity, filledQuantity: bo.cumulativeQuantity,
  };
  const minutesToClose = minutesToSessionClose(now);
  const cancel = shouldCancel(state, snapshot, plan, nowIso, { currentExpectedEdgeBps: null, minutesToClose, dataFreshness: q.freshness });
  if (cancel.cancel) {
    const res = await adapter.cancelOrder(bo.brokerOrderId);
    await rt.repos.orders.update(scope, order.id, { cancelRequestedAt: nowIso, raw: { ...raw, cancelReason: cancel.reason, cancelAccepted: res.accepted } });
    await rt.audit.record({ category: "order", action: "order_cancel_requested", result: res.accepted ? "ok" : "error", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: order.tradeId, orderId: order.id, detail: { reason: cancel.reason } });
    out.cancels += 1;
    return;
  }
  const reprice = shouldReprice(state, snapshot, plan, nowIso);
  if (!reprice.reprice || reprice.newLimitPrice === null) return;
  const res = await adapter.cancelOrder(bo.brokerOrderId);
  if (!res.accepted) return;
  await rt.repos.orders.update(scope, order.id, { cancelRequestedAt: nowIso, raw: { ...raw, repricePending: { newLimitPrice: reprice.newLimitPrice }, repriceReason: reprice.reason } });
  await rt.audit.record({ category: "order", action: "order_reprice_requested", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, tradeId: order.tradeId, orderId: order.id, detail: { reason: reprice.reason, newLimitPrice: reprice.newLimitPrice } });
  // Re-place immediately when the broker confirms the cancel synchronously; otherwise the next sync does it.
  const after = await adapter.getOrder(bo.brokerOrderId);
  if (after && CANCEL_STATES.has(after.state) && trade) {
    const refreshed = (await rt.repos.orders.byId(scope, order.id))!;
    const fills2 = deriveFills(bo, after);
    for (const f of fills2) { await rt.repos.fills.record(scope, { orderId: order.id, brokerOrderId: after.brokerOrderId, tradeId: order.tradeId, symbol: f.symbol, side: f.side, quantity: f.quantity, price: f.price, fees: f.fees, derived: true, mode: order.mode, at: f.at }); out.fills += 1; }
    if (fills2.length > 0) trade = await applyFillsToTrade(rt, scope, trade, fills2);
    await rt.repos.orders.update(scope, order.id, { state: after.state, cumulativeQuantity: after.cumulativeQuantity, averagePrice: after.averagePrice, fees: after.fees, lastBrokerSyncAt: nowIso });
    await recordOutcome(rt, acct, { ...refreshed, state: after.state, cumulativeQuantity: after.cumulativeQuantity, averagePrice: after.averagePrice }, after).catch(() => undefined);
    const replaced = await replaceForReprice(rt, acct, adapter, { ...refreshed, state: after.state, cumulativeQuantity: after.cumulativeQuantity }, after, trade, reprice.newLimitPrice).catch((err) => { out.errors.push(`reprice ${order.id}: ${errorMessage(err)}`); return null; });
    if (replaced) out.reprices += 1;
  }
}

/** Per-account job `orders_monitor`: sync every open order of the account with its adapter. */
export async function ordersMonitor(rt: TradingRuntime, scope: TenantScope): Promise<OrdersMonitorSummary> {
  assertScope(scope, "ordersMonitor");
  const out: OrdersMonitorSummary = { scope, refused: false, orders: 0, synced: 0, fills: 0, reprices: 0, cancels: 0, closed: 0, errors: [] };
  const acct = await loadAccountContext(rt, scope);
  if (!acct) { out.refused = true; return out; }
  const open = await rt.repos.orders.open(scope);
  out.orders = open.length;
  for (const order of open) {
    if (!order.brokerOrderId) continue;
    try {
      const adapter = await resolveExecutionAdapter(rt, acct, order.mode);
      if (!adapter || !adapterMappingVerified(adapter, acct)) { out.errors.push(`${order.id}: no adapter for mode ${order.mode}`); continue; }
      await syncOrder(rt, acct, adapter, order, out);
    } catch (err) {
      out.errors.push(`${order.id}: ${errorMessage(err)}`);
      rt.log.warn({ err, orderId: order.id, scope: scope.brokerAccountId }, "order sync failed");
    }
  }
  return out;
}

/**
 * Per-account job `positions_manage`: for every open trade compute excursions, check
 * invalidation / target / holding period / regime change, ask the fast brain, and route
 * REDUCE / EXIT through the risk engine's risk-reducing path.
 */
export async function positionsManage(rt: TradingRuntime, scope: TenantScope): Promise<PositionsManageSummary> {
  assertScope(scope, "positionsManage");
  const out: PositionsManageSummary = { scope, refused: false, trades: 0, exits: 0, reduces: 0, closed: 0, holds: 0, errors: [] };
  const acct = await loadAccountContext(rt, scope);
  if (!acct) { out.refused = true; return out; }
  const trades = await rt.repos.trades.list(scope, { states: ["filled", "monitoring", "reduce", "partially_filled"], limit: 500 });
  const regimeRow = await rt.repos.market.latestRegime();
  for (let trade of trades) {
    out.trades += 1;
    try {
      if (trade.state === "filled") trade = await rt.repos.trades.transition(scope, trade.id, "monitoring", "position open; monitoring");
      if (trade.openQuantity <= 1e-9) {
        const working = (await rt.repos.orders.forTrade(scope, trade.id)).some((o) => WORKING_ORDER_STATES.has(o.state));
        if (!working && trade.state !== "partially_filled") { await finalizeClose(rt, scope, trade, trade.exitReason ?? "flat"); out.closed += 1; }
        continue;
      }
      const thesis = trade.thesisId ? await loadValidThesis(rt.repos, scope, trade.thesisId) : null;
      const sym = await loadSymbolContext(rt, acct, trade.symbol, trade.expectedHoldingDays ?? 5);
      if (!sym.quote) { out.errors.push(`${trade.symbol}: no quote`); continue; }
      const price = sym.quote.last;
      const entry = trade.averageEntryPrice ?? null;
      const pnlPct = entry && entry > 0 ? price / entry - 1 : null;
      const patch: Partial<TradeRow> = {};
      if (pnlPct !== null) {
        const pnlPoints = pnlPct * 100;
        patch.maxAdverseExcursionPct = Math.min(trade.maxAdverseExcursionPct ?? 0, pnlPoints);
        patch.maxFavorableExcursionPct = Math.max(trade.maxFavorableExcursionPct ?? 0, pnlPoints);
      }
      const ageDays = trade.openedAt ? (acct.now.getTime() - Date.parse(trade.openedAt)) / 86_400_000 : null;
      const invalidation = trade.invalidationPrice ?? thesis?.invalidationPrice ?? null;
      const target = trade.targetPrice ?? thesis?.targetPrice ?? null;
      const invalidated = isFiniteNumber(invalidation) && price <= invalidation;
      const targetReached = isFiniteNumber(target) && price >= target;
      const holdingExceeded = isFiniteNumber(trade.expectedHoldingDays) && trade.expectedHoldingDays > 0 && ageDays !== null && ageDays > 2 * trade.expectedHoldingDays;
      const strategyRow = await rt.store.strategyById(trade.strategyId);
      const supported = (strategyRow?.supportedRegimes ?? []) as Parameters<typeof regimeSupport>[1];
      const regimeFit = regimeSupport(sym.regime, supported);
      const regimeChanged = !!regimeRow && sym.regime.primary !== trade.regimeAtEntry && regimeFit < 0.3;
      const currentEdge = holdingExceeded || regimeChanged ? 0 : trade.expectedEdge;
      const workingSell = (await rt.repos.orders.forTrade(scope, trade.id)).find((o) => WORKING_ORDER_STATES.has(o.state));
      const input: FastBrainInput = {
        scope, symbol: trade.symbol, strategyKey: strategyRow?.key ?? trade.strategyId, hasPosition: true, positionPnlPct: pnlPct, positionAgeDays: ageDays === null ? null : Math.round(ageDays), invalidated, targetReached,
        expectedEdge: currentEdge, confidence: trade.initialConfidence, disagreement: 0, uncertainty: sym.dataFreshness === "fresh" ? 0.1 : sym.dataFreshness === "aging" ? 0.4 : 1, regimeFit, liquidityScore: thesis?.liquidity.score ?? 0.5,
        spreadBps: sym.spreadBps, dataFreshness: sym.dataFreshness, portfolioFit: 0, riskCapacity: computeRiskCapacity({ currentDrawdownPct: acct.portfolio.drawdownPct, dailyPnlPct: acct.portfolio.dailyPnlPct, weeklyPnlPct: acct.portfolio.weeklyPnlPct, settings: acct.settings, warnings: [] }),
        eventRiskWithinHorizon: sym.eventWithinHorizon,
        openOrder: workingSell ? { side: workingSell.side, ageSeconds: Math.max(0, (acct.now.getTime() - Date.parse(workingSell.createdAt)) / 1000), distanceFromMarketBps: workingSell.limitPrice ? Math.abs((price - workingSell.limitPrice) / price) * 10_000 : 0, fillProbability: 0.5 } : null,
        marketSession: acct.session, calibrationAdjustment: 1,
      };
      const fb = decide(input, acct.nowIso);
      const notes: string[] = [];
      if (invalidated) notes.push(`invalidation ${invalidation} hit at ${price}`);
      if (targetReached) notes.push(`target ${target} reached at ${price}`);
      if (holdingExceeded) notes.push("holding period exceeded 2x expectation");
      if (regimeChanged) notes.push(`regime changed to ${sym.regime.primary} (fit ${regimeFit.toFixed(2)})`);
      await rt.repos.trades.update(scope, trade.id, { ...patch, versions: { ...(trade.versions as Record<string, unknown>), lastFastBrain: { action: fb.action, conviction: fb.conviction, at: acct.nowIso, notes } } });
      if (workingSell) { out.holds += 1; continue; }
      if (fb.action === "EXIT" || fb.action === "SELL") {
        const res = await submitExit(rt, scope, { trade: { ...trade, ...patch }, quantity: trade.openQuantity, action: "exit", reason: `fast brain ${fb.action}: ${notes.join("; ") || fb.reasons[0] || "exit"}`, identityVerified: true, urgency: "high" });
        if (res.ok) out.exits += 1; else out.errors.push(`${trade.symbol}: ${res.reason}`);
      } else if (fb.action === "REDUCE") {
        const half = Math.floor(trade.openQuantity / 2);
        if (half >= 1) {
          const res = await submitExit(rt, scope, { trade: { ...trade, ...patch }, quantity: half, action: "reduce", reason: `fast brain REDUCE: ${notes.join("; ") || fb.reasons[0] || "reduce"}`, identityVerified: true, urgency: "normal" });
          if (res.ok) out.reduces += 1; else out.errors.push(`${trade.symbol}: ${res.reason}`);
        } else {
          const res = await submitExit(rt, scope, { trade: { ...trade, ...patch }, quantity: trade.openQuantity, action: "exit", reason: `fast brain REDUCE on a single-share position: ${notes.join("; ")}`, identityVerified: true, urgency: "high" });
          if (res.ok) out.exits += 1; else out.errors.push(`${trade.symbol}: ${res.reason}`);
        }
      } else {
        out.holds += 1;
      }
    } catch (err) {
      out.errors.push(`${trade.symbol}: ${errorMessage(err)}`);
      rt.log.warn({ err, tradeId: trade.id, scope: scope.brokerAccountId }, "position management failed");
    }
  }
  return out;
}
