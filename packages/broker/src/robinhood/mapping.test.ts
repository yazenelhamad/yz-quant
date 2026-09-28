import { describe, expect, it } from "vitest";
import { CrossTenantError } from "@yz/core";
import type { BrokerOrder } from "@yz/core";
import { SCOPE_A, SCOPE_B, rawOrder, rawQuote } from "../testing/fixtures.js";
import { aggregateBars, deriveFills, mapBar, mapOrder, mapOrderState, mapOrderType, mapQuote, mapTradability, sessionFromTimestamp, toOrderArgs, cursorFromNext } from "./mapping.js";
import { OrderSchema, QuoteSchema, TradabilitySchema } from "./schemas.js";
import { orderRequest } from "../testing/fixtures.js";

const RECEIVED = "2026-09-28T14:30:00.000Z";

describe("order state and type mapping", () => {
  it("maps every documented state and treats anything else as unknown", () => {
    for (const s of ["new", "queued", "unconfirmed", "confirmed", "partially_filled", "filled", "cancelled", "rejected", "failed", "voided", "pending_cancelled", "partially_filled_rest_cancelled", "locating", "locate_failed"]) {
      expect(mapOrderState(s)).toBe(s);
    }
    expect(mapOrderState("settling")).toBe("unknown");
    expect(mapOrderState(undefined)).toBe("unknown");
    expect(mapOrderState(42)).toBe("unknown");
  });
  it("recovers the user-facing type from type + trigger", () => {
    expect(mapOrderType("market", "immediate", null, null)).toBe("market");
    expect(mapOrderType("limit", "immediate", "10", null)).toBe("limit");
    expect(mapOrderType("market", "stop", null, "9")).toBe("stop_market");
    expect(mapOrderType("limit", "stop", "10", "9")).toBe("stop_limit");
    expect(mapOrderType(undefined, undefined, "10", "9")).toBe("stop_limit");
  });
  it("maps an order object", () => {
    const o = mapOrder(OrderSchema.parse(rawOrder({ state: "partially_filled", cumulative_quantity: "4", average_price: "149.50", fees: "0.02", last_transaction_at: "2026-09-28T14:10:00Z", trigger: "stop", stop_price: "148" })), SCOPE_A, RECEIVED, "ref-1");
    expect(o).toMatchObject({ scope: SCOPE_A, brokerOrderId: "o-1", refId: "ref-1", state: "partially_filled", type: "stop_limit", quantity: 10, cumulativeQuantity: 4, limitPrice: 150, stopPrice: 148, averagePrice: 149.5, fees: 0.02, updatedAt: "2026-09-28T14:10:00.000Z", createdAt: "2026-09-28T14:00:00.000Z", placedAgent: "agentic" });
  });
  it("serialises order args as decimal strings", () => {
    expect(toOrderArgs(orderRequest({ type: "market", limitPrice: null, quantity: 0.5 }), "X1")).toEqual({ account_number: "X1", symbol: "AAPL", side: "buy", type: "market", quantity: "0.5", time_in_force: "gfd", market_hours: "regular_hours" });
    expect(toOrderArgs(orderRequest({ type: "stop_limit", stopPrice: 149.123456, limitPrice: 150.1 }), "X1")).toMatchObject({ quantity: "10", limit_price: "150.1", stop_price: "149.1235" });
    expect(toOrderArgs(orderRequest({ type: "market", limitPrice: null, quantity: null, dollarAmount: 100 }), "X1")).toMatchObject({ dollar_amount: "100" });
  });
  it("extracts cursors", () => {
    expect(cursorFromNext("https://api/orders/?cursor=abc&x=1")).toBe("abc");
    expect(cursorFromNext("")).toBeNull();
    expect(cursorFromNext("raw-token")).toBe("raw-token");
  });
});

describe("deriveFills", () => {
  const base: BrokerOrder = { scope: SCOPE_A, brokerOrderId: "o-1", refId: null, symbol: "AAPL", side: "buy", type: "limit", state: "confirmed", quantity: 25, cumulativeQuantity: 0, limitPrice: 105, stopPrice: null, averagePrice: null, fees: 0, timeInForce: "gfd", marketHours: "regular_hours", placedAgent: "agentic", createdAt: RECEIVED, updatedAt: RECEIVED };
  it("derives the first fill from a null previous snapshot", () => {
    const next = { ...base, state: "partially_filled" as const, cumulativeQuantity: 10, averagePrice: 100, updatedAt: "2026-09-28T14:31:00.000Z" };
    expect(deriveFills(null, next)).toEqual([{ scope: SCOPE_A, brokerOrderId: "o-1", symbol: "AAPL", side: "buy", quantity: 10, price: 100, fees: 0, derived: true, at: "2026-09-28T14:31:00.000Z" }]);
  });
  it("prices later fills from the change in notional", () => {
    const prev = { ...base, state: "partially_filled" as const, cumulativeQuantity: 10, averagePrice: 100 };
    const next = { ...base, state: "filled" as const, cumulativeQuantity: 25, averagePrice: 102, fees: 0.05 };
    const [fill] = deriveFills(prev, next);
    expect(fill?.quantity).toBe(15);
    expect(fill?.price).toBeCloseTo(103.333333, 5);
    expect(fill?.fees).toBeCloseTo(0.05);
  });
  it("produces nothing without progress or without a price, and refuses mixed orders/scopes", () => {
    const prev = { ...base, cumulativeQuantity: 10, averagePrice: 100 };
    expect(deriveFills(prev, { ...prev })).toEqual([]);
    expect(deriveFills(null, { ...base, cumulativeQuantity: 5, averagePrice: null })).toEqual([]);
    expect(() => deriveFills(prev, { ...prev, brokerOrderId: "o-2", cumulativeQuantity: 11 })).toThrow(/different orders/);
    expect(() => deriveFills({ ...prev, scope: SCOPE_B }, { ...prev, cumulativeQuantity: 11 })).toThrow(CrossTenantError);
  });
});

describe("quotes, bars, tradability", () => {
  it("maps a regular-hours quote with venue timestamp provenance", () => {
    const q = mapQuote(QuoteSchema.parse(rawQuote()), RECEIVED)!;
    expect(q).toMatchObject({ symbol: "AAPL", last: 151.1, bid: 151.05, ask: 151.15, previousClose: 149.8, session: "regular", instrumentState: "active", lastTradeAt: "2026-09-28T14:29:58.000Z" });
    expect(q.provenance).toEqual({ source: "robinhood_mcp:get_equity_quotes", observedAt: "2026-09-28T14:29:58.000Z", receivedAt: RECEIVED, reliability: 0.92 });
  });
  it("prefers a newer non-regular print, nulls zero bid/ask and skips never-traded instruments", () => {
    const q = mapQuote(QuoteSchema.parse(rawQuote({ last_non_reg_trade_price: "152.00", venue_last_non_reg_trade_time: "2026-09-28T21:15:00Z", bid_price: "0", ask_price: "0" })), RECEIVED)!;
    expect(q.last).toBe(152);
    expect(q.session).toBe("post");
    expect(q.bid).toBeNull();
    expect(q.ask).toBeNull();
    expect(mapQuote(QuoteSchema.parse(rawQuote({ has_traded: false })), RECEIVED)).toBeNull();
    expect(sessionFromTimestamp("2026-09-28T09:00:00Z")).toBe("pre");
    expect(sessionFromTimestamp("2026-09-28T03:00:00Z")).toBe("overnight");
  });
  it("maps bars, flags interpolation and aggregates 5-minute bars into 15-minute bars", () => {
    const raw = (t: string, o: number, c: number, interpolated = false) => ({ begins_at: t, open_price: String(o), close_price: String(c), high_price: String(Math.max(o, c) + 1), low_price: String(Math.min(o, c) - 1), volume: interpolated ? 0 : 100, interpolated });
    const bars = [raw("2026-09-28T14:30:00Z", 10, 11), raw("2026-09-28T14:35:00Z", 11, 12, true), raw("2026-09-28T14:40:00Z", 12, 13), raw("2026-09-28T14:45:00Z", 13, 14)].map((b) => mapBar(b, "AAPL", "5minute", "split", RECEIVED)!);
    expect(bars[1]?.interpolated).toBe(true);
    const agg = aggregateBars(bars, "15minute");
    expect(agg).toHaveLength(2);
    expect(agg[0]).toMatchObject({ interval: "15minute", time: "2026-09-28T14:30:00.000Z", open: 10, close: 13, high: 14, low: 9, volume: 200, interpolated: false });
    expect(agg[1]).toMatchObject({ time: "2026-09-28T14:45:00.000Z", open: 13, close: 14 });
  });
  it("maps tradability including the account-type rule and halts", () => {
    const t = mapTradability(TradabilitySchema.parse({ symbol: "GME", tradeable: true, state: "active", fractional_tradability: "tradable", all_day_tradability: "untradable", short_selling_tradability: "untradable", internal_halt_reason: "regulatory", internal_halt_sessions: ["regular_hours"], extended_hours_fractional_tradability: false, account_type_tradabilities: [{ account_type: "individual", account_type_tradability: "position_closing_only" }] }), "individual", RECEIVED);
    expect(t).toMatchObject({ tradeable: true, fractional: true, extendedHours: false, allDay: false, shortable: false, halted: true, haltReason: "regulatory", accountRule: "position_closing_only" });
    expect(mapTradability(TradabilitySchema.parse({ symbol: "X", tradeable: true, extended_hours_fractional_tradability: false }), "ira_roth", RECEIVED).accountRule).toBe("unknown");
  });
});
