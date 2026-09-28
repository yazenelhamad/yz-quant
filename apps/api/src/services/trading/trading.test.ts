/**
 * Trading-cycle integration tests. Every market datapoint here is SYNTHETIC (seeded generators from
 * @yz/core), every broker is the SimulatedBrokerAdapter, and the model client is NotConfiguredClient
 * (the committee never runs; the deterministic path carries everything).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Bar, Quote, TenantScope } from "@yz/core";
import { CrossTenantError, EMPTY_STATS, FEATURE_VERSION, STRATEGY_LIBRARY, computeFeatures, computePerformanceStats, computeSurvival, marketSessionAt, trendingBars } from "@yz/core";
import { SimulatedBrokerAdapter, type BrokerAdapter } from "@yz/broker";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { NotConfiguredClient } from "@yz/intelligence";
import { loadEnv } from "../../config/env.js";
import { buildApp, createContext, type AppContext } from "../../http/app.js";
import { hashPassword } from "../../auth/password.js";
import { BrokerService } from "../brokerService.js";
import { MarketDataService, type MarketDataSource } from "../marketData.js";
import { Scheduler } from "../scheduler.js";
import { TRADING_JOBS, createTradingService, registerTradingJobs, registerTradingRoutes, tradingEvents, type TradingService } from "./index.js";
import { ensureStrategyRows } from "./strategyRows.js";
import type { EvaluationSnapshot } from "./types.js";

const KEY = Buffer.alloc(32, 9).toString("base64");
const PASSWORD = "CorrectHorse!Battery9";
const SYMBOL = "TEST";
const silent = { info() {}, warn() {}, error() {} };

// Monday 2026-09-28 10:30 ET: regular session, inside the default entry window.
let now = new Date("2026-09-28T14:30:00Z");
const clock = () => now;
const advance = (ms: number) => { now = new Date(now.getTime() + ms); };

// Synthetic quotes: price per symbol, observedAt = now unless a stale timestamp is forced.
const prices: Record<string, number> = {};
let quoteObservedAt: string | null = null;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fakeQuotes = async (symbols: readonly string[]): Promise<Quote[]> => symbols.filter((s) => prices[s] !== undefined).map((s) => {
  const last = round2(prices[s]!);
  const at = quoteObservedAt ?? now.toISOString();
  return { symbol: s, last, bid: round2(last - 0.01), ask: round2(last + 0.01), previousClose: last, lastTradeAt: at, session: "regular", instrumentState: "active", provenance: { source: "synthetic:test", observedAt: at, receivedAt: now.toISOString(), reliability: 1 } };
});
const source: MarketDataSource = { name: "synthetic:test", getQuotes: fakeQuotes, getBars: async () => [], getTradability: async () => [] };

let h: DatabaseHandle;
let ctx: AppContext;
let app: FastifyInstance;
let broker: BrokerService;
let trading: TradingService;
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let scopeA: TenantScope; // user A, heavy tech
let scopeB: TenantScope; // user B, light tech
let scopeD: TenantScope; // user B, min-confidence veto
let scopeE: TenantScope; // user B, kill switch
let scopeF: TenantScope; // user B, manual approval on a "robinhood" account with a live-like test adapter
let scopeG: TenantScope; // user B, stale quote
let tsmId: string;
let bars: Bar[];
let lastClose: number;
let sma200: number;

/** Re-label daily bars on weekdays ending at `endDate` (UTC midnight). */
function retimeDaily(src: Bar[], endDate: string): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse(`${endDate}T00:00:00Z`);
  for (let i = src.length - 1; i >= 0; i -= 1) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t -= 86_400_000;
    out.unshift({ ...src[i]!, time: new Date(t).toISOString(), adjusted: "split" });
    t -= 86_400_000;
  }
  return out;
}

async function makeAccount(userId: string, label: string, kind: "simulated" | "robinhood_agentic", autonomy: string, extra: Record<string, unknown> = {}): Promise<TenantScope> {
  const acc = await ctx.repos.accounts.create({ userId, kind, label, accountNumber: `${kind === "simulated" ? "SIM" : "RH"}-${label}`, status: "connected", agenticAllowed: true, accountType: "limited_margin", autonomyLevel: autonomy, tradingPaused: false, ...extra });
  return { userId, brokerAccountId: acc.id };
}

async function seedSnapshot(scope: TenantScope, totalValue: number, opts: { dailyPnl?: number; equity?: number } = {}): Promise<void> {
  const equity = opts.equity ?? 0;
  await ctx.repos.snapshots.record(scope, { asOf: now.toISOString(), totalValue, equityValue: equity, cash: totalValue - equity, buyingPower: totalValue - equity, unleveragedBuyingPower: totalValue - equity, dailyPnl: opts.dailyPnl ?? 0, totalPnl: 0, drawdownPct: 0, exposurePct: equity / totalValue, source: "synthetic:test" });
}

async function enableStrategy(scope: TenantScope, stage = "live_shadow", extra: Record<string, unknown> = {}): Promise<void> {
  await trading.store.upsertUserStrategySetting(scope, tsmId, { enabled: true, stage, capitalAllocation: 1, maxPositionPct: 0.05, maxLossPerTradePct: 0.01, ...extra });
}

async function seedRegime(): Promise<void> {
  const probabilities: Record<string, number> = { bull_trend: 0.45, bear_trend: 0.05, range_bound: 0.05, high_volatility: 0.05, low_volatility: 0.05, risk_on: 0.05, risk_off: 0.05, liquidity_shock: 0.05, event_driven: 0.05, sector_rotation: 0.05, momentum: 0.05, mean_reversion: 0.05 };
  await ctx.repos.market.recordRegime({ asOf: now.toISOString(), primary: "bull_trend", probabilities, confidence: 0.8, abnormality: 0.1, metrics: { spyTrend20: 0.02, spyTrend100: 0.05, realizedVol20: 0.15, vix: 15, breadthPctAbove50: 60, avgPairwiseCorrelation: 0.3, sectorDispersion: 0.03, momentumPersistence: 0.1, meanReversionScore: 0.2, volumeRatio: 1 }, familyBias: { trend_momentum: 0.6, mean_reversion: -0.5, statistical: 0.1, event: 0.2, options_volatility: 0, fundamental_variant: 0 }, explanation: ["synthetic test regime"], dataQuality: "fresh", engineVersion: "test" });
}

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  const cookie = ((Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]]) as string[]).find((c) => c?.startsWith("yz_session="))!.split(";")[0]!;
  const s = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
  return { cookie, csrf: s.json().csrfToken as string };
}

/** Wrap an adapter so every call is counted (and optionally made to fail once). */
function spyAdapter(inner: BrokerAdapter, opts: { failPlaceOnce?: boolean; kind?: "simulated" | "robinhood_agentic" } = {}): { adapter: BrokerAdapter; calls: Record<string, number>; placeRequests: { refId: string }[] } {
  const calls: Record<string, number> = {};
  const placeRequests: { refId: string }[] = [];
  let failed = false;
  const adapter = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "binding") return opts.kind ? { ...target.binding, kind: opts.kind } : target.binding;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1;
        if (prop === "placeOrder") {
          placeRequests.push({ refId: (args[0] as { refId: string }).refId });
          if (opts.failPlaceOnce && !failed) { failed = true; throw new Error("simulated transport failure after the broker accepted"); }
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { adapter, calls, placeRequests };
}

beforeAll(async () => {
  h = await createDatabase("pglite://memory");
  await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: KEY, SESSION_SECRET: "test-session-secret-0123456789", SCHEDULER_ENABLED: "false", DATABASE_URL: "pglite://memory", LOG_LEVEL: "silent", AUTH_RATE_LIMIT_MAX: "1000", GLOBAL_RATE_LIMIT_MAX: "100000" });
  ctx = createContext(env, h, silent);
  broker = new BrokerService(env, ctx.repos, ctx.audit, silent, { quoteSource: { getQuotes: fakeQuotes }, clock });
  const marketData = new MarketDataService(ctx.repos.market, async () => source, silent, clock);
  trading = createTradingService(ctx, { broker, marketData, modelClient: new NotConfiguredClient(), clock, log: silent });
  app = await buildApp(ctx, [registerTradingRoutes]);

  { const u = await ctx.repos.users.create({ email: "a@example.com", displayName: "A", role: "admin", passwordHash: await hashPassword(PASSWORD) }); userA = { id: u.id, email: u.email! }; }
  { const u = await ctx.repos.users.create({ email: "b@example.com", displayName: "B", role: "trader", passwordHash: await hashPassword(PASSWORD) }); userB = { id: u.id, email: u.email! }; }
  scopeA = await makeAccount(userA.id, "A", "simulated", "fully_autonomous");
  scopeB = await makeAccount(userB.id, "B", "simulated", "fully_autonomous");
  scopeD = await makeAccount(userB.id, "D", "simulated", "fully_autonomous");
  scopeE = await makeAccount(userB.id, "E", "simulated", "fully_autonomous");
  scopeF = await makeAccount(userB.id, "F", "robinhood_agentic", "manual_approval", { reconciliationOk: true, lastReconciledAt: now.toISOString() });
  scopeG = await makeAccount(userB.id, "G", "simulated", "fully_autonomous");

  // ---- synthetic market data (labelled synthetic; never mixed with real data) ----
  bars = retimeDaily(trendingBars(SYMBOL, 320, 0.003, 9, "2024-01-02T00:00:00Z"), "2026-09-28");
  lastClose = bars[bars.length - 1]!.close;
  sma200 = bars.slice(-200).reduce((s, b) => s + b.close, 0) / 200;
  prices[SYMBOL] = lastClose;
  prices["TECH1"] = 50;
  prices["UTIL1"] = 40;
  await ctx.repos.market.upsertBars(bars.map((b) => ({ symbol: b.symbol, interval: "day", time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, interpolated: false, adjusted: "split", source: "synthetic:test", receivedAt: now.toISOString() })));
  await ctx.repos.market.upsertInstrument({ symbol: SYMBOL, name: "Synthetic Test Co", sector: "Technology", assetClass: "equity", state: "active", tradeable: true, fractional: false, beta: 1.1, avgDollarVolume20: 2e8 });
  await ctx.repos.market.upsertInstrument({ symbol: "TECH1", name: "Synthetic Tech One", sector: "Technology", assetClass: "equity", state: "active", tradeable: true, fractional: false, beta: 1.2, avgDollarVolume20: 5e8 });
  await ctx.repos.market.upsertInstrument({ symbol: "UTIL1", name: "Synthetic Utility", sector: "Utilities", assetClass: "equity", state: "active", tradeable: true, fractional: false, beta: 0.5, avgDollarVolume20: 1e8 });
  const quote = (await fakeQuotes([SYMBOL]))[0]!;
  const fs = computeFeatures({ asOf: now.toISOString(), bars, quote });
  await ctx.repos.market.upsertFeatures({ symbol: SYMBOL, asOf: now.toISOString(), featureVersion: FEATURE_VERSION, values: fs.values, freshness: fs.freshness });
  await seedRegime();

  // ---- strategies: seed rows, enable time_series_momentum for every test account ----
  const rows = await ensureStrategyRows(h.db);
  tsmId = rows.get("time_series_momentum")!.id;
  for (const s of [scopeA, scopeB, scopeD, scopeE, scopeG]) await enableStrategy(s);
  await enableStrategy(scopeF, "limited_live");
  await trading.store.upsertUserStrategySetting(scopeD, tsmId, { minConfidence: 0.99 });

  // ---- portfolios: A is heavy in Technology, B is empty ----
  await seedSnapshot(scopeA, 100_000, { equity: 15_000 });
  await ctx.repos.positions.replaceAll(scopeA, [{ symbol: "TECH1", assetClass: "equity", quantity: 300, intradayQuantity: 0, sharesAvailableForSells: 300, averageCost: 45, markPrice: 50, marketValue: 15_000, unrealizedPnl: 1_500, asOf: now.toISOString(), source: "synthetic:test" }]);
  for (const s of [scopeB, scopeD, scopeF, scopeG]) await seedSnapshot(s, 100_000);
  await seedSnapshot(scopeE, 97_000, { dailyPnl: -3_000, equity: 4_000 });
  await ctx.repos.positions.replaceAll(scopeE, [{ symbol: "UTIL1", assetClass: "equity", quantity: 100, intradayQuantity: 0, sharesAvailableForSells: 100, averageCost: 42, markPrice: 40, marketValue: 4_000, unrealizedPnl: -200, asOf: now.toISOString(), source: "synthetic:test" }]);
  await ctx.repos.reconciliations.record(scopeF, { ok: true, positionMismatches: [], orderMismatches: [], cashDifference: 0, unexpectedPositions: [], action: "none", detail: null, at: now.toISOString() });
});
afterAll(async () => { await app.close(); await h.close(); });


/** Put the live price back inside a candidate's stop/target corridor (near the stop, so reward/risk is healthy): the geometry check re-measures levels from the live price. */
function priceInsideCorridor(candidate: { ensemble: unknown }): number {
  const v = (candidate.ensemble as { view?: { invalidationPrice?: number | null; targetPrice?: number | null } }).view;
  const stop = v?.invalidationPrice ?? null, target = v?.targetPrice ?? null;
  if (stop === null || target === null) throw new Error("candidate view has no levels");
  return round2(stop + 0.3 * (target - stop));
}

describe("trading cycle (synthetic data, simulated broker)", () => {
  let candidateId: string;
  let evalA: EvaluationSnapshot;
  let evalB: EvaluationSnapshot;
  let spyB: ReturnType<typeof spyAdapter>;
  let spyA: ReturnType<typeof spyAdapter>;
  const closedEvents: { scope: TenantScope; tradeId: string }[] = [];
  tradingEvents.on("tradeClosed", (scope, tradeId) => closedEvents.push({ scope, tradeId }));

  it("seeds strategy rows idempotently and generates at least one candidate", async () => {
    expect(marketSessionAt(now)).toBe("regular");
    const first = await ensureStrategyRows(h.db);
    const second = await ensureStrategyRows(h.db);
    expect(first.size).toBe(STRATEGY_LIBRARY.length);
    expect(second.size).toBe(STRATEGY_LIBRARY.length);
    expect([...second.values()].every((r) => r.currentVersionId && r.stage === "live_shadow")).toBe(true);

    const summary = await trading.generateCandidates(now);
    expect(summary.strategies).toBeGreaterThanOrEqual(1);
    expect(summary.symbols).toBe(1);
    expect(summary.created.length).toBeGreaterThanOrEqual(1);
    const c = summary.created.find((x) => x.symbol === SYMBOL && x.strategyKey === "time_series_momentum")!;
    expect(c).toBeTruthy();
    expect(c.direction).toBe("long");
    expect(c.expectedUpsidePct).toBeGreaterThan(0);
    expect(c.regimeFit).toBeGreaterThan(0.5);
    candidateId = c.id;
    // signals persisted; a second run does not duplicate the open candidate
    const again = await trading.generateCandidates(now);
    expect(again.created).toHaveLength(0);
    expect(again.skipped["candidate_already_open"]).toBeGreaterThanOrEqual(1);
    expect(summary.signals).toBeGreaterThanOrEqual(1);
  });

  it("evaluates the same candidate differently for a heavy-tech and a light-tech account", async () => {
    const candidate = (await trading.store.candidateById(candidateId))!;
    // Put a spy on B's adapter BEFORE A is evaluated/executed: A's flow must never touch it.
    spyB = spyAdapter((await broker.adapterFor(scopeB))!);
    broker.registry.set(scopeB, spyB.adapter);
    spyA = spyAdapter((await broker.adapterFor(scopeA))!, { failPlaceOnce: true });
    broker.registry.set(scopeA, spyA.adapter);

    evalA = await trading.evaluateCandidateForAccount(scopeA, candidate, { identityVerified: true });
    evalB = await trading.evaluateCandidateForAccount(scopeB, candidate, { identityVerified: true });
    expect(evalA.finalStatus).toBe("shadow");
    expect(evalB.finalStatus).toBe("shadow");
    expect(evalA.mode).toBe("shadow");
    expect(evalA.thesisId).toBeTruthy();
    expect(evalA.risk?.verdict).toMatch(/approve|reduce/);
    expect(evalA.quantity).toBeGreaterThan(0);
    // Both shadow books take the incubation floor (one share each); the fit still scales the Kelly target.
    expect(evalB.quantity).toBeGreaterThanOrEqual(evalA.quantity);
    expect(evalA.fit!.sizeMultiplier).toBeLessThan(evalB.fit!.sizeMultiplier); // heavy tech account is scaled down
    expect(evalA.fit!.fitScore).toBeLessThan(evalB.fit!.fitScore);
    expect(evalA.fit!.notes.some((n) => /sector Technology/.test(n))).toBe(true);
    // journaled: risk decision + evaluation row + stored thesis (validated)
    const decisions = await ctx.repos.riskDecisions.recent(scopeA, 5);
    expect(decisions.some((d) => d.candidateId === candidateId && d.action === "enter")).toBe(true);
    const thesisRow = await ctx.repos.theses.byId(scopeA, evalA.thesisId!);
    expect(thesisRow?.status).toBe("active");
    expect((thesisRow?.thesis as { plainEnglish: string }).plainEnglish).toMatch(/We are buying TEST/);
    // no order yet: evaluation never touches a broker
    expect(spyA.calls["placeOrder"] ?? 0).toBe(0);
    expect(spyB.calls["placeOrder"] ?? 0).toBe(0);
  });

  it("executes in shadow with an idempotent refId (re-sent on retry) and never through the other account's adapter", async () => {
    const resA = await trading.openTrade(scopeA, evalA);
    expect(resA.ok).toBe(true);
    if (!resA.ok) return;
    expect(resA.trade.state).toBe("order_submitted");
    expect(resA.order.mode).toBe("shadow");
    expect(resA.order.brokerOrderId).toBeTruthy();
    expect(resA.order.reviewedAt).toBeTruthy();
    // the broker was asked twice (first attempt failed after acceptance) with the SAME refId; one orders row
    expect(spyA.placeRequests).toHaveLength(2);
    expect(new Set(spyA.placeRequests.map((r) => r.refId)).size).toBe(1);
    expect(spyA.placeRequests[0]!.refId).toBe(resA.order.refId);
    expect((await ctx.repos.orders.forTrade(scopeA, resA.trade.id))).toHaveLength(1);
    // duplicate protection: evaluating and executing the same candidate again yields the same trade/order
    const replay = await trading.evaluateCandidateForAccount(scopeA, evalA.candidate, { identityVerified: true });
    expect(replay.replay).toBe(true);
    const again = await trading.openTrade(scopeA, evalA);
    expect(again.ok && again.duplicate).toBe(true);
    expect((await ctx.repos.orders.forTrade(scopeA, resA.trade.id))).toHaveLength(1);
    expect(spyA.placeRequests).toHaveLength(2);
    // wrong-account proof: B's adapter untouched; A's rows carry A's scope; cross-scope execution refused
    expect(spyB.calls["reviewOrder"] ?? 0).toBe(0);
    expect(spyB.calls["placeOrder"] ?? 0).toBe(0);
    expect(await ctx.repos.orders.recent(scopeB, 10)).toHaveLength(0);
    const row = await ctx.repos.orders.byId(scopeA, resA.order.id);
    expect(row?.userId).toBe(userA.id);
    expect(await ctx.repos.orders.byId(scopeB, resA.order.id)).toBeUndefined();
    await expect(trading.openTrade(scopeA, evalB)).rejects.toBeInstanceOf(CrossTenantError);
    // B executes on its own adapter
    const resB = await trading.openTrade(scopeB, evalB);
    expect(resB.ok).toBe(true);
    expect(spyB.calls["placeOrder"]).toBe(1);
  });

  it("monitors fills (repricing the resting limit), manages the position and closes it, emitting tradeClosed", async () => {
    // Limit at mid rests below the ask: nothing fills yet.
    let m = await trading.ordersMonitor(scopeA);
    expect(m.fills).toBe(0);
    // After the reprice window the monitor lifts the limit to the ask (new refId, reprices + 1) and the book fills it.
    advance(61_000);
    m = await trading.ordersMonitor(scopeA);
    expect(m.reprices).toBe(1);
    const tradeA = (await ctx.repos.trades.list(scopeA, { limit: 5 })).find((t) => t.candidateId === candidateId)!;
    const ordersA = await ctx.repos.orders.forTrade(scopeA, tradeA.id);
    expect(ordersA).toHaveLength(2);
    expect(new Set(ordersA.map((o) => o.refId)).size).toBe(2);
    expect(ordersA.find((o) => o.reprices === 1)).toBeTruthy();
    advance(1_000);
    m = await trading.ordersMonitor(scopeA);
    expect(m.fills).toBeGreaterThanOrEqual(1);
    const filled = (await ctx.repos.trades.byId(scopeA, tradeA.id))!;
    expect(filled.state).toBe("monitoring");
    expect(filled.openQuantity).toBe(filled.entryQuantity);
    expect(filled.averageEntryPrice).toBeGreaterThan(0);
    expect(filled.openedAt).toBeTruthy();
    expect((await ctx.repos.executionOutcomes.recent(scopeA, 5)).length).toBeGreaterThanOrEqual(1);
    // Same for B.
    await trading.ordersMonitor(scopeB);
    advance(1_000);
    await trading.ordersMonitor(scopeB);

    // Nothing to do while the thesis holds.
    let pm = await trading.positionsManage(scopeA);
    expect(pm.exits).toBe(0);
    expect(pm.holds).toBe(1);
    // Price breaks the invalidation level: fast brain EXIT -> risk engine exit path -> market sell.
    prices[SYMBOL] = round2(sma200 * 0.98);
    advance(31_000);
    pm = await trading.positionsManage(scopeA);
    expect(pm.exits).toBe(1);
    const exiting = (await ctx.repos.trades.byId(scopeA, tradeA.id))!;
    expect(exiting.state).toBe("exit_requested");
    expect(exiting.maxAdverseExcursionPct).toBeLessThan(0);
    const sell = (await ctx.repos.orders.forTrade(scopeA, tradeA.id)).find((o) => o.side === "sell")!;
    expect(sell.mode).toBe("shadow");
    expect((await ctx.repos.riskDecisions.recent(scopeA, 10)).some((d) => d.action === "exit" && d.tradeId === tradeA.id && d.verdict === "approve")).toBe(true);
    advance(1_000);
    m = await trading.ordersMonitor(scopeA);
    expect(m.closed).toBe(1);
    const closed = (await ctx.repos.trades.byId(scopeA, tradeA.id))!;
    expect(closed.state).toBe("closed");
    expect(closed.openQuantity).toBe(0);
    expect(closed.closedAt).toBeTruthy();
    expect(closed.realizedPnl).toBeLessThan(0);
    expect(closed.exitReason).toMatch(/fast brain EXIT/);
    expect(closedEvents.some((e) => e.tradeId === tradeA.id && e.scope.userId === scopeA.userId && e.scope.brokerAccountId === scopeA.brokerAccountId)).toBe(true);
    expect(closedEvents.some((e) => e.scope.brokerAccountId === scopeB.brokerAccountId)).toBe(false);
    const thesis = await ctx.repos.theses.byId(scopeA, closed.thesisId!);
    const text = trading.explainTrade(closed, thesis!.thesis as never, (await ctx.repos.riskDecisions.recent(scopeA, 20)).filter((d) => d.candidateId === candidateId || d.tradeId === tradeA.id).map((d) => ({ action: d.action, verdict: d.verdict, reasons: d.reasons, approvedQuantity: d.approvedQuantity, requestedQuantity: d.requestedQuantity, decidedAt: d.decidedAt, failedClosed: d.failedClosed })));
    expect(text).toMatch(/We are buying TEST/);
    expect(text).toMatch(/The trade is closed/);
    prices[SYMBOL] = lastClose;
  });

  it("risk veto: a candidate failing the strategy's minimum confidence is recorded in rejected_trades and never reaches the adapter", async () => {
    const spyD = spyAdapter((await broker.adapterFor(scopeD))!);
    broker.registry.set(scopeD, spyD.adapter);
    const candidate = (await trading.store.candidateById(candidateId))!;
    prices[SYMBOL] = priceInsideCorridor(candidate);
    advance(61_000); // past the quote cache so the evaluation sees the new price
    const ev = await trading.evaluateCandidateForAccount(scopeD, candidate, { identityVerified: true });
    expect(ev.finalStatus).toBe("rejected");
    expect(ev.rejectionReasons).toContain("insufficient_confidence");
    expect(ev.probability?.breakeven).not.toBeNull();
    expect(ev.calibratedConfidence).toBeLessThan(0.6); // an honest win probability, not an asserted one
    expect(ev.risk?.verdict).toBe("reject");
    const rejected = await ctx.repos.rejected.recent(scopeD, 5);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reasons).toContain("insufficient_confidence");
    expect(rejected[0]!.candidateId).toBe(candidateId);
    const res = await trading.openTrade(scopeD, ev);
    expect(res.ok).toBe(false);
    expect(spyD.calls["reviewOrder"] ?? 0).toBe(0);
    expect(spyD.calls["placeOrder"] ?? 0).toBe(0);
    expect(await ctx.repos.orders.recent(scopeD, 5)).toHaveLength(0);
  });

  it("a stored evaluation is replayed unless the caller asks for a re-evaluation, which records a fresh decision", async () => {
    const candidate = (await trading.store.candidateById(candidateId))!;
    const replayed = await trading.evaluateCandidateForAccount(scopeD, candidate, { identityVerified: true });
    expect(replayed.replay).toBe(true);
    const before = (await ctx.repos.rejected.recent(scopeD, 50)).length;
    advance(1_000);
    const redone = await trading.evaluateCandidateForAccount(scopeD, candidate, { identityVerified: true, reevaluate: true });
    expect(redone.replay).toBe(false);
    expect(redone.finalStatus).toBe("rejected");
    expect(redone.evaluatedAt).toBe(now.toISOString());
    expect((await ctx.repos.rejected.recent(scopeD, 50)).length).toBe(before + 1);
    expect((await trading.store.evaluationForCandidate(scopeD, candidateId))?.detail).toMatchObject({ evaluatedAt: now.toISOString() });
  });

  it("kill switch (daily loss) blocks entries but the close route still exits through the risk engine", async () => {
    const accE = (await ctx.repos.accounts.forScope(scopeE))!;
    const bookE = new SimulatedBrokerAdapter({ scope: scopeE, accountNumber: accE.accountNumber, quoteSource: { getQuotes: fakeQuotes }, clock: () => now.getTime(), initialCash: 93_000, initialPositions: [{ symbol: "UTIL1", quantity: 100, averageCost: 42 }] });
    broker.registry.set(scopeE, bookE);
    const cycle = await trading.tradingCycle(scopeE);
    expect(cycle.refused).toBe(false);
    expect(cycle.killSwitch?.triggered).toBe(true);
    expect(cycle.killSwitch?.reasons).toContain("daily_loss_limit");
    expect(cycle.evaluated).toBe(1);
    expect(cycle.rejected).toBe(1);
    const ks = await ctx.repos.killSwitches.get(scopeE);
    expect(ks?.active).toBe(true);
    expect((await ctx.repos.accounts.forScope(scopeE))?.tradingPaused).toBe(true);
    const rejected = await ctx.repos.rejected.recent(scopeE, 5);
    expect(rejected[0]!.reasons).toContain("kill_switch");
    expect(await ctx.repos.orders.recent(scopeE, 5)).toHaveLength(0);
    // the same cycle again is idempotent: no new evaluation, no re-trigger
    const cycle2 = await trading.tradingCycle(scopeE);
    expect(cycle2.killSwitch?.triggered).toBe(false);
    expect(cycle2.evaluated).toBe(0);

    const { cookie, csrf } = await login(userB.email);
    const res = await app.inject({ method: "POST", url: `/api/accounts/${scopeE.brokerAccountId}/positions/UTIL1/close`, headers: { cookie, "x-csrf-token": csrf }, payload: { reason: "human exit during kill switch" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tradeId: string; orderId: string; quantity: number };
    expect(body.quantity).toBe(100);
    const order = (await ctx.repos.orders.byId(scopeE, body.orderId))!;
    expect(order.side).toBe("sell");
    expect(order.brokerOrderId).toBeTruthy();
    const trade = (await ctx.repos.trades.byId(scopeE, body.tradeId))!;
    expect(trade.state).toBe("exit_requested");
    expect((await ctx.repos.riskDecisions.recent(scopeE, 5)).some((d) => d.action === "exit" && d.verdict === "approve" && d.reasons.some((r) => /kill_switch_account/.test(r)))).toBe(true);
    // a second close is refused (order already working) and a foreign user cannot close it
    const dup = await app.inject({ method: "POST", url: `/api/accounts/${scopeE.brokerAccountId}/positions/UTIL1/close`, headers: { cookie, "x-csrf-token": csrf }, payload: { reason: "again" } });
    expect(dup.statusCode).toBe(409);
    const a = await login(userA.email);
    const foreign = await app.inject({ method: "POST", url: `/api/accounts/${scopeE.brokerAccountId}/positions/UTIL1/close`, headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, payload: { reason: "admin cannot trade another account" } });
    expect(foreign.statusCode).toBe(403);
  });

  it("a simulated order unknown to a fresh book (process restart) is closed as cancelled, never assumed filled", async () => {
    const accE = (await ctx.repos.accounts.forScope(scopeE))!;
    const working = (await ctx.repos.orders.open(scopeE)).find((o) => o.side === "sell")!;
    expect(working?.brokerOrderId).toBeTruthy();
    // "Restart": a fresh in-memory book that has never seen the working exit order.
    broker.registry.set(scopeE, new SimulatedBrokerAdapter({ scope: scopeE, accountNumber: accE.accountNumber, quoteSource: { getQuotes: fakeQuotes }, clock: () => now.getTime(), initialCash: 93_000, initialPositions: [{ symbol: "UTIL1", quantity: 100, averageCost: 42 }] }));
    const m = await trading.ordersMonitor(scopeE);
    expect(m.errors).toEqual([]);
    const after = (await ctx.repos.orders.byId(scopeE, working.id))!;
    expect(after.state).toBe("cancelled");
    expect((after.raw as Record<string, unknown>)["lostOnRestart"]).toBe(true);
    expect(after.cumulativeQuantity).toBe(0);
    const trade = (await ctx.repos.trades.byId(scopeE, working.tradeId!))!;
    expect(trade.state).toBe("monitoring"); // exposure remains: nothing was assumed filled
    expect(trade.openQuantity).toBe(100);
    expect(await ctx.repos.orders.open(scopeE)).toHaveLength(0);
  });

  it("manual_approval creates an approval request and executes only after approve (risk re-run fresh)", async () => {
    // Promote the strategy globally so a live evaluation is possible; F runs it at limited_live.
    await trading.store.updateStrategy(tsmId, { stage: "limited_live" });
    const accF = (await ctx.repos.accounts.forScope(scopeF))!;
    const liveLike = spyAdapter(new SimulatedBrokerAdapter({ scope: scopeF, accountNumber: accF.accountNumber, quoteSource: { getQuotes: fakeQuotes }, clock: () => now.getTime(), initialCash: 1_000_000 }), { kind: "robinhood_agentic" });
    broker.registry.set(scopeF, liveLike.adapter);
    await ctx.repos.reconciliations.record(scopeF, { ok: true, positionMismatches: [], orderMismatches: [], cashDifference: 0, unexpectedPositions: [], action: "none", detail: null, at: now.toISOString() });
    await seedSnapshot(scopeF, 1_000_000); // live sizing on an honest forecast is a fraction of a percent: a larger book buys whole shares
    prices[SYMBOL] = priceInsideCorridor((await trading.store.candidateById(candidateId))!);
    advance(61_000);
    // An honest forecast on this low-volatility synthetic clears costs but not the probation hurdle (15 bps), so seed
    // the realised record of an account that has proven it earns: the mandate then applies the base hurdle.
    const winning = [1.2, -0.5, 0.9, 1.5, -0.4, 0.8, 1.1, -0.6, 1.3, 0.7, -0.3, 1.0, 0.9, -0.5, 1.4, 0.6, -0.4, 1.2, 0.8, 1.0, -0.2, 0.9, 1.1, -0.5, 1.3];
    const record = computePerformanceStats(winning.map((r) => ({ returnPct: r, holdingDays: 5, slippageBps: 5 })));
    const survival = computeSurvival({
      scope: scopeF, now: now.toISOString(), settings: { maxDrawdownPct: 0.1, maxWeeklyLossPct: 0.05, maxDailyLossPct: 0.02, maxSimultaneousPositions: 12 },
      equity: { current: 1_000_000, peak: 1_000_000, inception: 950_000, inceptionAt: "2026-06-01T00:00:00.000Z", lastHighAt: now.toISOString() },
      drawdownPct: 0, dailyPnlPct: 0.001, weeklyPnlPct: 0.004, recentDailyReturns: [0.002, -0.001, 0.003, 0.001, 0.002],
      live: { overall: record, recent: record }, shadow: { overall: { ...EMPTY_STATS }, recent: { ...EMPTY_STATS } },
      benchmark: { label: "SPY", returnPct: 0.02 }, liveReturnPct: 0.0526, previous: null,
    });
    expect(survival.mode).toBe("thriving");
    await ctx.repos.survival.record(scopeF, {
      mode: survival.mode, modeSince: survival.modeSince, previousMode: survival.previousMode, fitnessScore: survival.fitnessScore, riskMultiplier: survival.riskMultiplier, minEdgeMultiplier: survival.minEdgeMultiplier,
      hurdleBps: survival.hurdleBps, maxNewPositions: survival.maxNewPositions, allowLiveEntries: survival.allowLiveEntries, runwayDays: survival.runway.days, alphaPct: survival.alpha.alphaPct, state: survival, version: survival.version, computedAt: survival.computedAt,
    });
    const cycle = await trading.tradingCycle(scopeF);
    expect(cycle.evaluated).toBe(1);
    expect(cycle.approvalsRequested).toBe(1);
    expect(liveLike.calls["placeOrder"] ?? 0).toBe(0);
    const pending = await ctx.repos.approvals.pending(scopeF);
    expect(pending).toHaveLength(1);
    const trade = (await ctx.repos.trades.byId(scopeF, pending[0]!.tradeId))!;
    expect(trade.state).toBe("waiting_for_entry");
    expect(trade.mode).toBe("live");
    expect(await ctx.repos.orders.recent(scopeF, 5)).toHaveLength(0);

    const { cookie, csrf } = await login(userB.email);
    const list = await app.inject({ method: "GET", url: `/api/accounts/${scopeF.brokerAccountId}/approvals`, headers: { cookie } });
    expect(list.json().approvals[0].status).toBe("pending");
    const decided = await app.inject({ method: "POST", url: `/api/accounts/${scopeF.brokerAccountId}/approvals/${pending[0]!.id}`, headers: { cookie, "x-csrf-token": csrf }, payload: { decision: "approve" } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("approved");
    expect(decided.json().orderId).toBeTruthy();
    expect(liveLike.calls["reviewOrder"]).toBe(1);
    expect(liveLike.calls["placeOrder"]).toBe(1);
    const after = (await ctx.repos.trades.byId(scopeF, trade.id))!;
    expect(after.state).toBe("order_submitted");
    expect((await ctx.repos.approvals.byId(scopeF, pending[0]!.id))?.status).toBe("approved");
    // a fresh risk decision was recorded for the approval
    expect((await ctx.repos.riskDecisions.recent(scopeF, 5)).filter((d) => d.tradeId === trade.id && d.action === "enter")).toHaveLength(1);
    await trading.store.updateStrategy(tsmId, { stage: "live_shadow" });
  });

  it("stale quote => no entry (fail closed) and the cycle refuses an account outside the scope", async () => {
    advance(31_000);
    quoteObservedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
    const candidate = (await trading.store.candidateById(candidateId))!;
    const ev = await trading.evaluateCandidateForAccount(scopeG, candidate, { identityVerified: true });
    expect(ev.finalStatus).toBe("rejected");
    expect(ev.rejectionReasons).toContain("stale_data");
    expect(await ctx.repos.orders.recent(scopeG, 5)).toHaveLength(0);
    quoteObservedAt = null;
    const refused = await trading.tradingCycle({ userId: userA.id, brokerAccountId: scopeB.brokerAccountId });
    expect(refused.refused).toBe(true);
    expect(refused.evaluated).toBe(0);
  });

  it("serves opportunities, decisions and risk for the account (fractions at the boundary)", async () => {
    const { cookie } = await login(userA.email);
    const opp = await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/opportunities`, headers: { cookie } });
    expect(opp.statusCode).toBe(200);
    const o = (opp.json().opportunities as { candidateId: string; finalStatus: string; potentialDownsidePct: number; portfolioFit: number | null; ensemble: { components: unknown[] } }[]).find((x) => x.candidateId === candidateId)!;
    expect(o.finalStatus).toBe("shadow");
    expect(o.potentialDownsidePct).toBeLessThan(1); // fraction, not percent points
    expect(o.portfolioFit).not.toBeNull();
    expect(o.ensemble.components.length).toBeGreaterThan(0);
    const dec = await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/decisions?limit=20`, headers: { cookie } });
    expect(dec.statusCode).toBe(200);
    expect(dec.json().decisions.length).toBeGreaterThanOrEqual(2);
    expect(dec.json().fastBrain[0].decision.action).toBeTruthy();
    const risk = await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/risk`, headers: { cookie } });
    expect(risk.statusCode).toBe(200);
    const r = risk.json();
    expect(r.utilization.sector.sector).toBe("Technology");
    expect(r.utilization.sector.used).toBeCloseTo(0.15, 2);
    expect(r.utilization.positions.limit).toBe(12);
    expect(r.killSwitch.active).toBe(false);
    expect(r.global.forceShadowMode).toBe(false);
    // trader B cannot read A's risk
    const b = await login(userB.email);
    expect((await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/risk`, headers: { cookie: b.cookie } })).statusCode).toBe(403);
  });

  it("registers session-aware jobs: nothing runs while the market is closed, per-account jobs receive their scope", async () => {
    const scheduler = new Scheduler(ctx.repos, silent, async () => [scopeB]);
    registerTradingJobs(scheduler, ctx);
    scheduler.stop(); // timers off; dispatch by hand
    const saved = now;
    now = new Date("2026-09-27T14:30:00Z"); // Sunday: closed
    const closedRun = await new Scheduler(ctx.repos, silent, async () => [scopeB]).runOne({ name: TRADING_JOBS.tradingCycle.name, everyMs: 60_000, kind: "per_account", run: async ({ scope }) => (marketSessionAt(now) === "closed" ? { skipped: true, scope } : trading.tradingCycle(scope!)) }, scopeB);
    expect((closedRun as { skipped: boolean }).skipped).toBe(true);
    now = saved;
    const runs = await ctx.repos.jobs.recent(50);
    expect(runs.some((r) => r.name === TRADING_JOBS.tradingCycle.name && r.brokerAccountId === scopeB.brokerAccountId)).toBe(true);
    const cycle = await trading.tradingCycle(scopeB);
    expect(cycle.refused).toBe(false);
    expect(cycle.session).toBe("regular");
    expect(cycle.candidates).toBe(0); // B already evaluated the only candidate
  });
});
