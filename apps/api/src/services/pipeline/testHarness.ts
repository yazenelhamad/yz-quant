/**
 * Shared test harness for the API data plane: PGlite database, composed core services
 * (broker with a fake quote source, market data, scheduler, not-configured model client) and
 * the data-plane route modules. Test-only; not imported by production code.
 */
import type { FastifyInstance } from "fastify";
import type { Quote } from "@yz/core";
import type { FetchLike, QuoteSource } from "@yz/broker";
import { NotConfiguredClient } from "@yz/intelligence";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { loadEnv } from "../../config/env.js";
import { buildApp, createContext, type AppContext, type RouteModule } from "../../http/app.js";
import { hashPassword } from "../../auth/password.js";
import { registerAccountRoutes } from "../../routes/accounts.js";
import { registerAdminRoutes } from "../../routes/admin.js";
import { registerAnalyticsRoutes } from "../../routes/analytics.js";
import { registerBrokerRoutes } from "../../routes/broker.js";
import { registerMarketRoutes } from "../../routes/market.js";
import { registerOrderRoutes } from "../../routes/orders.js";
import { registerOverviewRoutes } from "../../routes/overview.js";
import { registerPositionRoutes } from "../../routes/positions.js";
import { registerTradeRoutes } from "../../routes/trades.js";
import { BrokerService } from "../brokerService.js";
import { MarketDataService, type MarketDataSource } from "../marketData.js";
import { Scheduler } from "../scheduler.js";
import { silentLogger } from "./common.js";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
export const PASSWORD = "CorrectHorse!Battery9";

export const dataPlaneRoutes: RouteModule[] = [registerAccountRoutes, registerAdminRoutes, registerBrokerRoutes, registerMarketRoutes, registerPositionRoutes, registerTradeRoutes, registerOrderRoutes, registerAnalyticsRoutes, registerOverviewRoutes];

/** Deterministic fake quotes: price derived from the symbol; timestamps from the harness clock. */
export function fakeQuoteSource(clock: () => Date, prices: Record<string, number> = {}): QuoteSource & { calls: number } {
  const src = {
    calls: 0,
    async getQuotes(symbols: readonly string[]): Promise<Quote[]> {
      src.calls++;
      const at = clock().toISOString();
      return symbols.map((symbol) => {
        const last = prices[symbol] ?? 50 + ([...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 200);
        return { symbol, last, bid: last - 0.02, ask: last + 0.02, previousClose: last * 0.99, lastTradeAt: at, session: "regular", instrumentState: "active", provenance: { source: "test_quotes", observedAt: at, receivedAt: at, reliability: 1 } };
      });
    },
  };
  return src;
}

export interface Harness {
  h: DatabaseHandle;
  ctx: AppContext;
  app: FastifyInstance;
  broker: BrokerService;
  marketData: MarketDataService;
  scheduler: Scheduler;
  clock: { now: Date; advance: (ms: number) => void; set: (d: Date) => void };
  users: { admin: { id: string; email: string }; trader: { id: string; email: string } };
  accounts: { admin: string; trader: string };
  login: (email: string, opts?: { stepUp?: boolean }) => Promise<{ cookie: string; csrf: string; headers: Record<string, string> }>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  start?: Date;
  quoteSource?: QuoteSource | null;
  fetch?: FetchLike;
  marketSource?: MarketDataSource | null;
  extraRoutes?: RouteModule[];
  env?: Record<string, string>;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const h = await createDatabase("pglite://memory");
  await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: TEST_KEY, SESSION_SECRET: "test-session-secret-0123456789", SCHEDULER_ENABLED: "false", DATABASE_URL: "pglite://memory", AUTH_RATE_LIMIT_MAX: "1000", GLOBAL_RATE_LIMIT_MAX: "100000", LOG_LEVEL: "silent", ...(opts.env ?? {}) });
  const ctx = createContext(env, h, silentLogger);
  const clock = { now: opts.start ?? new Date("2026-09-28T14:30:00Z"), advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); }, set(d: Date) { clock.now = d; } };
  const tick = () => clock.now;
  const quoteSource = opts.quoteSource === undefined ? fakeQuoteSource(tick) : opts.quoteSource;
  const broker = new BrokerService(env, ctx.repos, ctx.audit, silentLogger, { quoteSource, fetch: opts.fetch, clock: tick });
  const marketData = new MarketDataService(ctx.repos.market, async () => (opts.marketSource !== undefined ? opts.marketSource : broker.marketDataSource()), silentLogger, tick);
  const scheduler = new Scheduler(ctx.repos, silentLogger, async () => (await ctx.repos.accounts.listAll()).map((a) => ({ userId: a.userId, brokerAccountId: a.id })));
  ctx.services["broker"] = broker;
  ctx.services["marketData"] = marketData;
  ctx.services["scheduler"] = scheduler;
  ctx.services["modelClient"] = new NotConfiguredClient();
  const app = await buildApp(ctx, [...dataPlaneRoutes, ...(opts.extraRoutes ?? [])]);
  const hash = await hashPassword(PASSWORD);
  const admin = await ctx.repos.users.create({ email: "admin@example.com", displayName: "Admin", role: "admin", passwordHash: hash });
  const trader = await ctx.repos.users.create({ email: "trader@example.com", displayName: "Trader", role: "trader", passwordHash: hash });
  const accAdmin = await ctx.repos.accounts.create({ userId: admin.id, kind: "simulated", label: "Admin sim (SIMULATED)", accountNumber: "SIM-ADMIN1", status: "connected", agenticAllowed: true, accountType: "limited_margin" });
  const accTrader = await ctx.repos.accounts.create({ userId: trader.id, kind: "simulated", label: "Trader sim (SIMULATED)", accountNumber: "SIM-TRADE1", status: "connected", agenticAllowed: true, accountType: "limited_margin" });

  const login: Harness["login"] = async (email, o = {}) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const set = res.headers["set-cookie"];
    const arr = Array.isArray(set) ? set : [set];
    const cookie = (arr.find((x) => typeof x === "string" && x.startsWith("yz_session=")) as string).split(";")[0]!;
    const s = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
    const csrf = s.json().csrfToken as string;
    const headers = { cookie, "x-csrf-token": csrf };
    if (o.stepUp) {
      const st = await app.inject({ method: "POST", url: "/api/auth/step-up", headers, payload: { password: PASSWORD } });
      if (st.statusCode !== 200) throw new Error(`step-up failed: ${st.statusCode} ${st.body}`);
    }
    return { cookie, csrf, headers };
  };

  return {
    h, ctx, app, broker, marketData, scheduler, clock,
    users: { admin: { id: admin.id, email: admin.email! }, trader: { id: trader.id, email: trader.email! } },
    accounts: { admin: accAdmin.id, trader: accTrader.id },
    login,
    close: async () => { scheduler.stop(); await app.close(); await h.close(); },
  };
}
