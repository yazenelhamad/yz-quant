import { createModelClient } from "@yz/intelligence";
import type { AppContext, RouteModule } from "./http/app.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerBrokerRoutes } from "./routes/broker.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerTradeRoutes } from "./routes/trades.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerOverviewRoutes } from "./routes/overview.js";
import { registerPipelineJobs } from "./services/pipeline/index.js";
import { BrokerService } from "./services/brokerService.js";
import { MarketDataService } from "./services/marketData.js";
import { Scheduler } from "./services/scheduler.js";
import type { CoreServices } from "./services/registry.js";

export interface ComposeOptions {
  /** Start scheduled jobs (disabled in tests). */
  scheduler?: boolean;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * Composition root: attaches the core services (broker adapters, shared market data, scheduler,
 * model client) to the context. Feature planes (pipeline, trading, learning) are attached by
 * `composeFeatures` once their modules are registered.
 */
export async function composeServices(ctx: AppContext, opts: ComposeOptions = {}): Promise<CoreServices> {
  const log = opts.log ?? { info: console.log, warn: console.warn, error: console.error };
  const modelClient = createModelClient(ctx.env as unknown as Record<string, string | undefined>);
  const broker = new BrokerService(ctx.env, ctx.repos, ctx.audit, log, {});
  const marketData = new MarketDataService(ctx.repos.market, () => broker.marketDataSource(), log);
  // Simulated (shadow) accounts price off the shared quote feed.
  broker.quoteSource = { getQuotes: async (symbols) => marketData.getQuotes([...symbols]) };
  const scheduler = new Scheduler(ctx.repos, log, async () => {
    const accounts = await ctx.repos.accounts.listAll();
    return accounts.filter((a) => a.status === "connected" || a.kind === "simulated").map((a) => ({ userId: a.userId, brokerAccountId: a.id }));
  });
  const core: CoreServices = { broker, marketData, scheduler, modelClient };
  Object.assign(ctx.services, core);
  if (opts.scheduler !== false) {
    registerPipelineJobs(scheduler, ctx, { log });
    log.info({}, "market data pipeline jobs registered");
  }
  if (!modelClient.configured) log.warn({}, "AI models: not configured (ANTHROPIC_API_KEY absent) — committee and variant perception are disabled; deterministic engines run");
  return core;
}

export const routeModules: RouteModule[] = [
  registerAccountRoutes, registerAdminRoutes,
  registerBrokerRoutes, registerMarketRoutes, registerPositionRoutes, registerTradeRoutes, registerOrderRoutes, registerAnalyticsRoutes, registerOverviewRoutes,
];
