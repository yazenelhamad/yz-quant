import type { ExecutionPlan, IsoTimestamp, OrderType } from "../types/index.js";
import { roundPrice } from "./plan.js";

/** The subset of open-order state the monitor needs. */
export interface OpenOrderState {
  side: "buy" | "sell";
  orderType: OrderType;
  limitPrice: number | null;
  /** Price the order was first placed at; the chase cap is measured from here. */
  originalLimitPrice: number | null;
  placedAt: IsoTimestamp;
  lastRepricedAt: IsoTimestamp | null;
  reprices: number;
  quantity: number;
  filledQuantity: number;
}

export interface MarketSnapshot {
  bid: number | null;
  ask: number | null;
  last: number;
  /** When the quote was observed. */
  asOf: IsoTimestamp;
  session: "closed" | "pre" | "regular" | "post" | "overnight";
}

export interface RepriceDecision {
  reprice: boolean;
  newLimitPrice: number | null;
  reason: string;
}

export interface CancelDecision {
  cancel: boolean;
  reason: string;
}

export interface CancelContext {
  /** Current expected edge of the trade in bps (re-evaluated); null when unknown. */
  currentExpectedEdgeBps: number | null;
  minutesToClose: number | null;
  dataFreshness: "fresh" | "aging" | "stale" | "unknown";
  /** Cancel any order older than this many seconds. Default 1800. */
  maxOrderAgeSeconds?: number;
  /** Quote age beyond which the monitor refuses to act on it. Default 120s. */
  maxQuoteAgeSeconds?: number;
}

const DEFAULT_MAX_QUOTE_AGE = 120;

function seconds(from: IsoTimestamp, to: IsoTimestamp): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 1000;
}

function bps(from: number, to: number): number {
  return ((to - from) / from) * 10_000;
}

/**
 * Decide whether a resting limit order should be moved toward the market.
 * Never chases beyond `plan.repricing.maxChaseBps` from the original price, never acts on a
 * stale quote, and never reprices an order that is already marketable.
 */
export function shouldReprice(order: OpenOrderState, quote: MarketSnapshot, plan: ExecutionPlan, now: IsoTimestamp, maxQuoteAgeSeconds = DEFAULT_MAX_QUOTE_AGE): RepriceDecision {
  if (order.orderType !== "limit" || order.limitPrice === null) return { reprice: false, newLimitPrice: null, reason: "not a limit order" };
  if (order.filledQuantity >= order.quantity) return { reprice: false, newLimitPrice: null, reason: "order already filled" };
  const quoteAge = seconds(quote.asOf, now);
  if (quoteAge === null || quoteAge > maxQuoteAgeSeconds || quoteAge < -5) return { reprice: false, newLimitPrice: null, reason: "quote is stale; not repricing blind" };
  if (quote.session === "closed") return { reprice: false, newLimitPrice: null, reason: "session closed" };
  const since = seconds(order.lastRepricedAt ?? order.placedAt, now);
  if (since === null) return { reprice: false, newLimitPrice: null, reason: "order timestamps unreadable" };
  if (since < plan.repricing.afterSeconds) return { reprice: false, newLimitPrice: null, reason: `only ${since.toFixed(0)}s since last price; waiting ${plan.repricing.afterSeconds}s` };
  if (order.reprices >= plan.repricing.maxReprices) return { reprice: false, newLimitPrice: null, reason: `reprice budget exhausted (${order.reprices}/${plan.repricing.maxReprices})` };
  const original = order.originalLimitPrice ?? order.limitPrice;
  const ask = quote.ask !== null && quote.ask > 0 ? quote.ask : quote.last;
  const bid = quote.bid !== null && quote.bid > 0 ? quote.bid : quote.last;
  const step = plan.repricing.stepBps / 10_000;
  const chase = plan.repricing.maxChaseBps / 10_000;
  if (order.side === "buy") {
    if (order.limitPrice >= ask) return { reprice: false, newLimitPrice: null, reason: "limit already at or above the ask; waiting for the fill" };
    const cap = original * (1 + chase);
    if (order.limitPrice >= cap - 1e-9) return { reprice: false, newLimitPrice: null, reason: `chase limit of ${plan.repricing.maxChaseBps} bps reached` };
    const candidate = Math.min(order.limitPrice * (1 + step), ask, cap);
    const next = roundPrice(candidate, "sell");
    if (next <= order.limitPrice) return { reprice: false, newLimitPrice: null, reason: "step too small to move the price" };
    return { reprice: true, newLimitPrice: next, reason: `raise buy limit from ${order.limitPrice} to ${next} (${bps(original, next).toFixed(1)} bps from original, ask ${ask})` };
  }
  if (order.limitPrice <= bid) return { reprice: false, newLimitPrice: null, reason: "limit already at or below the bid; waiting for the fill" };
  const cap = original * (1 - chase);
  if (order.limitPrice <= cap + 1e-9) return { reprice: false, newLimitPrice: null, reason: `chase limit of ${plan.repricing.maxChaseBps} bps reached` };
  const candidate = Math.max(order.limitPrice * (1 - step), bid, cap);
  const next = roundPrice(candidate, "buy");
  if (next >= order.limitPrice) return { reprice: false, newLimitPrice: null, reason: "step too small to move the price" };
  return { reprice: true, newLimitPrice: next, reason: `lower sell limit from ${order.limitPrice} to ${next} (${(-bps(original, next)).toFixed(1)} bps from original, bid ${bid})` };
}

/**
 * Decide whether an open order should be cancelled: the edge is gone, the market ran away
 * beyond the chase budget, the chase budget is spent, the session is ending or closed, data is
 * stale (fail closed), or the order is simply too old.
 */
export function shouldCancel(order: OpenOrderState, quote: MarketSnapshot, plan: ExecutionPlan, now: IsoTimestamp, ctx: CancelContext): CancelDecision {
  if (order.filledQuantity >= order.quantity) return { cancel: false, reason: "order already filled" };
  if (quote.session === "closed") return { cancel: true, reason: "session closed with an unfilled order" };
  if (ctx.minutesToClose !== null && ctx.minutesToClose <= 1) return { cancel: true, reason: "session ending; not leaving an unfilled order into the close" };
  if (ctx.dataFreshness === "stale" || ctx.dataFreshness === "unknown") return { cancel: true, reason: `market data is ${ctx.dataFreshness}; cancelling rather than resting blind` };
  if (ctx.currentExpectedEdgeBps !== null && ctx.currentExpectedEdgeBps <= plan.expectedCostBps) {
    return { cancel: true, reason: `edge gone: current edge ${ctx.currentExpectedEdgeBps.toFixed(1)} bps no longer covers the ${plan.expectedCostBps.toFixed(1)} bps expected cost` };
  }
  const age = seconds(order.placedAt, now);
  const maxAge = ctx.maxOrderAgeSeconds ?? 1800;
  if (age !== null && age > maxAge) return { cancel: true, reason: `order is ${age.toFixed(0)}s old, beyond the ${maxAge}s maximum` };
  if (order.orderType === "limit" && order.limitPrice !== null) {
    const quoteAge = seconds(quote.asOf, now);
    const quoteUsable = quoteAge !== null && quoteAge <= (ctx.maxQuoteAgeSeconds ?? DEFAULT_MAX_QUOTE_AGE);
    if (quoteUsable) {
      const ask = quote.ask !== null && quote.ask > 0 ? quote.ask : quote.last;
      const bid = quote.bid !== null && quote.bid > 0 ? quote.bid : quote.last;
      const original = order.originalLimitPrice ?? order.limitPrice;
      const away = order.side === "buy" ? bps(original, ask) : -bps(original, bid);
      if (away > plan.repricing.maxChaseBps) return { cancel: true, reason: `market has moved ${away.toFixed(1)} bps away from the original price, beyond the ${plan.repricing.maxChaseBps} bps chase limit` };
    }
    const since = seconds(order.lastRepricedAt ?? order.placedAt, now);
    if (order.reprices >= plan.repricing.maxReprices && since !== null && since > plan.repricing.afterSeconds) {
      return { cancel: true, reason: `reprice budget spent (${order.reprices}) and still unfilled after ${since.toFixed(0)}s` };
    }
  }
  return { cancel: false, reason: "order remains valid" };
}
