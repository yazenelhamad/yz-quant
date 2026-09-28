/**
 * Robinhood order constraints and the review-then-place invariant, enforced locally before any
 * call leaves the process. Pure functions shared by the live and the simulated adapter.
 */
import type { OrderRequest, OrderReview } from "@yz/core";
import { BrokerError, type BrokerErrorCode } from "./errors.js";

export const REVIEW_MAX_AGE_MS = 60_000;
/** Robinhood accepts up to 6 decimal places on fractional quantities. */
export const MAX_QUANTITY_DECIMALS = 6;
export const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export type OrderValidation = { ok: true } | { ok: false; code: Extract<BrokerErrorCode, "constraint_violation" | "invalid_request">; reason: string };

export interface OrderValidationContext {
  /**
   * `shares_available_for_sells` for the symbol when positions are known:
   *   undefined → unknown (skip the sellable check), null → no position, number → sellable shares.
   */
  sharesAvailable?: number | null;
}

function positive(n: number | null): n is number {
  return n !== null && Number.isFinite(n) && n > 0;
}

export function isFractional(quantity: number): boolean {
  return !Number.isInteger(quantity);
}

export function decimalPlaces(n: number): number {
  if (Number.isInteger(n)) return 0;
  const s = n.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return (s.split(".")[1] ?? "").length;
}

/** Formats a number as a plain decimal string (no exponent), at most `maxDp` decimals, trailing zeros stripped. */
export function decimalString(n: number, maxDp: number): string {
  if (!Number.isFinite(n)) throw new BrokerError("invalid_request", "cannot format a non-finite number");
  const fixed = n.toFixed(maxDp);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

export function validateOrderRequest(req: OrderRequest, ctx: OrderValidationContext = {}): OrderValidation {
  const bad = (code: "constraint_violation" | "invalid_request", reason: string): OrderValidation => ({ ok: false, code, reason });

  if (req.side !== "buy" && req.side !== "sell") return bad("invalid_request", `unsupported side ${String(req.side)}; short selling is never allowed`);
  if (!["market", "limit", "stop_market", "stop_limit"].includes(req.type)) return bad("invalid_request", `unsupported order type ${String(req.type)}`);
  if (typeof req.symbol !== "string" || !SYMBOL_RE.test(req.symbol)) return bad("invalid_request", "symbol must be an exact uppercase ticker");
  if (typeof req.refId !== "string" || req.refId.length === 0) return bad("invalid_request", "refId (idempotency key) is required");
  if (req.timeInForce !== "gfd" && req.timeInForce !== "gtc") return bad("invalid_request", `unsupported time in force ${String(req.timeInForce)}`);
  if (!["regular_hours", "extended_hours", "all_day_hours"].includes(req.marketHours)) return bad("invalid_request", `unsupported market hours ${String(req.marketHours)}`);

  const hasQty = positive(req.quantity);
  const hasDollars = positive(req.dollarAmount);
  if (hasQty === hasDollars) return bad("invalid_request", "exactly one of quantity or dollarAmount must be a positive number");

  const isLimit = req.type === "limit" || req.type === "stop_limit";
  const isStop = req.type === "stop_market" || req.type === "stop_limit";
  if (isLimit && !positive(req.limitPrice)) return bad("invalid_request", `${req.type} orders require a positive limitPrice`);
  if (!isLimit && req.limitPrice !== null) return bad("invalid_request", `${req.type} orders must not carry a limitPrice`);
  if (isStop && !positive(req.stopPrice)) return bad("invalid_request", `${req.type} orders require a positive stopPrice`);
  if (!isStop && req.stopPrice !== null) return bad("invalid_request", `${req.type} orders must not carry a stopPrice`);

  // Robinhood session rules: extended/overnight sessions are limit-only; market and stop orders are regular-hours only.
  if (req.marketHours !== "regular_hours" && req.type !== "limit") {
    return bad("constraint_violation", `${req.type} orders are only accepted in regular_hours (got ${req.marketHours}); use a limit order for that session`);
  }
  // Dollar-based orders: market + regular hours only.
  if (hasDollars && (req.type !== "market" || req.marketHours !== "regular_hours")) {
    return bad("constraint_violation", "dollarAmount orders must be type=market in regular_hours");
  }
  // Fractional shares: market + regular hours only, at most 6 decimals.
  if (hasQty && isFractional(req.quantity as number)) {
    if (req.type !== "market" || req.marketHours !== "regular_hours") return bad("constraint_violation", "fractional quantities are only accepted on market orders in regular_hours");
    if (decimalPlaces(req.quantity as number) > MAX_QUANTITY_DECIMALS) return bad("constraint_violation", `fractional quantities allow at most ${MAX_QUANTITY_DECIMALS} decimal places`);
  }
  // Long only: sells are bounded by shares_available_for_sells whenever positions are known.
  if (req.side === "sell" && ctx.sharesAvailable !== undefined) {
    if (ctx.sharesAvailable === null || ctx.sharesAvailable <= 0) return bad("constraint_violation", `no sellable shares of ${req.symbol}; short selling is never allowed`);
    if (hasQty && (req.quantity as number) > ctx.sharesAvailable + 1e-9) {
      return bad("constraint_violation", `sell quantity ${req.quantity} exceeds shares available for sells (${ctx.sharesAvailable})`);
    }
  }
  return { ok: true };
}

export function assertOrderRequestValid(req: OrderRequest, ctx: OrderValidationContext = {}): void {
  const v = validateOrderRequest(req, ctx);
  if (!v.ok) throw new BrokerError(v.code, v.reason, { details: { symbol: req.symbol, side: req.side, type: req.type } });
}

function approxEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Review-then-place invariant. Throws unless the review is ok, was taken within `maxAgeMs`
 * (default 60 s) and — when the review echoes the reviewed order — matches the request.
 */
export function assertReviewUsable(review: OrderReview, req: OrderRequest, nowMs: number, maxAgeMs: number = REVIEW_MAX_AGE_MS): void {
  if (!review || typeof review !== "object") throw new BrokerError("review_rejected", "placeOrder requires an OrderReview");
  if (review.ok !== true) {
    const blocking = review.alerts?.filter((a) => a.severity === "blocking").map((a) => a.code) ?? [];
    throw new BrokerError("review_rejected", `order review was not ok${blocking.length ? ` (${blocking.join(", ")})` : ""}`, { details: { blocking } });
  }
  const reviewedAt = Date.parse(review.reviewedAt);
  if (!Number.isFinite(reviewedAt)) throw new BrokerError("review_rejected", "order review has no valid reviewedAt timestamp");
  const age = nowMs - reviewedAt;
  if (age > maxAgeMs) throw new BrokerError("stale_review", `order review is ${Math.round(age / 1000)} s old (max ${Math.round(maxAgeMs / 1000)} s); review again before placing`, { details: { ageMs: age } });
  if (age < -5_000) throw new BrokerError("stale_review", "order review is timestamped in the future", { details: { ageMs: age } });

  const echo = typeof review.raw === "object" && review.raw !== null ? (review.raw as Record<string, unknown>) : null;
  if (echo) {
    const mismatches: string[] = [];
    if (typeof echo.symbol === "string" && echo.symbol !== req.symbol) mismatches.push("symbol");
    if (typeof echo.side === "string" && echo.side !== req.side) mismatches.push("side");
    if (typeof echo.type === "string" && echo.type !== req.type) mismatches.push("type");
    if (echo.quantity !== undefined && echo.quantity !== null && !approxEqual(numOrNull(echo.quantity), req.quantity)) mismatches.push("quantity");
    if (echo.dollar_amount !== undefined && echo.dollar_amount !== null && !approxEqual(numOrNull(echo.dollar_amount), req.dollarAmount)) mismatches.push("dollarAmount");
    if (echo.limit_price !== undefined && echo.limit_price !== null && !approxEqual(numOrNull(echo.limit_price), req.limitPrice)) mismatches.push("limitPrice");
    if (echo.stop_price !== undefined && echo.stop_price !== null && !approxEqual(numOrNull(echo.stop_price), req.stopPrice)) mismatches.push("stopPrice");
    if (mismatches.length > 0) throw new BrokerError("review_rejected", `order review does not match the request (${mismatches.join(", ")})`, { details: { mismatches } });
  }
}
