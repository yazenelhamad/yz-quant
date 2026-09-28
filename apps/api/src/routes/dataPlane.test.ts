import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrderRequest, OrderReview, TenantScope } from "@yz/core";
import { createHarness, type Harness } from "../services/pipeline/testHarness.js";

let hz: Harness;
let scopeTrader: TenantScope;
let scopeAdmin: TenantScope;

beforeAll(async () => {
  hz = await createHarness();
  scopeTrader = { userId: hz.users.trader.id, brokerAccountId: hz.accounts.trader };
  scopeAdmin = { userId: hz.users.admin.id, brokerAccountId: hz.accounts.admin };
});
afterAll(async () => { await hz.close(); });

function order(scope: TenantScope, accountNumber: string, overrides: Partial<OrderRequest> = {}): OrderRequest {
  return { scope, accountNumber, symbol: "AAPL", side: "buy", type: "market", quantity: 10, dollarAmount: null, limitPrice: null, stopPrice: null, timeInForce: "gfd", marketHours: "regular_hours", refId: crypto.randomUUID(), tradeId: null, strategyId: null, strategyVersionId: null, ...overrides };
}

describe("broker sync through the simulated adapter", () => {
  it("writes a snapshot, positions, orders and a reconciliation; the response matches the contract", async () => {
    const t = await hz.login(hz.users.trader.email);
    const adapter = (await hz.broker.adapterFor(scopeTrader))!;
    const req = order(scopeTrader, "SIM-TRADE1");
    const review: OrderReview = await adapter.reviewOrder(req);
    expect(review.ok).toBe(true);
    await adapter.placeOrder(req, review);
    hz.clock.advance(2_000); // past the simulated latency so the market order fills
    const res = await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.trader}/broker/sync`, headers: t.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toBe(1);
    expect(body.orders).toBe(1);
    expect(body.portfolio.totalValue).toBeGreaterThan(0);
    expect(body.reconciliation).toEqual({ ok: true, mismatches: [], action: "none" });
    expect(body.simulated).toBe(true);
    const snap = await hz.ctx.repos.snapshots.latest(scopeTrader);
    expect(snap?.totalValue).toBe(body.portfolio.totalValue);
    const positions = await hz.ctx.repos.positions.list(scopeTrader);
    expect(positions.map((p) => p.symbol)).toEqual(["AAPL"]);
    expect(positions[0]!.markPrice).not.toBeNull();
    const rec = await hz.ctx.repos.reconciliations.latest(scopeTrader);
    expect(rec?.ok).toBe(true);
    const audit = await hz.ctx.repos.audit.recent({ brokerAccountId: hz.accounts.trader, category: "broker" });
    expect(audit.some((a) => a.action === "sync_requested")).toBe(true);
  });

  it("positions list marks the externally placed position and never fabricates missing data", async () => {
    const t = await hz.login(hz.users.trader.email);
    const res = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/positions`, headers: t.headers });
    expect(res.statusCode).toBe(200);
    const [p] = res.json().positions;
    expect(p.symbol).toBe("AAPL");
    expect(p.external).toBe(true);
    expect(p.tradeId).toBeNull();
    expect(p.strategyKey).toBeNull();
    expect(p.riskContribution).toBeNull(); // beta unknown → null, not 0
    expect(["fresh", "aging", "stale", "unknown"]).toContain(p.dataFreshness);
    expect(typeof p.unrealizedPnlPct === "number" || p.unrealizedPnlPct === null).toBe(true);
    const detail = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/positions/aapl`, headers: t.headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().thesis).toBeNull();
    expect(detail.json().reasonsToHold[0]).toMatch(/External position/);
    expect(detail.json().orders).toHaveLength(1);
    expect(detail.json().orders[0].raw).toBeUndefined();
    expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/positions/ZZZZ`, headers: t.headers })).statusCode).toBe(404);
  });

  it("orders: lists broker actions without raw payloads, cancels an open order and audits it", async () => {
    const t = await hz.login(hz.users.trader.email);
    const adapter = (await hz.broker.adapterFor(scopeTrader))!;
    const req = order(scopeTrader, "SIM-TRADE1", { type: "limit", limitPrice: 1, symbol: "MSFT" }); // will never fill
    await adapter.placeOrder(req, await adapter.reviewOrder(req));
    await hz.broker.sync(scopeTrader);
    const list = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/orders?limit=10`, headers: t.headers });
    expect(list.statusCode).toBe(200);
    const orders = list.json().orders as { id: string; symbol: string; state: string; raw?: unknown; external: boolean }[];
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.raw === undefined && o.external === true)).toBe(true);
    const openOrder = orders.find((o) => o.symbol === "MSFT")!;
    const filled = orders.find((o) => o.symbol === "AAPL")!;
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.trader}/orders/${filled.id}/cancel`, headers: t.headers })).statusCode).toBe(409);
    const cancel = await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.trader}/orders/${openOrder.id}/cancel`, headers: t.headers });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().accepted).toBe(true);
    const row = await hz.ctx.repos.orders.byId(scopeTrader, openOrder.id);
    expect(row?.cancelRequestedAt).not.toBeNull();
    const audit = await hz.ctx.repos.audit.recent({ brokerAccountId: hz.accounts.trader, category: "order" });
    expect(audit.find((a) => a.action === "cancel_requested")?.orderId).toBe(openOrder.id);
    await hz.broker.sync(scopeTrader);
    expect((await hz.ctx.repos.orders.byId(scopeTrader, openOrder.id))?.state).toBe("cancelled");
  });
});

describe("tenant scope on data-plane routes", () => {
  it("trader gets 403 on another user's account; admin may read but not write", async () => {
    const t = await hz.login(hz.users.trader.email);
    const a = await hz.login(hz.users.admin.email);
    for (const path of ["positions", "trades", "orders", "overview", "analytics", "journal", "rejections", "broker/status"]) {
      expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.admin}/${path}`, headers: t.headers })).statusCode, path).toBe(403);
      expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/${path}`, headers: a.headers })).statusCode, path).toBe(200);
      expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/${path}`, headers: t.headers })).statusCode, path).toBe(200);
    }
    const traderOrder = (await hz.ctx.repos.orders.recent(scopeTrader, 1))[0]!;
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.trader}/orders/${traderOrder.id}/cancel`, headers: a.headers })).statusCode).toBe(403);
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.trader}/broker/sync`, headers: a.headers })).statusCode).toBe(403);
    expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/positions` })).statusCode).toBe(401);
  });

  it("an order id from another scope is not found even for the owner of the other account", async () => {
    const a = await hz.login(hz.users.admin.email);
    const traderOrder = (await hz.ctx.repos.orders.recent(scopeTrader, 1))[0]!;
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.admin}/orders/${traderOrder.id}/cancel`, headers: a.headers })).statusCode).toBe(404);
  });
});

describe("overview and analytics", () => {
  it("returns explicit nulls and statuses for an account with no broker connection", async () => {
    const t = await hz.login(hz.users.trader.email);
    const rh = await hz.ctx.repos.accounts.create({ userId: hz.users.trader.id, kind: "robinhood_agentic", label: "RH", accountNumber: "pending-1" });
    const res = await hz.app.inject({ method: "GET", url: `/api/accounts/${rh.id}/overview`, headers: t.headers });
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.account.portfolio).toBeNull();
    expect(o.portfolio).toBeNull();
    expect(o.pnl).toEqual({ daily: null, total: null, dailyPct: null, totalPct: null });
    expect(o.positionsCount).toBe(0);
    expect(o.exposure).toMatchObject({ grossPct: null, bySector: {}, beta: null });
    expect(o.drawdownPct).toBeNull();
    expect(o.broker.status).toBe("not_connected");
    expect(o.dataQuality.quotes).toBe("unknown");
    expect(o.dataQuality.bars).toBe("unknown");
    expect(o.dataQuality.regime).toBe("unknown");
    expect(o.risk.utilization.capitalDeployed).toEqual({ used: null, limit: 0.6 });
    expect(o.risk.utilization.positions).toEqual({ used: 0, limit: 12 });
    expect(o.topOpportunities).toEqual([]);
    expect(o.upcomingCatalysts).toEqual([]);
    expect(o.activeStrategies).toEqual([]);
    const an = await hz.app.inject({ method: "GET", url: `/api/accounts/${rh.id}/analytics?period=week`, headers: t.headers });
    expect(an.statusCode).toBe(200);
    expect(an.json().performance.trades).toBe(0);
    expect(an.json().performance.winRate).toBeNull();
    expect(an.json().realizedPnlFromBroker).toMatchObject({ total: null, period: "week" });
    expect(an.json().realizedPnlFromBroker.note).toMatch(/not connected/);
    expect(an.json().equityCurve).toEqual([]);
    expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${rh.id}/analytics?period=decade`, headers: t.headers })).statusCode).toBe(422);
    const status = await hz.app.inject({ method: "GET", url: `/api/accounts/${rh.id}/broker/status`, headers: t.headers });
    expect(status.json()).toMatchObject({ status: "not_connected", agenticAccountNumberMasked: null, tools: null });
    // Connecting requires step-up and the right account kind.
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${rh.id}/broker/connect`, headers: t.headers })).statusCode).toBe(428);
    const stepped = await hz.login(hz.users.trader.email, { stepUp: true });
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${hz.accounts.trader}/broker/connect`, headers: stepped.headers })).statusCode).toBe(409);
  });

  it("overview for the synced simulated account carries positions, exposure and pct fields as fractions", async () => {
    const t = await hz.login(hz.users.trader.email);
    const res = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/overview`, headers: t.headers });
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.positionsCount).toBe(1);
    expect(o.exposure.grossPct).toBeGreaterThan(0);
    expect(o.exposure.grossPct).toBeLessThan(1);
    expect(o.exposure.bySector.unknown).toBeCloseTo(o.exposure.grossPct, 6);
    expect(o.risk.utilization.capitalDeployed.used).toBeCloseTo(o.exposure.grossPct, 6);
    expect(o.account.accountNumberMasked).toBe("••••ADE1");
    expect(o.broker.simulated).toBe(true);
    const an = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/analytics?period=all`, headers: t.headers });
    expect(an.json().equityCurve.length).toBeGreaterThan(0);
    expect(an.json().realizedPnlFromBroker).toMatchObject({ simulated: true });
  });
});

describe("trades, journal and rejections", () => {
  it("lists trades with strategy key and thesis summary, renders detail and journal", async () => {
    const t = await hz.login(hz.users.trader.email);
    const db = hz.ctx.repos.sessionsDb();
    const { strategies } = await import("@yz/db");
    await db.insert(strategies).values({ id: "strat-1", key: "xs_momentum", name: "Cross-sectional momentum", family: "trend_momentum" });
    const trade = await hz.ctx.repos.trades.create(scopeTrader, { mode: "shadow", symbol: "NVDA", strategyId: "strat-1", initialConfidence: 0.7, expectedEdge: 0.3, expectedDownsidePct: 0.05, regimeAtEntry: "bull_trend", invalidationPrice: 90, targetPrice: 130, expectedHoldingDays: 10 });
    const thesisId = await hz.ctx.repos.theses.create(scopeTrader, { tradeId: trade.id, symbol: "NVDA", strategyId: "strat-1", direction: "long", expectedEdge: 0.3, confidence: 0.7, calibratedConfidence: 0.62, marketRegime: "bull_trend", status: "active", thesis: { plainEnglish: "Momentum leader with expanding breadth.", entryLogic: "20d breakout", exitConditions: ["close below 90"], modelVotes: [{ agent: "quant", vote: "BUY", confidence: 0.7, note: "trend" }], similarHistoricalTrades: [] }, modelName: "test", modelVersion: "1", promptVersion: "1" });
    await hz.ctx.repos.trades.update(scopeTrader, trade.id, { thesisId });
    const list = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/trades?mode=shadow`, headers: t.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().trades[0]).toMatchObject({ id: trade.id, strategyKey: "xs_momentum", thesis: { thesisId, status: "active", calibratedConfidence: 0.62 } });
    expect(list.json().trades[0].userId).toBeUndefined();
    expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/trades?state=bogus`, headers: t.headers })).statusCode).toBe(422);
    const detail = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/trades/${trade.id}`, headers: t.headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().explanation).toBe("Momentum leader with expanding breadth.");
    expect(detail.json().events[0]).toMatchObject({ from: null, to: "candidate", note: "created" });
    expect(detail.json().review).toBeNull();
    expect(detail.json().lessons).toEqual([]);
    // Another user cannot see it, even by id.
    const a = await hz.login(hz.users.admin.email);
    expect((await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.admin}/trades/${trade.id}`, headers: a.headers })).statusCode).toBe(404);
    // Close the trade and check the journal (returnPct as a fraction).
    let s = trade;
    for (const to of ["analyzing", "approved", "order_submitted", "filled", "monitoring", "closed"] as const) {
      s = await hz.ctx.repos.trades.transition(scopeTrader, s.id, to, `test ${to}`, undefined, to === "filled" ? { openedAt: hz.clock.now.toISOString(), averageEntryPrice: 100, entryQuantity: 10, openQuantity: 10 } : to === "closed" ? { closedAt: hz.clock.now.toISOString(), averageExitPrice: 110, realizedPnl: 100, openQuantity: 0, exitReason: "target" } : undefined);
    }
    const journal = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/journal`, headers: t.headers });
    expect(journal.json().entries[0]).toMatchObject({ tradeId: trade.id, strategyKey: "xs_momentum", returnPct: 0.1, classification: null, lesson: null });
    const an = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/analytics?period=all&mode=shadow`, headers: t.headers });
    expect(an.json().performance).toMatchObject({ trades: 1, wins: 1, winRate: 1, avgReturnPct: 0.1 });
    expect(an.json().performance.netReturnPct).toBeCloseTo(0.1, 9);
    expect(an.json().byStrategy[0]).toMatchObject({ strategyKey: "xs_momentum", realizedPnl: 100 });
    await hz.ctx.repos.rejected.record(scopeTrader, { symbol: "TSLA", strategyId: "strat-1", reasons: ["insufficient_confidence"], detail: "conf 0.4 < 0.6", expectedEdge: 0.1, confidence: 0.4, regime: "range_bound", subsequentReturnPct: { "5d": 2.5 } });
    const rej = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/rejections`, headers: t.headers });
    expect(rej.json().rejections[0]).toMatchObject({ symbol: "TSLA", strategyKey: "xs_momentum", subsequentReturnPct: { "5d": 0.025 } });
  });
});

describe("shared market routes", () => {
  it("regime is null before any assessment, quotes validate symbols, universe lists defaults plus held symbols", async () => {
    const t = await hz.login(hz.users.trader.email);
    const regime = await hz.app.inject({ method: "GET", url: "/api/market/regime", headers: t.headers });
    expect(regime.statusCode).toBe(200);
    expect(regime.json().current).toBeNull();
    expect(regime.json().history).toEqual([]);
    expect((await hz.app.inject({ method: "GET", url: "/api/market/quotes", headers: t.headers })).statusCode).toBe(422);
    expect((await hz.app.inject({ method: "GET", url: "/api/market/quotes?symbols=bad!", headers: t.headers })).statusCode).toBe(422);
    const quotes = await hz.app.inject({ method: "GET", url: "/api/market/quotes?symbols=AAPL,MSFT", headers: t.headers });
    expect(quotes.statusCode).toBe(200);
    expect(quotes.json().quotes).toEqual([]); // no Robinhood connection: no shared market data source → nothing invented
    expect(quotes.json().missing).toEqual(["AAPL", "MSFT"]);
    const uni = await hz.app.inject({ method: "GET", url: "/api/market/universe", headers: t.headers });
    expect(uni.statusCode).toBe(200);
    const symbols = uni.json().symbols as { symbol: string; held: boolean; barFreshness: string }[];
    expect(symbols.find((s) => s.symbol === "AAPL")?.held).toBe(true);
    expect(symbols.find((s) => s.symbol === "SPY")?.barFreshness).toBe("unknown");
    expect(uni.json().count).toBeGreaterThanOrEqual(73);
    expect((await hz.app.inject({ method: "GET", url: "/api/market/universe" })).statusCode).toBe(401);
  });
});
