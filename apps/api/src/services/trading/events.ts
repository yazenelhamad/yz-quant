import { EventEmitter } from "node:events";
import type { TenantScope } from "@yz/core";

export interface TradingEventMap {
  /** A trade reached `closed` (open quantity hit zero). The learning service subscribes to run the post-trade review. */
  tradeClosed: [scope: TenantScope, tradeId: string];
  /** A trade was opened (first fill recorded). */
  tradeOpened: [scope: TenantScope, tradeId: string];
  /** A candidate was rejected / not acted on for a scope (recorded in rejected_trades). */
  tradeRejected: [scope: TenantScope, candidateId: string | null, reasons: string[]];
  /** An automatic kill switch fired for a scope. */
  killSwitchTriggered: [scope: TenantScope, reasons: string[]];
}

class TradingEventEmitter extends EventEmitter<TradingEventMap> {}

/**
 * In-process event bus for the trading cycle. Payloads always carry the TenantScope so a subscriber
 * can never confuse one account's trade with another's. Errors thrown by listeners never propagate
 * into the trading cycle (see `emitSafe`).
 */
export const tradingEvents = new TradingEventEmitter();
tradingEvents.setMaxListeners(50);

export function emitSafe<K extends keyof TradingEventMap>(event: K, ...args: TradingEventMap[K]): void {
  try {
    tradingEvents.emit(event, ...args);
  } catch {
    // Listener failures are the listener's problem; the trading cycle must not fail because of them.
  }
}
