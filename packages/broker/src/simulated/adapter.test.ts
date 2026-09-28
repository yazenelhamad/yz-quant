import { describe, expect, it } from "vitest";
import { CrossTenantError } from "@yz/core";
import type { Quote } from "@yz/core";
import { ACCT_A, ACCT_B, SCOPE_A, SCOPE_B, orderRequest, quote, virtualClock } from "../testing/fixtures.js";
import { SimulatedBrokerAdapter, mulberry32 } from "./adapter.js";

function setup(opts: { cash?: number; slippageBps?: number; partial?: { probability: number; minFraction: number } | null; latencyMs?: number; rng?: () => number } = {}) {
  const clock = virtualClock();
  const prices = new Map<string, Quote>([["AAPL", quote("AAPL", 100, 99.9, 100.1)], ["MSFT", quote("MSFT", 50, 49.9, 50.1)]]);
  const quoteSource = { calls: 0, async getQuotes(symbols: readonly string[]) { this.calls += 1; return symbols.map((s) => prices.get(s)).filter((q): q is Quote => !!q); } };
  const adapter = new SimulatedBrokerAdapter({ scope: SCOPE_A, accountNumber: ACCT_A, quoteSource, clock: clock.now, initialCash: opts.cash ?? 10_000, slippageBps: opts.slippageBps ?? 5, partialFills: opts.partial ?? null, latencyMs: opts.latencyMs ?? 0, rng: opts.rng ?? mulberry32(7), initialPositions: [{ symbol: "MSFT", quantity: 20, averageCost: 40 }] });
  return { clock, prices, quoteSource, adapter };
}

describe("SimulatedBrokerAdapter", () => {
  it("labels everything as simulated", async () => {
    const { adapter } = setup();
    const [acct] = await adapter.getAccounts();
    expect(acct).toMatchObject({ simulated: true, kind: "simulated", agenticAllowed: true, provenance: { source: "simulated" }, raw: { simulated: true } });
    const portfolio = await adapter.getPortfolio();
    expect(portfolio).toMatchObject({ simulated: true, cash: 10_000, equityValue: 1000, totalValue: 11_000, provenance: { source: "simulated" } });
    const [pos] = await adapter.getPositions();
    expect(pos).toMatchObject({ simulated: true, symbol: "MSFT", quantity: 20, markPrice: 50, unrealizedPnl: 200, provenance: { source: "simulated" } });
    const review = await adapter.reviewOrder(orderRequest({ type: "market", limitPrice: null }));
    expect(review).toMatchObject({ simulated: true, ok: true, raw: { simulated: true } });
    const { order } = await adapter.placeOrder(orderRequest({ type: "market", limitPrice: null }), review);
    expect(order).toMatchObject({ simulated: true, raw: { simulated: true }, placedAgent: "simulated" });
    expect((await adapter.status()).detail).toMatch(/SIMULATED/);
  });
  it("refuses cross-tenant requests exactly like the live adapter", async () => {
    const { adapter } = setup();
    await expect(adapter.reviewOrder(orderRequest({ scope: SCOPE_B, accountNumber: ACCT_B }))).rejects.toBeInstanceOf(CrossTenantError);
    await expect(adapter.reviewOrder(orderRequest({ accountNumber: ACCT_B }))).rejects.toBeInstanceOf(CrossTenantError);
  });
  it("fills market orders at the ask plus slippage and updates cash/positions", async () => {
    const { adapter } = setup();
    const req = orderRequest({ type: "market", limitPrice: null, quantity: 10 });
    const review = await adapter.reviewOrder(req);
    const { order } = await adapter.placeOrder(req, review);
    expect(order.state).toBe("confirmed");
    const fills = await adapter.tick();
    expect(fills).toHaveLength(1);
    expect(fills[0]?.price).toBeCloseTo(100.15005, 5);
    expect(fills[0]?.derived).toBe(true);
    const filled = await adapter.getOrder(order.brokerOrderId);
    expect(filled).toMatchObject({ state: "filled", cumulativeQuantity: 10 });
    const portfolio = await adapter.getPortfolio();
    expect(portfolio.cash).toBeCloseTo(10_000 - 1001.5, 1);
    const aapl = (await adapter.getPositions()).find((p) => p.symbol === "AAPL");
    expect(aapl).toMatchObject({ quantity: 10, sharesAvailableForSells: 10 });
    expect(aapl?.averageCost).toBeCloseTo(100.15005, 5);
  });
  it("fills limit orders only when the quote crosses, at the better price", async () => {
    const { adapter, prices } = setup();
    const req = orderRequest({ quantity: 5, limitPrice: 99 });
    const { order } = await adapter.placeOrder(req, await adapter.reviewOrder(req));
    expect(await adapter.tick()).toEqual([]);
    expect((await adapter.getOrder(order.brokerOrderId))?.state).toBe("confirmed");
    prices.set("AAPL", quote("AAPL", 98.6, 98.5, 98.7));
    const [fill] = await adapter.tick();
    expect(fill?.price).toBe(98.7);
    expect((await adapter.getOrder(order.brokerOrderId))?.state).toBe("filled");
  });
  it("supports partial fills, cancellation and stop triggers deterministically", async () => {
    const seq = [0.1, 0.5, 0.9, 0.9, 0.9];
    const { adapter, prices } = setup({ partial: { probability: 0.5, minFraction: 0.5 }, rng: () => seq.shift() ?? 0.99 });
    const req = orderRequest({ type: "market", limitPrice: null, quantity: 10 });
    const { order } = await adapter.placeOrder(req, await adapter.reviewOrder(req));
    const [f1] = await adapter.tick();
    expect(f1?.quantity).toBe(7.5); // 0.5 + 0.5*(1-0.5) = 0.75 of 10
    expect((await adapter.getOrder(order.brokerOrderId))?.state).toBe("partially_filled");
    expect((await adapter.cancelOrder(order.brokerOrderId)).accepted).toBe(true);
    expect((await adapter.getOrder(order.brokerOrderId))?.state).toBe("partially_filled_rest_cancelled");
    expect((await adapter.cancelOrder(order.brokerOrderId)).accepted).toBe(false);

    const stop = orderRequest({ refId: "ref-stop", side: "sell", symbol: "MSFT", type: "stop_market", limitPrice: null, stopPrice: 48, quantity: 5 });
    const { order: stopOrder } = await adapter.placeOrder(stop, await adapter.reviewOrder(stop));
    expect(await adapter.tick()).toEqual([]);
    prices.set("MSFT", quote("MSFT", 47.5, 47.4, 47.6));
    const [f2] = await adapter.tick();
    expect(f2?.side).toBe("sell");
    expect(f2?.price).toBeCloseTo(47.4 * (1 - 0.0005), 6);
    expect((await adapter.getOrder(stopOrder.brokerOrderId))?.state).toBe("filled");
    const pnl = await adapter.getRealizedPnl("all");
    expect(pnl.totalReturns).toBeCloseTo((47.4 * 0.9995 - 40) * 5, 1);
    expect(adapter.getFills().every((f) => f.simulated && f.derived)).toBe(true);
  });
  it("enforces the review-then-place invariant and sellable/buying-power limits", async () => {
    const { adapter, clock } = setup({ cash: 500 });
    const req = orderRequest({ type: "market", limitPrice: null, quantity: 1 });
    const review = await adapter.reviewOrder(req);
    clock.advance(61_000);
    await expect(adapter.placeOrder(req, review)).rejects.toMatchObject({ code: "stale_review" });
    const big = orderRequest({ type: "market", limitPrice: null, quantity: 10 });
    const bigReview = await adapter.reviewOrder(big);
    expect(bigReview.ok).toBe(false);
    expect(bigReview.alerts[0]?.code).toBe("INSUFFICIENT_BUYING_POWER");
    await expect(adapter.placeOrder(big, bigReview)).rejects.toMatchObject({ code: "review_rejected" });
    await expect(adapter.reviewOrder(orderRequest({ side: "sell", symbol: "MSFT", quantity: 21 }))).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(adapter.reviewOrder(orderRequest({ side: "sell", symbol: "AAPL", quantity: 1 }))).rejects.toMatchObject({ code: "constraint_violation" });
  });
  it("respects latency and is idempotent on refId", async () => {
    const { adapter, clock } = setup({ latencyMs: 1_000 });
    const req = orderRequest({ type: "market", limitPrice: null, quantity: 1 });
    const review = await adapter.reviewOrder(req);
    const a = await adapter.placeOrder(req, review);
    const b = await adapter.placeOrder(req, review);
    expect(b.order.brokerOrderId).toBe(a.order.brokerOrderId);
    expect(await adapter.tick()).toEqual([]);
    clock.advance(1_000);
    expect(await adapter.tick()).toHaveLength(1);
  });
  it("has no market data beyond quotes unless a source is passed", async () => {
    const { adapter } = setup();
    expect((await adapter.getQuotes(["AAPL"]))[0]?.last).toBe(100);
    await expect(adapter.getBars(["AAPL"], { start: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "unsupported" });
  });
});
