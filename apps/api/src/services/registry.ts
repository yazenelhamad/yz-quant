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
