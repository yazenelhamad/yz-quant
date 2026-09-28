import { describe, expect, it } from "vitest";
import { CrossTenantError } from "@yz/core";
import { BrokerError } from "../errors.js";
import { FakeMcpCaller } from "../testing/fakeMcpCaller.js";
import { ACCT_A, ACCT_B, SCOPE_A, SCOPE_B, loadObservedTools, orderRequest, quote, rawAccount, rawOrder, rawPortfolio, rawPosition, rawQuote, rawReview, virtualClock } from "../testing/fixtures.js";
import { RobinhoodAgenticAdapter, alertsFromOrderChecks } from "./adapter.js";
import { RobinhoodMcpClient } from "./mcpClient.js";

function setup(opts: { quoteLookup?: boolean } = {}) {
  const clock = virtualClock();
  const caller = new FakeMcpCaller(loadObservedTools());
  caller.on("get_accounts", () => ({ accounts: [rawAccount(), rawAccount({ account_number: ACCT_B, agentic_allowed: false, type: "margin", option_level: "" })] }));
  caller.on("get_portfolio", () => rawPortfolio());
  caller.on("get_equity_positions", () => ({ positions: [rawPosition()], next: "" }));
  caller.on("get_equity_orders", (args) => ({ orders: args.order_id ? [rawOrder({ id: String(args.order_id) })] : [rawOrder(), rawOrder({ id: "o-2", state: "settling" })], next: "" }));
  caller.on("review_equity_order", (args) => rawReview({ symbol: args.symbol, side: args.side, type: args.type, quantity: args.quantity, limit_price: args.limit_price }));
  caller.on("place_equity_order", (args) => ({ order: rawOrder({ id: "o-new", symbol: args.symbol, side: args.side, state: "queued", quantity: args.quantity ?? null, price: args.limit_price ?? null }) }));
  caller.on("cancel_equity_order", () => ({ accepted: true }));
  caller.on("get_equity_quotes", (args) => ({ results: (args.symbols as string[]).map((s) => ({ quote: rawQuote({ symbol: s }), close: null })) }));
  caller.on("get_equity_tradability", (args) => ({ results: (args.symbols as string[]).map((s) => ({ symbol: s, tradeable: true, extended_hours_fractional_tradability: false, fractional_tradability: "tradable", all_day_tradability: "tradable", account_type_tradabilities: [{ account_type: "individual", account_type_tradability: "tradable" }] })) }));
  caller.on("get_equity_historicals", (args) => ({ results: (args.symbols as string[]).map((s) => ({ symbol: s, interval: args.interval, bounds: "regular", bars: [{ begins_at: "2026-09-25T13:30:00Z", open_price: "1", close_price: "2", high_price: "3", low_price: "0.5", volume: 10, interpolated: false }, { begins_at: "2026-09-25T13:35:00Z", open_price: "2", close_price: "2", high_price: "2", low_price: "2", volume: 0, interpolated: true }] })) }));
  caller.on("get_equity_tax_lots", (args) => ({ symbol: args.symbol, tax_lots: [{ open_lot_id: "lot-1", quantity: "10", quantity_available: "8", is_selectable: true, cost_per_share: "150.25", open_date: "2026-01-05", term: "st" }], next: "" }));
  caller.on("get_realized_pnl", () => ({ account_number: ACCT_A, window: "month", display_currency: "USD", data_points: [{ start_time: "2026-09-01T00:00:00Z", end_time: "2026-09-28T00:00:00Z", realized_gain: "12.5", rate_of_realized_gain: "0.01", number_of_trades: 3 }], total_returns: "12.5", total_rate_of_return: "0.01" }));
  caller.on("search", () => ({ results: [{ instrument_id: "i1", symbol: "AAPL", name: "Apple Inc.", simple_name: "Apple" }], market_indexes: [] }));
  caller.on("get_equity_price_book", () => ({ books: [{ symbol: "AAPL", updated_at: "2026-09-28T14:29:59Z", asks: [{ price: "151.15", quantity: 300 }], bids: [{ price: "151.05", quantity: 200 }] }], errors: [] }));
  const client = new RobinhoodMcpClient({ connect: async () => caller, clock: clock.now, sleep: clock.sleep });
  const adapter = new RobinhoodAgenticAdapter({ scope: SCOPE_A, accountNumber: ACCT_A, client, clock: clock.now, quoteLookup: opts.quoteLookup ? async (symbols) => symbols.map((s) => quote(s, 160)) : null });
  return { clock, caller, client, adapter };
}

describe("tenant isolation", () => {
  it("User A can never submit an order to User B's account", async () => {
    const { adapter: adapterB, caller } = (() => {
      const s = setup();
      return { adapter: new RobinhoodAgenticAdapter({ scope: SCOPE_B, accountNumber: ACCT_B, client: s.client, clock: s.clock.now }), caller: s.caller };
    })();
    const reqFromA = orderRequest({ scope: SCOPE_A, accountNumber: ACCT_A });
    await expect(adapterB.reviewOrder(reqFromA)).rejects.toBeInstanceOf(CrossTenantError);
    const fakeReview = { ok: true, estimatedCost: 1, quote: null, alerts: [], raw: {}, reviewedAt: new Date().toISOString() };
    await expect(adapterB.placeOrder(reqFromA, fakeReview)).rejects.toBeInstanceOf(CrossTenantError);
    // same scope but the other account number
    await expect(adapterB.placeOrder(orderRequest({ scope: SCOPE_B, accountNumber: ACCT_A }), fakeReview)).rejects.toBeInstanceOf(CrossTenantError);
    // right account number but the wrong scope
    await expect(adapterB.placeOrder(orderRequest({ scope: SCOPE_A, accountNumber: ACCT_B }), fakeReview)).rejects.toBeInstanceOf(CrossTenantError);
    expect(caller.calls.filter((c) => c.name.includes("order"))).toHaveLength(0);
  });
  it("masks account numbers in cross-tenant errors", async () => {
    const { adapter } = setup();
    const err = (await adapter.reviewOrder(orderRequest({ accountNumber: ACCT_B })).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(CrossTenantError);
    expect(err.message).toContain("••••7890");
    expect(err.message).not.toContain(ACCT_B);
    expect(err.message).not.toContain(ACCT_A);
  });
  it("always sends the bound account number, never one from the request", async () => {
    const { adapter, caller } = setup();
    await adapter.getPortfolio();
    await adapter.getOrders();
    await adapter.cancelOrder("o-1");
    for (const c of caller.calls) expect(c.args.account_number).toBe(ACCT_A);
  });
});

describe("review-then-place", () => {
  it("reviews then places within 60 s with an idempotent ref_id", async () => {
    const { adapter, caller, clock } = setup();
    const req = orderRequest();
    const review = await adapter.reviewOrder(req);
    expect(review.ok).toBe(true);
    expect(review.quote).toEqual({ last: 151.1, bid: 151.05, ask: 151.15 });
    expect(review.estimatedCost).toBe(1500);
    expect(review.reviewedAt).toBe(new Date(clock.now()).toISOString());
    clock.advance(30_000);
    const { order } = await adapter.placeOrder(req, review);
    expect(order).toMatchObject({ brokerOrderId: "o-new", refId: "ref-0001", scope: SCOPE_A, state: "queued", symbol: "AAPL" });
    const place = caller.calls.find((c) => c.name === "place_equity_order")!;
    expect(place.args).toEqual({ account_number: ACCT_A, symbol: "AAPL", side: "buy", type: "limit", quantity: "10", limit_price: "150", time_in_force: "gfd", market_hours: "regular_hours", ref_id: "ref-0001" });
  });
  it("refuses stale reviews and not-ok reviews", async () => {
    const { adapter, caller, clock } = setup();
    const req = orderRequest();
    const review = await adapter.reviewOrder(req);
    clock.advance(60_001);
    await expect(adapter.placeOrder(req, review)).rejects.toMatchObject({ code: "stale_review" });
    await expect(adapter.placeOrder(req, { ...review, ok: false, reviewedAt: new Date(clock.now()).toISOString() })).rejects.toMatchObject({ code: "review_rejected" });
    await expect(adapter.placeOrder(orderRequest({ quantity: 11 }), { ...review, reviewedAt: new Date(clock.now()).toISOString() })).rejects.toMatchObject({ code: "review_rejected" });
    expect(caller.countOf("place_equity_order")).toBe(0);
  });
  it("turns blocking order_checks into ok=false and surfaces upstream review rejections", async () => {
    const { adapter, caller } = setup();
    caller.on("review_equity_order", () => rawReview({ order_checks: { alert_type: "INSUFFICIENT_BUYING_POWER", insufficient_buying_power_alert_details: { message: "Need $500 more" } } }));
    const review = await adapter.reviewOrder(orderRequest());
    expect(review.ok).toBe(false);
    expect(review.alerts).toEqual([{ code: "INSUFFICIENT_BUYING_POWER", severity: "blocking", message: "INSUFFICIENT_BUYING_POWER: Need $500 more" }]);
    expect(alertsFromOrderChecks({ alert_type: "PRICE_COLLAR" })[0]?.severity).toBe("warning");
    expect(alertsFromOrderChecks({})).toEqual([]);
    caller.toolErrorNext("review_equity_order", "account not agentic_allowed");
    const rejected = await adapter.reviewOrder(orderRequest());
    expect(rejected.ok).toBe(false);
    expect(rejected.alerts[0]?.code).toBe("UPSTREAM_REJECTED");
  });
  it("enforces fractional/session/sellable constraints before calling Robinhood", async () => {
    const { adapter, caller } = setup();
    await expect(adapter.reviewOrder(orderRequest({ quantity: 1.5 }))).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(adapter.reviewOrder(orderRequest({ type: "market", limitPrice: null, marketHours: "extended_hours" }))).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(adapter.reviewOrder(orderRequest({ side: "sell", quantity: 9 }))).rejects.toMatchObject({ code: "constraint_violation" }); // 8 available
    await expect(adapter.reviewOrder(orderRequest({ side: "sell", symbol: "MSFT", quantity: 1 }))).rejects.toMatchObject({ code: "constraint_violation" }); // no position
    expect(caller.countOf("review_equity_order")).toBe(0);
    const ok = await adapter.reviewOrder(orderRequest({ side: "sell", quantity: 8 }));
    expect(ok.ok).toBe(true);
  });
  it("does not retry a failed placement and reports mayHaveReached", async () => {
    const { adapter, caller } = setup();
    const req = orderRequest();
    const review = await adapter.reviewOrder(req);
    caller.failNext("place_equity_order", new TypeError("fetch failed"));
    const err = (await adapter.placeOrder(req, review).catch((e: unknown) => e)) as BrokerError;
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.code).toBe("transport");
    expect(err.mayHaveReached).toBe(true);
    expect(caller.countOf("place_equity_order")).toBe(1);
  });
});

describe("account and order reads", () => {
  it("maps accounts, portfolio, positions and orders (unknown states included)", async () => {
    const { adapter } = setup();
    const accounts = await adapter.getAccounts();
    expect(accounts.map((a) => [a.accountNumber, a.agenticAllowed, a.accountType, a.optionsEnabled])).toEqual([[ACCT_A, true, "limited_margin", true], [ACCT_B, false, "margin", false]]);
    const portfolio = await adapter.getPortfolio();
    expect(portfolio).toMatchObject({ scope: SCOPE_A, totalValue: 12500.5, cash: 2500.5, buyingPower: 2500.5, unleveragedBuyingPower: 2500.5, currency: "USD" });
    expect(portfolio.provenance.source).toBe("robinhood_mcp:get_portfolio");
    const positions = await adapter.getPositions();
    expect(positions[0]).toMatchObject({ symbol: "AAPL", quantity: 10, sharesAvailableForSells: 8, averageCost: 150.25, markPrice: null, marketValue: null, unrealizedPnl: null });
    const orders = await adapter.getOrders();
    expect(orders.map((o) => o.state)).toEqual(["confirmed", "unknown"]);
    expect(await adapter.getOrder("o-77")).toMatchObject({ brokerOrderId: "o-77" });
    expect((await adapter.cancelOrder("o-1")).accepted).toBe(true);
  });
  it("marks positions when a quoteLookup is provided", async () => {
    const { adapter } = setup({ quoteLookup: true });
    const [p] = await adapter.getPositions();
    expect(p).toMatchObject({ markPrice: 160, marketValue: 1600 });
    expect(p?.unrealizedPnl).toBeCloseTo(97.5);
  });
  it("fails closed when buying power is missing", async () => {
    const { adapter, caller } = setup();
    caller.on("get_portfolio", () => rawPortfolio({ buying_power: null }));
    await expect(adapter.getPortfolio()).rejects.toMatchObject({ code: "schema_drift" });
    caller.on("get_portfolio", () => ({ total_value: 1 }));
    await expect(adapter.getPortfolio()).rejects.toMatchObject({ code: "schema_drift" });
  });
  it("follows pagination cursors", async () => {
    const { adapter, caller } = setup();
    caller.on("get_equity_orders", (args) => (args.cursor ? { orders: [rawOrder({ id: "o-page2" })], next: "" } : { orders: [rawOrder({ id: "o-page1" })], next: "https://api.robinhood.com/orders/?cursor=c2" }));
    const orders = await adapter.getOrders({ since: "2026-09-01T00:00:00Z", state: "filled" });
    expect(orders.map((o) => o.brokerOrderId)).toEqual(["o-page1", "o-page2"]);
    expect(caller.calls[0]?.args).toMatchObject({ created_at_gte: "2026-09-01T00:00:00Z", state: "filled" });
    expect(caller.calls[1]?.args).toMatchObject({ cursor: "c2" });
  });
  it("maps tax lots and realized pnl", async () => {
    const { adapter } = setup();
    expect(await adapter.getTaxLots("AAPL")).toEqual([{ scope: SCOPE_A, symbol: "AAPL", lotId: "lot-1", quantity: 10, quantityAvailable: 8, costPerShare: 150.25, openDate: "2026-01-05", term: "st" }]);
    const pnl = await adapter.getRealizedPnl("month");
    expect(pnl).toMatchObject({ window: "month", totalReturns: 12.5, dataPoints: [{ realizedGain: 12.5, numberOfTrades: 3 }] });
  });
});

describe("market data", () => {
  it("chunks quotes by 20, tradability and bars by 10", async () => {
    const { adapter, caller } = setup();
    const symbols = Array.from({ length: 45 }, (_, i) => `S${i}`);
    const quotes = await adapter.getQuotes(symbols);
    expect(quotes).toHaveLength(45);
    expect(caller.calls.filter((c) => c.name === "get_equity_quotes").map((c) => (c.args.symbols as string[]).length)).toEqual([20, 20, 5]);
    await adapter.getTradability(symbols.slice(0, 25));
    expect(caller.calls.filter((c) => c.name === "get_equity_tradability").map((c) => (c.args.symbols as string[]).length)).toEqual([10, 10, 5]);
    const bars = await adapter.getBars(symbols.slice(0, 11), { start: "2026-09-25T00:00:00Z", interval: "5minute" });
    expect(caller.calls.filter((c) => c.name === "get_equity_historicals")).toHaveLength(2);
    expect(bars).toHaveLength(22);
    expect(bars[0]).toMatchObject({ interval: "5minute", time: "2026-09-25T13:30:00.000Z", adjusted: "split", interpolated: false });
    expect(bars[1]?.interpolated).toBe(true);
    expect(bars[0]?.provenance?.observedAt).toBe("2026-09-25T13:30:00.000Z");
  });
  it("requests 5-minute bars to build 15-minute bars", async () => {
    const { adapter, caller } = setup();
    const bars = await adapter.getBars(["AAPL"], { start: "2026-09-25T00:00:00Z", interval: "15minute", adjustment: "none" });
    expect(caller.calls.at(-1)?.args).toMatchObject({ interval: "5minute", adjustment_type: "none" });
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ interval: "15minute", open: 1, close: 2, volume: 10, adjusted: "none" });
  });
  it("maps the order book, search and tools list", async () => {
    const { adapter } = setup();
    expect(await adapter.getOrderBook("AAPL")).toMatchObject({ symbol: "AAPL", bids: [{ price: 151.05, size: 200 }], asks: [{ price: 151.15, size: 300 }] });
    expect((await adapter.search("apple")).equities[0]).toMatchObject({ symbol: "AAPL", instrumentId: "i1" });
    const tools = await adapter.listTools();
    expect(tools).toContain("place_equity_order");
    expect(tools).toHaveLength(81);
  });
});
