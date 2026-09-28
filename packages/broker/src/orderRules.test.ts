import { describe, expect, it } from "vitest";
import { BrokerError } from "./errors.js";
import { assertReviewUsable, decimalString, validateOrderRequest } from "./orderRules.js";
import { T0, orderRequest } from "./testing/fixtures.js";
import type { OrderReview } from "@yz/core";

describe("validateOrderRequest (Robinhood constraints)", () => {
  it("accepts a plain limit order", () => {
    expect(validateOrderRequest(orderRequest())).toEqual({ ok: true });
  });
  it("refuses fractional quantities unless market + regular_hours", () => {
    expect(validateOrderRequest(orderRequest({ quantity: 1.5 }))).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(validateOrderRequest(orderRequest({ type: "market", limitPrice: null, quantity: 1.5, marketHours: "extended_hours" }))).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(validateOrderRequest(orderRequest({ type: "market", limitPrice: null, quantity: 1.5 }))).toEqual({ ok: true });
    expect(validateOrderRequest(orderRequest({ type: "market", limitPrice: null, quantity: 0.1234567 }))).toMatchObject({ ok: false });
  });
  it("refuses non-limit orders outside regular hours", () => {
    expect(validateOrderRequest(orderRequest({ type: "market", limitPrice: null, marketHours: "extended_hours" }))).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(validateOrderRequest(orderRequest({ type: "stop_limit", stopPrice: 149, marketHours: "all_day_hours" }))).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(validateOrderRequest(orderRequest({ marketHours: "all_day_hours" }))).toEqual({ ok: true });
  });
  it("dollar amounts only with market + regular hours", () => {
    expect(validateOrderRequest(orderRequest({ quantity: null, dollarAmount: 100 }))).toMatchObject({ ok: false });
    expect(validateOrderRequest(orderRequest({ type: "market", limitPrice: null, quantity: null, dollarAmount: 100 }))).toEqual({ ok: true });
    expect(validateOrderRequest(orderRequest({ quantity: 1, dollarAmount: 100 }))).toMatchObject({ ok: false, code: "invalid_request" });
  });
  it("requires prices matching the type", () => {
    expect(validateOrderRequest(orderRequest({ limitPrice: null }))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(validateOrderRequest(orderRequest({ type: "stop_market", limitPrice: null }))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(validateOrderRequest(orderRequest({ type: "stop_market", limitPrice: null, stopPrice: 140 }))).toEqual({ ok: true });
  });
  it("never allows short sells: sells are bounded by shares_available_for_sells", () => {
    expect(validateOrderRequest(orderRequest({ side: "sell", quantity: 10 }), { sharesAvailable: 8 })).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(validateOrderRequest(orderRequest({ side: "sell", quantity: 8 }), { sharesAvailable: 8 })).toEqual({ ok: true });
    expect(validateOrderRequest(orderRequest({ side: "sell", quantity: 1 }), { sharesAvailable: null })).toMatchObject({ ok: false });
    expect(validateOrderRequest(orderRequest({ side: "sell_short" as never }))).toMatchObject({ ok: false, code: "invalid_request" });
  });
  it("formats decimal strings without exponents", () => {
    expect(decimalString(10, 6)).toBe("10");
    expect(decimalString(0.000001, 6)).toBe("0.000001");
    expect(decimalString(150.5, 4)).toBe("150.5");
    expect(decimalString(1e-7, 6)).toBe("0");
  });
});

describe("assertReviewUsable (review-then-place)", () => {
  const review = (o: Partial<OrderReview> = {}): OrderReview => ({ ok: true, estimatedCost: 1500, quote: null, alerts: [], raw: { symbol: "AAPL", side: "buy", type: "limit", quantity: "10", limit_price: "150" }, reviewedAt: new Date(T0).toISOString(), ...o });
  it("passes a fresh, ok, matching review", () => {
    expect(() => assertReviewUsable(review(), orderRequest(), T0 + 10_000)).not.toThrow();
  });
  it("refuses reviews older than 60 s", () => {
    expect(() => assertReviewUsable(review(), orderRequest(), T0 + 60_001)).toThrow(BrokerError);
    try {
      assertReviewUsable(review(), orderRequest(), T0 + 61_000);
    } catch (e) {
      expect((e as BrokerError).code).toBe("stale_review");
    }
  });
  it("refuses reviews that were not ok", () => {
    expect(() => assertReviewUsable(review({ ok: false, alerts: [{ code: "INSUFFICIENT_BUYING_POWER", severity: "blocking", message: "" }] }), orderRequest(), T0)).toThrow(/INSUFFICIENT_BUYING_POWER/);
  });
  it("refuses a review taken for a different order", () => {
    expect(() => assertReviewUsable(review(), orderRequest({ quantity: 20 }), T0)).toThrow(/quantity/);
    expect(() => assertReviewUsable(review(), orderRequest({ symbol: "MSFT" }), T0)).toThrow(/symbol/);
  });
});
