/** Test fixtures shaped like the observed official tool payloads. Not exported from the package index. */
import { readFileSync } from "node:fs";
import type { OrderRequest, Quote, TenantScope } from "@yz/core";
import type { McpToolDefinition } from "../robinhood/mcpClient.js";

export const SCOPE_A: TenantScope = { userId: "user-a", brokerAccountId: "acct-a" };
export const SCOPE_B: TenantScope = { userId: "user-b", brokerAccountId: "acct-b" };
export const ACCT_A = "5PY12345";
export const ACCT_B = "5PY67890";
export const T0 = Date.parse("2026-09-28T14:30:00Z");

let observed: McpToolDefinition[] | null = null;
export function loadObservedTools(): McpToolDefinition[] {
  if (!observed) {
    const url = new URL("../../../../docs/robinhood/official-mcp-tools.observed.json", import.meta.url);
    observed = JSON.parse(readFileSync(url, "utf8")) as McpToolDefinition[];
  }
  return observed.map((t) => structuredClone(t));
}

export interface VirtualClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  sleeps: number[];
}

export function virtualClock(start: number = T0): VirtualClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

export function rawAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_number: ACCT_A,
    rhs_account_number: "123456789",
    type: "limited_margin",
    brokerage_account_type: "individual",
    nickname: "Agentic",
    is_default: false,
    agentic_allowed: true,
    option_level: "option_level_2",
    state: "active",
    deactivated: false,
    permanently_deactivated: false,
    ...overrides,
  };
}

export function rawPortfolio(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_value: "12500.50",
    equity_value: "10000.00",
    options_value: "0.00",
    futures_value: "0.00",
    event_contracts_value: "0.00",
    crypto_value: "0.00",
    cash: "2500.50",
    pending_deposits: "0.00",
    mutual_funds_value: "0.00",
    fixed_income_value: "0.00",
    currency: "USD",
    buying_power: { buying_power: "2500.50", unleveraged_buying_power: "2500.50", intraday_buying_power: null, off_intraday_buying_power: null, display_currency: "USD" },
    crypto_buying_power: null,
    ...overrides,
  };
}

export function rawPosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AAPL",
    quantity: "10",
    intraday_quantity: "0",
    average_buy_price: "150.25",
    shares_available_for_sells: "8",
    shares_held_for_sells: "2",
    shares_held_for_stock_grants: "0",
    shares_held_for_options_events: "0",
    shares_held_for_asset_transfer: "0",
    shares_pending_from_options_events: "0",
    type: "long",
    ...overrides,
  };
}

export function rawOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "o-1",
    instrument_id: "inst-1",
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    state: "confirmed",
    quantity: "10",
    cumulative_quantity: "0",
    price: "150.00",
    stop_price: null,
    average_price: null,
    fees: "0.00",
    dollar_based_amount: null,
    time_in_force: "gfd",
    market_hours: "regular_hours",
    trigger: "immediate",
    placed_agent: "agentic",
    created_at: "2026-09-28T14:00:00Z",
    last_transaction_at: null,
    executions: [],
    ...overrides,
  };
}

export function rawQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AAPL",
    last_trade_price: "151.10",
    venue_last_trade_time: "2026-09-28T14:29:58Z",
    last_non_reg_trade_price: null,
    venue_last_non_reg_trade_time: null,
    adjusted_previous_close: "149.80",
    previous_close: "149.80",
    previous_close_date: "2026-09-25",
    bid_price: "151.05",
    venue_bid_time: "2026-09-28T14:29:59Z",
    ask_price: "151.15",
    venue_ask_time: "2026-09-28T14:29:59Z",
    has_traded: true,
    state: "active",
    ...overrides,
  };
}

export function rawReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { symbol: "AAPL", side: "buy", type: "limit", quantity: "10", limit_price: "150", order_checks: {}, quote_data: rawQuote(), market_data_disclosure: "Quotes delayed", ...overrides };
}

export function orderRequest(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    scope: SCOPE_A,
    accountNumber: ACCT_A,
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    quantity: 10,
    dollarAmount: null,
    limitPrice: 150,
    stopPrice: null,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    refId: "ref-0001",
    tradeId: "trade-1",
    strategyId: "strat-1",
    strategyVersionId: "v1",
    ...overrides,
  };
}

export function quote(symbol: string, last: number, bid: number | null = last - 0.05, ask: number | null = last + 0.05, at = "2026-09-28T14:29:59Z"): Quote {
  return { symbol, last, bid, ask, previousClose: last, lastTradeAt: at, session: "regular", instrumentState: "active", provenance: { source: "robinhood_mcp:get_equity_quotes", observedAt: at, receivedAt: at, reliability: 0.92 } };
}
