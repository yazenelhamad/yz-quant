import type { StructuredModelClient } from "@yz/intelligence";
import type { AppContext } from "../http/app.js";
import type { BrokerService } from "./brokerService.js";
import type { MarketDataService } from "./marketData.js";
import type { Scheduler } from "./scheduler.js";

/** Core services attached by the composition root (main.ts / tests). Feature services add their own keys. */
export interface CoreServices {
  broker: BrokerService;
  marketData: MarketDataService;
  scheduler: Scheduler;
  modelClient: StructuredModelClient;
}

export function coreServices(ctx: AppContext): CoreServices {
  const s = ctx.services as Partial<CoreServices>;
  if (!s.broker || !s.marketData || !s.scheduler || !s.modelClient) throw new Error("core services not composed");
  return s as CoreServices;
}

/** Typed accessor for feature services registered under `ctx.services[key]`. */
export function service<T>(ctx: AppContext, key: string): T {
  const v = ctx.services[key];
  if (!v) throw new Error(`service ${key} not composed`);
  return v as T;
}

/**
 * The application's clock: the one the composed services run on (the pipeline's, else the trading
 * runtime's), so routes judge freshness against the same time the jobs used. Production composes
 * both on the wall clock; tests inject a fixed one. Falls back to the wall clock.
 */
export function appNow(ctx: AppContext): Date {
  const pipeline = ctx.services["pipeline"] as { clock?: () => Date } | undefined;
  if (pipeline?.clock) return pipeline.clock();
  const trading = ctx.services["trading"] as { runtime?: { clock?: () => Date } } | undefined;
  if (trading?.runtime?.clock) return trading.runtime.clock();
  return new Date();
}
