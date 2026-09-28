import type { IsoTimestamp, TenantScope } from "./ids.js";
import type { MarketHours, OrderType, TimeInForce } from "./account.js";

export interface ExecutionContext {
  scope: TenantScope;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  urgency: "low" | "normal" | "high";
  last: number;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  adv: number | null; // average daily dollar volume
  realizedVolDaily: number | null;
  session: "closed" | "pre" | "regular" | "post" | "overnight";
  minutesToClose: number | null;
  expectedEdgeBps: number; // theoretical edge of the trade in bps
  fractionalAllowed: boolean;
  extendedHoursAllowed: boolean;
  /** Learned execution stats for this symbol/liquidity bucket. */
  learned: { avgSlippageBps: number | null; fillRateLimitAtMid: number | null; avgTimeToFillSec: number | null } | null;
}

export interface ExecutionPlan {
  orderType: OrderType;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
  quantity: number;
  /** Expected slippage in bps used to judge whether execution destroys edge. */
  expectedSlippageBps: number;
  expectedCostBps: number;
  /** When true the trade must not be sent because execution cost destroys the edge. */
  abort: boolean;
  abortReason: string | null;
  /** Repricing rules applied by the monitor. */
  repricing: { afterSeconds: number; maxReprices: number; stepBps: number; maxChaseBps: number };
  staging: { slices: number; intervalSeconds: number } | null;
  reasons: string[];
}

export interface ExecutionOutcome {
  scope: TenantScope;
  brokerOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  expectedPrice: number;
  arrivalPrice: number;
  fillPrice: number | null;
  expectedSlippageBps: number;
  actualSlippageBps: number | null;
  timeToFillSeconds: number | null;
  partial: boolean;
  missed: boolean;
  reprices: number;
  cancelled: boolean;
  liquidityBucket: "low" | "medium" | "high";
  session: string;
  at: IsoTimestamp;
}
