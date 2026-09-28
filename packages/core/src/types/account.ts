import type { BrokerAccountId, IsoTimestamp, TenantScope, UserId } from "./ids.js";
import type { DataProvenance } from "./market.js";

export type BrokerKind = "robinhood_agentic" | "simulated";

export type BrokerConnectionStatus =
  | "not_connected"
  | "connecting"
  | "connected"
  | "token_expired"
  | "unreliable"
  | "revoked"
  | "error";

export interface BrokerAccountRef {
  id: BrokerAccountId;
  userId: UserId;
  kind: BrokerKind;
  /** Broker's account number. Masked in UI, never logged in full. */
  accountNumber: string;
  label: string;
  /** Account is enabled for agentic order placement at the broker. */
  agenticAllowed: boolean;
  accountType: "cash" | "margin" | "limited_margin" | "unknown";
  optionsEnabled: boolean;
  status: BrokerConnectionStatus;
}

export interface PortfolioSnapshot {
  scope: TenantScope;
  asOf: IsoTimestamp;
  totalValue: number;
  equityValue: number;
  optionsValue: number;
  cryptoValue: number;
  cash: number;
  pendingDeposits: number;
  buyingPower: number;
  unleveragedBuyingPower: number;
  currency: string;
  provenance: DataProvenance;
}

export interface Position {
  scope: TenantScope;
  symbol: string;
  assetClass: "equity" | "option" | "crypto";
  quantity: number;
  intradayQuantity: number;
  sharesAvailableForSells: number;
  averageCost: number | null;
  /** Latest mark. Null when the quote is missing/stale (never fabricated). */
  markPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  asOf: IsoTimestamp;
  provenance: DataProvenance;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
export type TimeInForce = "gfd" | "gtc";
export type MarketHours = "regular_hours" | "extended_hours" | "all_day_hours";

/** Platform-normalised broker order state. */
export type BrokerOrderState =
  | "new" | "queued" | "unconfirmed" | "confirmed"
  | "partially_filled" | "filled"
  | "pending_cancelled" | "cancelled" | "partially_filled_rest_cancelled"
  | "rejected" | "failed" | "voided"
  | "locating" | "locate_failed"
  | "unknown";

export const TERMINAL_ORDER_STATES: ReadonlySet<BrokerOrderState> = new Set([
  "filled", "cancelled", "partially_filled_rest_cancelled", "rejected", "failed", "voided", "locate_failed",
]);

export interface OrderRequest {
  scope: TenantScope;
  /** Broker account number. Must equal the adapter's bound account number. */
  accountNumber: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number | null;
  dollarAmount: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
  /** Client idempotency key. Generated once per logical order; re-sent on retries. */
  refId: string;
  /** Internal trade this order belongs to. */
  tradeId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
}

export interface OrderReview {
  ok: boolean;
  estimatedCost: number | null;
  quote: { last: number | null; bid: number | null; ask: number | null } | null;
  alerts: { code: string; severity: "info" | "warning" | "blocking"; message: string }[];
  raw: unknown;
  reviewedAt: IsoTimestamp;
}

export interface BrokerOrder {
  scope: TenantScope;
  brokerOrderId: string;
  refId: string | null;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  state: BrokerOrderState;
  quantity: number | null;
  cumulativeQuantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  averagePrice: number | null;
  fees: number;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
  placedAgent: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  raw?: unknown;
}

export interface Fill {
  scope: TenantScope;
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fees: number;
  /** Derived from order object updates (Robinhood exposes no separate executions feed). */
  derived: boolean;
  at: IsoTimestamp;
}

export interface TaxLot {
  scope: TenantScope;
  symbol: string;
  lotId: string;
  quantity: number;
  quantityAvailable: number;
  costPerShare: number | null;
  openDate: string | null;
  term: "st" | "lt" | "other" | "unknown";
}
