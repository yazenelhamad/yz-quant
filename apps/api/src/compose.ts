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
import { registerLearningRoutes } from "./routes/learning.js";
import { registerPipelineJobs } from "./services/pipeline/index.js";
import { createTradingService, registerTradingJobs, registerTradingRoutes, tradingEvents } from "./services/trading/index.js";
import { createLearningService, registerLearningJobs, seedStrategies } from "./services/learning/index.js";
import { createResearchService } from "./services/research/index.js";
import { BrokerService } from "./services/brokerService.js";
import { MarketDataService } from "./services/marketData.js";
import { Scheduler } from "./services/scheduler.js";
import type { CoreServices } from "./services/registry.js";

export interface ComposeOptions {
  /** Register scheduled jobs (disabled in tests). */
  scheduler?: boolean;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * Composition root. Order matters:
 *   core services (broker adapters, shared market data, scheduler, model client)
 *   → strategy catalogue seeded
 *   → trading plane, learning plane, research plane
 *   → learning subscribes to trade closures
 *   → scheduled jobs (pipeline, trading, learning)
 */
export async function composeServices(ctx: AppContext, opts: ComposeOptions = {}): Promise<CoreServices> {
  const log = opts.log ?? { info: console.log, warn: console.warn, error: console.error };
  const modelClient = createModelClient(ctx.env as unknown as Record<string, string | undefined>);
  const broker = new BrokerService(ctx.env, ctx.repos, ctx.audit, log, {});
  const marketData = new MarketDataService(ctx.repos.market, () => broker.marketDataSource(), log);
  broker.quoteSource = { getQuotes: async (symbols) => marketData.getQuotes([...symbols]) };
  const scheduler = new Scheduler(ctx.repos, log, async () => {
    const accounts = await ctx.repos.accounts.listAll();
    return accounts.filter((a) => a.status === "connected" || a.kind === "simulated").map((a) => ({ userId: a.userId, brokerAccountId: a.id }));
  });
  const core: CoreServices = { broker, marketData, scheduler, modelClient };
  Object.assign(ctx.services, core);

  const seeded = await seedStrategies(ctx.repos);
  if (seeded.inserted > 0) log.info(seeded, "strategy catalogue seeded");

  const trading = createTradingService(ctx, { broker, marketData, modelClient, log });
  const learning = createLearningService(ctx, { log, modelClient });
  createResearchService(ctx, { modelClient, log });
  tradingEvents.on("tradeClosed", (scope, tradeId) => { void learning.onTradeClosed(scope, tradeId); });
  void trading;

  if (opts.scheduler !== false) {
    registerPipelineJobs(scheduler, ctx, { log });
    registerTradingJobs(scheduler, ctx);
    registerLearningJobs(scheduler, ctx, learning);
    log.info({}, "pipeline, trading and learning jobs registered");
  }
  if (!modelClient.configured) log.warn({}, "AI models: not configured (ANTHROPIC_API_KEY absent) — committee and variant perception are disabled; deterministic engines run");
  return core;
}

export const routeModules: RouteModule[] = [
  registerAccountRoutes, registerAdminRoutes,
  registerBrokerRoutes, registerMarketRoutes, registerPositionRoutes, registerTradeRoutes, registerOrderRoutes, registerAnalyticsRoutes, registerOverviewRoutes,
  registerTradingRoutes,
  registerLearningRoutes,
];
