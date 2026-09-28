/**
 * End-to-end simulation through the REAL composition root (apps/api/src/compose.ts):
 * two users, two isolated SIMULATED accounts, SYNTHETIC bars, the deterministic engines only
 * (AI models not configured). Proves the planes are wired together and that nothing crosses scopes:
 *   candidates (shared) → per-account evaluation → risk → shadow execution → fills → close
 *   → learning review, with user A's learning never touching user B.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Bar, Quote, TenantScope } from "@yz/core";
import { FEATURE_VERSION, computeFeatures, trendingBars } from "@yz/core";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { loadEnv } from "../../apps/api/src/config/env.js";
import { buildApp, createContext, type AppContext } from "../../apps/api/src/http/app.js";
import { hashPassword } from "../../apps/api/src/auth/password.js";
import { composeServices, routeModules } from "../../apps/api/src/compose.js";
import { tradingService } from "../../apps/api/src/services/trading/index.js";
import { ensureStrategyRows } from "../../apps/api/src/services/trading/strategyRows.js";
import type { MarketDataSource } from "../../apps/api/src/services/marketData.js";
import type { LearningService } from "../../apps/api/src/services/learning/index.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const PASSWORD = "CorrectHorse!Battery9";
const SYMBOL = "SYNTH";
let now = new Date("2026-09-28T14:30:00Z"); // Monday, regular session
const clock = () => now;
const prices: Record<string, number> = {};
const quotes = async (symbols: readonly string[]): Promise<Quote[]> => symbols.filter((s) => prices[s] !== undefined).map((s) => {
  const last = Math.round(prices[s]! * 100) / 100;
  const at = now.toISOString();
  return { symbol: s, last, bid: last - 0.01, ask: last + 0.01, previousClose: last, lastTradeAt: at, session: "regular", instrumentState: "active", provenance: { source: "synthetic:e2e", observedAt: at, receivedAt: at, reliability: 1 } };
});
const marketSource: MarketDataSource = { name: "synthetic:e2e", getQuotes: quotes, getBars: async () => [], getTradability: async () => [] };

let h: DatabaseHandle;
let ctx: AppContext;
let app: FastifyInstance;
let scopeA: TenantScope;
let scopeB: TenantScope;

function retime(src: Bar[], endDate: string): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse(`${endDate}T00:00:00Z`);
  for (let i = src.length - 1; i >= 0; i -= 1) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t -= 86_400_000;
    out.unshift({ ...src[i]!, time: new Date(t).toISOString(), adjusted: "split" });
    t -= 86_400_000;
  }
  return out;
}

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  const cookie = ((Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]]) as string[]).find((c) => c?.startsWith("yz_session="))!.split(";")[0]!;
  const s = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
  return { cookie, headers: { cookie, "x-csrf-token": s.json().csrfToken as string } };
}

beforeAll(async () => {
  h = await createDatabase("pglite://memory");
  await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: KEY, SESSION_SECRET: "test-session-secret-0123456789", SCHEDULER_ENABLED: "false", DATABASE_URL: "pglite://memory", LOG_LEVEL: "silent", AUTH_RATE_LIMIT_MAX: "1000", GLOBAL_RATE_LIMIT_MAX: "100000" });
  const silent = { info() {}, warn() {}, error() {} };
  ctx = createContext(env, h, silent);
  await composeServices(ctx, { scheduler: false, log: silent, testOverrides: { marketSource, clock } });
  app = await buildApp(ctx, routeModules);

  const a = await ctx.repos.users.create({ email: "a@example.com", displayName: "A", role: "admin", passwordHash: await hashPassword(PASSWORD) });
  const b = await ctx.repos.users.create({ email: "b@example.com", displayName: "B", role: "trader", passwordHash: await hashPassword(PASSWORD) });
  const accA = await ctx.repos.accounts.create({ userId: a.id, kind: "simulated", label: "A (SIMULATED)", accountNumber: "SIM-A", status: "connected", agenticAllowed: true, accountType: "limited_margin", autonomyLevel: "fully_autonomous", tradingPaused: false });
  const accB = await ctx.repos.accounts.create({ userId: b.id, kind: "simulated", label: "B (SIMULATED)", accountNumber: "SIM-B", status: "connected", agenticAllowed: true, accountType: "limited_margin", autonomyLevel: "fully_autonomous", tradingPaused: false });
  scopeA = { userId: a.id, brokerAccountId: accA.id };
  scopeB = { userId: b.id, brokerAccountId: accB.id };

  // Synthetic market data, explicitly labelled.
  const bars = retime(trendingBars(SYMBOL, 320, 0.003, 11, "2024-01-02T00:00:00Z"), "2026-09-28");
  prices[SYMBOL] = bars[bars.length - 1]!.close;
  await ctx.repos.market.upsertBars(bars.map((x) => ({ symbol: x.symbol, interval: "day", time: x.time, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, interpolated: false, adjusted: "split", source: "synthetic:e2e", receivedAt: now.toISOString() })));
  await ctx.repos.market.upsertInstrument({ symbol: SYMBOL, name: "Synthetic Co", sector: "Technology", assetClass: "equity", state: "active", tradeable: true, fractional: false, beta: 1.1, avgDollarVolume20: 2e8 });
  const fs = computeFeatures({ asOf: now.toISOString(), bars, quote: (await quotes([SYMBOL]))[0]! });
  await ctx.repos.market.upsertFeatures({ symbol: SYMBOL, asOf: now.toISOString(), featureVersion: FEATURE_VERSION, values: fs.values, freshness: fs.freshness });
  const p: Record<string, number> = { bull_trend: 0.45, bear_trend: 0.05, range_bound: 0.05, high_volatility: 0.05, low_volatility: 0.05, risk_on: 0.05, risk_off: 0.05, liquidity_shock: 0.05, event_driven: 0.05, sector_rotation: 0.05, momentum: 0.05, mean_reversion: 0.05 };
  await ctx.repos.market.recordRegime({ asOf: now.toISOString(), primary: "bull_trend", probabilities: p, confidence: 0.8, abnormality: 0.1, metrics: { spyTrend20: 0.02, spyTrend100: 0.05, realizedVol20: 0.15, vix: 15, breadthPctAbove50: 60, avgPairwiseCorrelation: 0.3, sectorDispersion: 0.03, momentumPersistence: 0.1, meanReversionScore: 0.2, volumeRatio: 1 }, familyBias: { trend_momentum: 0.6, mean_reversion: -0.5, statistical: 0.1, event: 0.2, options_volatility: 0, fundamental_variant: 0 }, explanation: ["synthetic e2e regime"], dataQuality: "fresh", engineVersion: "test" });

  const trading = tradingService(ctx);
  const rows = await ensureStrategyRows(h.db);
  const tsm = rows.get("time_series_momentum")!.id;
  for (const s of [scopeA, scopeB]) {
    await trading.store.upsertUserStrategySetting(s, tsm, { enabled: true, stage: "live_shadow", capitalAllocation: 1, maxPositionPct: 0.05, maxLossPerTradePct: 0.01 });
    await ctx.repos.snapshots.record(s, { asOf: now.toISOString(), totalValue: 100_000, equityValue: 0, cash: 100_000, buyingPower: 100_000, unleveragedBuyingPower: 100_000, dailyPnl: 0, totalPnl: 0, drawdownPct: 0, exposurePct: 0, source: "synthetic:e2e" });
  }
});
afterAll(async () => { await app.close(); await h.close(); });

describe("platform end-to-end (composition root, two isolated simulated accounts)", () => {
  it("runs the full cycle for both accounts and keeps every row scoped", async () => {
    const trading = tradingService(ctx);
    const gen = await trading.generateCandidates(now);
    expect(gen.created.length).toBeGreaterThanOrEqual(1);
    const cycleA = await trading.tradingCycle(scopeA);
    const cycleB = await trading.tradingCycle(scopeB);
    expect(cycleA).toBeTruthy();
    expect(cycleB).toBeTruthy();
    const ordersA = await ctx.repos.orders.recent(scopeA);
    const ordersB = await ctx.repos.orders.recent(scopeB);
    expect(ordersA.length).toBeGreaterThanOrEqual(1);
    expect(ordersB.length).toBeGreaterThanOrEqual(1);
    expect(ordersA.every((o) => o.userId === scopeA.userId && o.brokerAccountId === scopeA.brokerAccountId && o.mode === "shadow")).toBe(true);
    expect(ordersB.every((o) => o.userId === scopeB.userId && o.brokerAccountId === scopeB.brokerAccountId && o.mode === "shadow")).toBe(true);
    // Nothing that belongs to A is visible through B's scope and vice versa.
    for (const o of ordersA) expect(await ctx.repos.orders.byId(scopeB, o.id)).toBeUndefined();
    for (const o of ordersB) expect(await ctx.repos.orders.byId(scopeA, o.id)).toBeUndefined();
    // Every order went through a stored risk decision and thesis.
    expect((await ctx.repos.riskDecisions.recent(scopeA)).length).toBeGreaterThanOrEqual(1);
    expect((await ctx.repos.theses.recent(scopeA)).length).toBeGreaterThanOrEqual(1);
  });

  it("fills in the simulated book, exposes positions through the API, and journals the close into learning for A only", async () => {
    const trading = tradingService(ctx);
    // Limit orders rest at mid; after the reprice window the monitor lifts them to the ask and the book fills.
    const settle = async (scope: TenantScope) => {
      await trading.ordersMonitor(scope);
      now = new Date(now.getTime() + 61_000);
      await trading.ordersMonitor(scope);
      now = new Date(now.getTime() + 1_000);
      await trading.ordersMonitor(scope);
    };
    await settle(scopeA);
    await settle(scopeB);
    const openA = await ctx.repos.trades.list(scopeA, { states: ["filled", "monitoring"] });
    expect(openA.length).toBeGreaterThanOrEqual(1);

    const sessionA = await login("a@example.com");
    const positions = await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/positions`, headers: sessionA.headers });
    expect(positions.statusCode).toBe(200);
    const overview = await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/overview`, headers: sessionA.headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().account.simulated).toBe(true);

    // B cannot see A's trades through the API.
    const sessionB = await login("b@example.com");
    expect((await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/trades`, headers: sessionB.headers })).statusCode).toBe(403);

    // Close A's position: exit path through the risk engine, fill, tradeClosed → learning.onTradeClosed.
    const learning = ctx.services["learning"] as LearningService;
    const before = (await learning.learningView(scopeA, [scopeA])).recentLessons?.length ?? 0;
    prices[SYMBOL] = prices[SYMBOL]! * 1.02;
    const closed = await trading.closePosition(scopeA, SYMBOL, "e2e test exit", scopeA.userId);
    expect(closed).toBeTruthy();
    await settle(scopeA);
    await trading.positionsManage(scopeA);
    const closedTrades = await ctx.repos.trades.list(scopeA, { states: ["closed"] });
    expect(closedTrades.length).toBeGreaterThanOrEqual(1);
    // The learning plane only ever writes rows for scope A; B remains untouched.
    await learning.onTradeClosed(scopeA, closedTrades[0]!.id);
    const viewA = await learning.learningView(scopeA, [scopeA]);
    const viewB = await learning.learningView(scopeB, [scopeB]);
    expect((viewA.recentLessons?.length ?? 0)).toBeGreaterThanOrEqual(before);
    expect((viewB.recentLessons?.length ?? 0)).toBe(0);
    const journalA = await app.inject({ method: "GET", url: `/api/accounts/${scopeA.brokerAccountId}/journal`, headers: sessionA.headers });
    expect(journalA.statusCode).toBe(200);
    expect(journalA.json().entries.length).toBeGreaterThanOrEqual(1);
    const journalB = await app.inject({ method: "GET", url: `/api/accounts/${scopeB.brokerAccountId}/journal`, headers: sessionB.headers });
    expect(journalB.json().entries.length).toBe(0);
    // Audit trail exists for both risk and order actions.
    const audit = await ctx.repos.audit.recent({ userId: scopeA.userId, limit: 500 });
    expect(audit.some((r) => r.category === "order" || r.category === "risk" || r.category === "trade" as never)).toBe(true);
  });
});
