/**
 * Reconciliation of the internal ledger against the broker's truth. Pure.
 *
 * Any mismatch pauses the affected account (fail closed). Broker positions the platform did
 * not open are reported; they only avoid a pause when the operator flagged the symbol as
 * externally managed.
 */
import type { BrokerOrder, BrokerOrderState, PortfolioSnapshot, Position } from "@yz/core";
import { CrossTenantError, TERMINAL_ORDER_STATES } from "@yz/core";
import { isBrokerError } from "./errors.js";

export interface InternalPosition {
  symbol: string;
  quantity: number;
}

export interface InternalOpenOrder {
  brokerOrderId: string | null;
  refId: string | null;
  symbol: string;
  side: "buy" | "sell";
  state?: BrokerOrderState;
  quantity?: number | null;
  cumulativeQuantity?: number;
}

export interface InternalState {
  positions: InternalPosition[];
  openOrders: InternalOpenOrder[];
  /** Null when the ledger does not track cash (skips the cash check). */
  cash: number | null;
  /** Symbols the operator flagged as externally managed in this account. */
  externalSymbols?: readonly string[];
}

export interface BrokerState {
  positions: Position[];
  orders: BrokerOrder[];
  portfolio: PortfolioSnapshot | null;
}

export interface ReconciliationTolerances {
  /** Absolute share tolerance (default 1e-6). */
  quantityAbs?: number;
  /** Absolute cash tolerance in account currency (default 1.00). */
  cashAbs?: number;
  /** Relative cash tolerance as a fraction of broker cash (default 0.001). Whichever is larger applies. */
  cashPct?: number;
}

export interface PositionMismatch {
  symbol: string;
  internalQuantity: number;
  brokerQuantity: number;
  difference: number;
}

export type OrderMismatchKind = "missing_at_broker" | "missing_internally" | "state_mismatch" | "quantity_mismatch";

export interface OrderMismatch {
  kind: OrderMismatchKind;
  brokerOrderId: string | null;
  refId: string | null;
  symbol: string;
  internalState: BrokerOrderState | null;
  brokerState: BrokerOrderState | null;
  placedAgent: string | null;
}

export interface UnexpectedPosition {
  symbol: string;
  brokerQuantity: number;
  /** Flagged as externally managed: reported, not a pause reason. */
  external: boolean;
}

export interface ReconciliationResult {
  ok: boolean;
  positionMismatches: PositionMismatch[];
  orderMismatches: OrderMismatch[];
  unexpectedPositions: UnexpectedPosition[];
  /** broker cash − internal cash; null when either side is unknown. */
  cashDifference: number | null;
  action: "none" | "pause_account";
  reasons: string[];
}

const isOpen = (state: BrokerOrderState): boolean => !TERMINAL_ORDER_STATES.has(state);

export function reconcile(internal: InternalState, broker: BrokerState, tolerances: ReconciliationTolerances = {}): ReconciliationResult {
  const qTol = tolerances.quantityAbs ?? 1e-6;
  const cashAbs = tolerances.cashAbs ?? 1;
  const cashPct = tolerances.cashPct ?? 0.001;
  const reasons: string[] = [];

  // Broker snapshots must all belong to one scope.
  const scopes = new Set([...broker.positions.map((p) => `${p.scope.userId}/${p.scope.brokerAccountId}`), ...broker.orders.map((o) => `${o.scope.userId}/${o.scope.brokerAccountId}`), ...(broker.portfolio ? [`${broker.portfolio.scope.userId}/${broker.portfolio.scope.brokerAccountId}`] : [])]);
  if (scopes.size > 1) {
    const [a, b] = [...scopes];
    const [ua, ba] = (a as string).split("/");
    const [ub, bb] = (b as string).split("/");
    throw new CrossTenantError("reconcile: broker snapshots span more than one tenant scope", { userId: ua ?? "", brokerAccountId: ba ?? "" }, { userId: ub ?? "", brokerAccountId: bb ?? "" });
  }

  // ---- positions
  const brokerBySymbol = new Map<string, number>();
  for (const p of broker.positions) brokerBySymbol.set(p.symbol, (brokerBySymbol.get(p.symbol) ?? 0) + p.quantity);
  const internalBySymbol = new Map<string, number>();
  for (const p of internal.positions) internalBySymbol.set(p.symbol, (internalBySymbol.get(p.symbol) ?? 0) + p.quantity);

  const positionMismatches: PositionMismatch[] = [];
  for (const [symbol, iq] of internalBySymbol) {
    const bq = brokerBySymbol.get(symbol) ?? 0;
    if (Math.abs(bq - iq) > qTol) positionMismatches.push({ symbol, internalQuantity: iq, brokerQuantity: bq, difference: bq - iq });
  }
  const external = new Set(internal.externalSymbols ?? []);
  const unexpectedPositions: UnexpectedPosition[] = [];
  for (const [symbol, bq] of brokerBySymbol) {
    if (internalBySymbol.has(symbol) || Math.abs(bq) <= qTol) continue;
    unexpectedPositions.push({ symbol, brokerQuantity: bq, external: external.has(symbol) });
  }

  // ---- orders
  const orderMismatches: OrderMismatch[] = [];
  const brokerById = new Map(broker.orders.map((o) => [o.brokerOrderId, o]));
  const brokerByRef = new Map(broker.orders.filter((o) => o.refId).map((o) => [o.refId as string, o]));
  const matched = new Set<string>();
  for (const io of internal.openOrders) {
    const bo = (io.brokerOrderId ? brokerById.get(io.brokerOrderId) : undefined) ?? (io.refId ? brokerByRef.get(io.refId) : undefined);
    if (!bo) {
      orderMismatches.push({ kind: "missing_at_broker", brokerOrderId: io.brokerOrderId, refId: io.refId, symbol: io.symbol, internalState: io.state ?? null, brokerState: null, placedAgent: null });
      continue;
    }
    matched.add(bo.brokerOrderId);
    if (io.state && io.state !== bo.state && (isOpen(io.state) !== isOpen(bo.state) || bo.state === "unknown")) {
      orderMismatches.push({ kind: "state_mismatch", brokerOrderId: bo.brokerOrderId, refId: bo.refId, symbol: bo.symbol, internalState: io.state, brokerState: bo.state, placedAgent: bo.placedAgent });
    }
    if (io.quantity !== undefined && io.quantity !== null && bo.quantity !== null && Math.abs(io.quantity - bo.quantity) > qTol) {
      orderMismatches.push({ kind: "quantity_mismatch", brokerOrderId: bo.brokerOrderId, refId: bo.refId, symbol: bo.symbol, internalState: io.state ?? null, brokerState: bo.state, placedAgent: bo.placedAgent });
    }
  }
  for (const bo of broker.orders) {
    if (matched.has(bo.brokerOrderId) || !isOpen(bo.state)) continue;
    if (bo.state === "unknown") {
      orderMismatches.push({ kind: "state_mismatch", brokerOrderId: bo.brokerOrderId, refId: bo.refId, symbol: bo.symbol, internalState: null, brokerState: bo.state, placedAgent: bo.placedAgent });
      continue;
    }
    orderMismatches.push({ kind: "missing_internally", brokerOrderId: bo.brokerOrderId, refId: bo.refId, symbol: bo.symbol, internalState: null, brokerState: bo.state, placedAgent: bo.placedAgent });
  }

  // ---- cash
  let cashDifference: number | null = null;
  if (internal.cash !== null) {
    if (!broker.portfolio) reasons.push("broker portfolio unavailable; cash cannot be reconciled");
    else {
      cashDifference = broker.portfolio.cash - internal.cash;
      const tol = Math.max(cashAbs, Math.abs(broker.portfolio.cash) * cashPct);
      if (Math.abs(cashDifference) > tol) reasons.push(`cash differs by ${cashDifference.toFixed(2)} (tolerance ${tol.toFixed(2)})`);
    }
  }

  if (positionMismatches.length > 0) reasons.push(`${positionMismatches.length} position quantity mismatch(es): ${positionMismatches.map((m) => m.symbol).join(", ")}`);
  const unmanaged = unexpectedPositions.filter((u) => !u.external);
  if (unmanaged.length > 0) reasons.push(`${unmanaged.length} broker position(s) with no internal record: ${unmanaged.map((u) => u.symbol).join(", ")}`);
  if (orderMismatches.length > 0) reasons.push(`${orderMismatches.length} order mismatch(es): ${orderMismatches.map((m) => `${m.kind}${m.brokerOrderId ? ` ${m.brokerOrderId}` : ""}`).join(", ")}`);

  const ok = reasons.length === 0;
  return { ok, positionMismatches, orderMismatches, unexpectedPositions, cashDifference, action: ok ? "none" : "pause_account", reasons };
}

export interface ReconciliationFailureClass {
  kind: "systemic" | "account_specific";
  code: string;
  reason: string;
}

/**
 * Systemic = shared infrastructure (transport, rate limits, Robinhood down, tool schema drift):
 * pause nobody on that basis alone, alert the operator. Account-specific = this credential or
 * this account (not connected, token expired, upstream rejection, cross-tenant bug): pause this
 * account only.
 */
export function classifyReconciliationFailure(err: unknown): ReconciliationFailureClass {
  if (isBrokerError(err)) {
    switch (err.code) {
      case "transport":
      case "rate_limited":
      case "schema_drift":
      case "unknown":
        return { kind: "systemic", code: err.code, reason: err.message };
      default:
        return { kind: "account_specific", code: err.code, reason: err.message };
    }
  }
  if (err instanceof CrossTenantError) return { kind: "account_specific", code: "cross_tenant", reason: err.message };
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Error";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|timeout|503|502|504/i.test(`${name} ${message}`)) {
    return { kind: "systemic", code: "network", reason: message };
  }
  return { kind: "systemic", code: name, reason: message };
}
