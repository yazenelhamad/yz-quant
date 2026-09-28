/**
 * Exact mappings between the official tool payloads and @yz/core types. Nothing here guesses:
 * a missing or unparseable number maps to null (or is dropped) and an unknown state maps to
 * "unknown" so that reconciliation runs instead of a wrong assumption.
 */
import type { Bar, BarInterval, BrokerOrder, BrokerOrderState, Fill, IsoTimestamp, MarketHours, OrderRequest, OrderSide, OrderType, PortfolioSnapshot, Position, Quote, TaxLot, TenantScope, TimeInForce, Tradability } from "@yz/core";
import { assertSameScope } from "@yz/core";
import type { BrokerAccountListing } from "../adapter.js";
import { BrokerError } from "../errors.js";
import { decimalString } from "../orderRules.js";
import { RELIABILITY, mcpProvenance, toIso } from "../provenance.js";
import type { z } from "zod";
import type { AccountSchema, PortfolioData, PositionSchema, RawBar, RawOrder, RawQuote, RawTradability, TaxLotSchema } from "./schemas.js";

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---- enums ---------------------------------------------------------------

export const KNOWN_ORDER_STATES: ReadonlySet<BrokerOrderState> = new Set<BrokerOrderState>([
  "new", "queued", "unconfirmed", "confirmed", "partially_filled", "filled", "pending_cancelled", "cancelled",
  "partially_filled_rest_cancelled", "rejected", "failed", "voided", "locating", "locate_failed",
]);

/** Upstream state → platform state; anything unrecognised is "unknown" (never guessed). */
export function mapOrderState(state: unknown): BrokerOrderState {
  return typeof state === "string" && KNOWN_ORDER_STATES.has(state as BrokerOrderState) ? (state as BrokerOrderState) : "unknown";
}

/** `type` (market|limit) + `trigger` (immediate|stop) → OrderType. Falls back to the presence of price/stop_price. */
export function mapOrderType(type: unknown, trigger: unknown, price: unknown, stopPrice: unknown): OrderType {
  const isStop = trigger === "stop" || (trigger !== "immediate" && num(stopPrice) !== null);
  const isLimit = type === "limit" || (type !== "market" && num(price) !== null);
  if (isStop) return isLimit ? "stop_limit" : "stop_market";
  return isLimit ? "limit" : "market";
}

export function mapSide(side: unknown): OrderSide {
  if (side === "buy" || side === "sell") return side;
  throw new BrokerError("schema_drift", `unexpected order side ${String(side)}`);
}

export function mapTimeInForce(v: unknown): TimeInForce {
  return v === "gtc" ? "gtc" : "gfd";
}

export function mapMarketHours(v: unknown): MarketHours {
  return v === "extended_hours" || v === "all_day_hours" ? v : "regular_hours";
}

// ---- account -------------------------------------------------------------

export function mapAccount(raw: z.infer<typeof AccountSchema>, receivedAt: IsoTimestamp): BrokerAccountListing {
  const optionLevel = raw.option_level ?? "";
  const type = raw.type;
  return {
    kind: "robinhood_agentic",
    accountNumber: raw.account_number,
    rhsAccountNumber: raw.rhs_account_number ?? null,
    cryptoAccountNumber: raw.rhc_account_number ?? null,
    accountType: type === "cash" || type === "margin" || type === "limited_margin" ? type : "unknown",
    brokerageAccountType: raw.brokerage_account_type ?? "unknown",
    nickname: raw.nickname ?? null,
    isDefault: raw.is_default === true,
    agenticAllowed: raw.agentic_allowed === true,
    optionLevel,
    optionsEnabled: optionLevel.length > 0 && optionLevel !== "option_level_0",
    state: raw.state ?? "unknown",
    deactivated: raw.deactivated === true,
    permanentlyDeactivated: raw.permanently_deactivated === true,
    provenance: mcpProvenance("get_accounts", receivedAt, null, RELIABILITY.account),
    raw,
  };
}

export function mapPortfolio(raw: z.infer<typeof PortfolioData>, scope: TenantScope, receivedAt: IsoTimestamp): PortfolioSnapshot {
  const bp = raw.buying_power ? num(raw.buying_power.buying_power) : null;
  const ubp = raw.buying_power ? num(raw.buying_power.unleveraged_buying_power) : null;
  if (bp === null || ubp === null) {
    throw new BrokerError("schema_drift", "get_portfolio returned no authoritative buying_power; refusing to report a portfolio snapshot", { tool: "get_portfolio" });
  }
  const req = (k: keyof typeof raw): number => {
    const n = num(raw[k]);
    if (n === null) throw new BrokerError("schema_drift", `get_portfolio.${String(k)} is not a decimal`, { tool: "get_portfolio" });
    return n;
  };
  return {
    scope,
    asOf: receivedAt,
    totalValue: req("total_value"),
    equityValue: req("equity_value"),
    optionsValue: req("options_value"),
    cryptoValue: req("crypto_value"),
    cash: req("cash"),
    pendingDeposits: req("pending_deposits"),
    buyingPower: bp,
    unleveragedBuyingPower: ubp,
    currency: raw.currency,
    provenance: mcpProvenance("get_portfolio", receivedAt, null, RELIABILITY.account),
  };
}

export function mapPosition(raw: z.infer<typeof PositionSchema>, scope: TenantScope, receivedAt: IsoTimestamp, quote: Quote | null = null): Position {
  const quantity = num(raw.quantity) ?? 0;
  const averageCost = num(raw.average_buy_price);
  const mark = quote && quote.symbol === raw.symbol ? quote.last : null;
  return {
    scope,
    symbol: raw.symbol,
    assetClass: "equity",
    quantity,
    intradayQuantity: num(raw.intraday_quantity) ?? 0,
    sharesAvailableForSells: num(raw.shares_available_for_sells) ?? 0,
    averageCost,
    markPrice: mark,
    marketValue: mark === null ? null : mark * quantity,
    unrealizedPnl: mark === null || averageCost === null ? null : (mark - averageCost) * quantity,
    asOf: receivedAt,
    provenance: mcpProvenance("get_equity_positions", receivedAt, null, RELIABILITY.account),
  };
}

export function mapOrder(raw: RawOrder, scope: TenantScope, receivedAt: IsoTimestamp, refId: string | null = null): BrokerOrder {
  const createdAt = toIso(raw.created_at) ?? receivedAt;
  return {
    scope,
    brokerOrderId: raw.id,
    refId: refId ?? (typeof raw.ref_id === "string" ? raw.ref_id : null),
    symbol: raw.symbol,
    side: mapSide(raw.side),
    type: mapOrderType(raw.type, raw.trigger, raw.price, raw.stop_price),
    state: mapOrderState(raw.state),
    quantity: num(raw.quantity),
    cumulativeQuantity: num(raw.cumulative_quantity) ?? 0,
    limitPrice: num(raw.price),
    stopPrice: num(raw.stop_price),
    averagePrice: num(raw.average_price),
    fees: num(raw.fees) ?? 0,
    timeInForce: mapTimeInForce(raw.time_in_force),
    marketHours: mapMarketHours(raw.market_hours),
    placedAgent: raw.placed_agent ?? null,
    createdAt,
    updatedAt: toIso(raw.last_transaction_at) ?? createdAt,
    raw,
  };
}

export function mapTaxLot(raw: z.infer<typeof TaxLotSchema>, scope: TenantScope, symbol: string): TaxLot {
  const term = raw.term;
  return {
    scope,
    symbol,
    lotId: raw.open_lot_id,
    quantity: num(raw.quantity) ?? 0,
    quantityAvailable: num(raw.quantity_available) ?? 0,
    costPerShare: num(raw.cost_per_share),
    openDate: raw.open_date && raw.open_date.length > 0 ? raw.open_date : null,
    term: term === "st" || term === "lt" ? term : term && term.length > 0 && term !== "unknown" ? "other" : "unknown",
  };
}

// ---- orders → tool args ----------------------------------------------------

export function toOrderArgs(req: OrderRequest, accountNumber: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    account_number: accountNumber,
    symbol: req.symbol,
    side: req.side,
    type: req.type,
    time_in_force: req.timeInForce,
    market_hours: req.marketHours,
  };
  if (req.quantity !== null) args.quantity = decimalString(req.quantity, 6);
  if (req.dollarAmount !== null) args.dollar_amount = decimalString(req.dollarAmount, 2);
  if (req.limitPrice !== null) args.limit_price = decimalString(req.limitPrice, 4);
  if (req.stopPrice !== null) args.stop_price = decimalString(req.stopPrice, 4);
  return args;
}

// ---- fills -----------------------------------------------------------------

/**
 * Robinhood exposes no executions feed, so fills are derived from successive order snapshots:
 * the increase in cumulative quantity is one fill, priced from the change in the notional
 * (average_price × cumulative_quantity). When the price cannot be derived no fill is fabricated.
 */
export function deriveFills(prev: BrokerOrder | null, next: BrokerOrder): Fill[] {
  if (prev) {
    assertSameScope(next.scope, prev.scope, "deriveFills");
    if (prev.brokerOrderId !== next.brokerOrderId) throw new BrokerError("invalid_request", "deriveFills: order snapshots belong to different orders");
  }
  const prevCum = prev?.cumulativeQuantity ?? 0;
  const delta = next.cumulativeQuantity - prevCum;
  if (!(delta > 1e-9)) return [];
  if (next.averagePrice === null) return [];
  const prevAvg = prev?.averagePrice ?? null;
  let price = next.averagePrice;
  if (prevCum > 0 && prevAvg !== null) {
    const derived = (next.averagePrice * next.cumulativeQuantity - prevAvg * prevCum) / delta;
    if (Number.isFinite(derived) && derived > 0) price = derived;
  }
  const fees = Math.max(0, next.fees - (prev?.fees ?? 0));
  return [
    {
      scope: next.scope,
      brokerOrderId: next.brokerOrderId,
      symbol: next.symbol,
      side: next.side,
      quantity: delta,
      price: Math.round(price * 1e6) / 1e6,
      fees,
      derived: true,
      at: next.updatedAt,
    },
  ];
}

// ---- quotes ----------------------------------------------------------------

const etParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });

/** Session of a non-regular print by its New York wall-clock time. */
export function sessionFromTimestamp(iso: IsoTimestamp): Quote["session"] {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  let hour = 0;
  let minute = 0;
  for (const p of etParts.formatToParts(d)) {
    if (p.type === "hour") hour = Number(p.value) % 24;
    if (p.type === "minute") minute = Number(p.value);
  }
  const m = hour * 60 + minute;
  if (m >= 240 && m < 570) return "pre";
  if (m >= 570 && m < 960) return "regular";
  if (m >= 960 && m < 1200) return "post";
  return "overnight";
}

export function mapQuote(raw: RawQuote, receivedAt: IsoTimestamp): Quote | null {
  const regPrice = num(raw.last_trade_price);
  const regTime = toIso(raw.venue_last_trade_time);
  const nonRegPrice = num(raw.last_non_reg_trade_price);
  const nonRegTime = toIso(raw.venue_last_non_reg_trade_time);
  const useNonReg = nonRegPrice !== null && nonRegPrice > 0 && nonRegTime !== null && (regTime === null || Date.parse(nonRegTime) > Date.parse(regTime));
  const last = useNonReg ? nonRegPrice : regPrice;
  if (last === null || last <= 0 || raw.has_traded === false) return null;
  const bid = num(raw.bid_price);
  const ask = num(raw.ask_price);
  const lastTradeAt = useNonReg ? nonRegTime : regTime;
  const state = raw.state;
  return {
    symbol: raw.symbol,
    last,
    bid: bid !== null && bid > 0 ? bid : null,
    ask: ask !== null && ask > 0 ? ask : null,
    previousClose: num(raw.adjusted_previous_close) ?? num(raw.previous_close),
    lastTradeAt,
    session: useNonReg ? sessionFromTimestamp(nonRegTime) : regTime ? "regular" : "unknown",
    instrumentState: state === "active" || state === "inactive" || state === "delisted" || state === "unlisted" ? state : "unknown",
    provenance: mcpProvenance("get_equity_quotes", receivedAt, lastTradeAt, RELIABILITY.quotes),
  };
}

// ---- bars ------------------------------------------------------------------

/** Platform interval → server interval and how many server bars make one platform bar. */
export function toServerInterval(interval: BarInterval): { server: string; aggregate: number } {
  switch (interval) {
    case "15minute":
      return { server: "5minute", aggregate: 3 };
    default:
      return { server: interval, aggregate: 1 };
  }
}

export function mapBar(raw: RawBar, symbol: string, interval: BarInterval, adjusted: Bar["adjusted"], receivedAt: IsoTimestamp): Bar | null {
  const time = toIso(raw.begins_at);
  const open = num(raw.open_price);
  const high = num(raw.high_price);
  const low = num(raw.low_price);
  const close = num(raw.close_price);
  if (time === null || open === null || high === null || low === null || close === null) return null;
  return {
    symbol,
    interval,
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(raw.volume) ? raw.volume : 0,
    interpolated: raw.interpolated === true,
    adjusted,
    provenance: mcpProvenance("get_equity_historicals", receivedAt, time, RELIABILITY.bars),
  };
}

const INTERVAL_MS: Partial<Record<BarInterval, number>> = { minute: 60_000, "5minute": 300_000, "10minute": 600_000, "15minute": 900_000, "30minute": 1_800_000, hour: 3_600_000, "4hour": 14_400_000 };

/** Aggregates finer bars into `target` bars aligned to the target interval's boundaries (UTC). */
export function aggregateBars(bars: Bar[], target: BarInterval): Bar[] {
  const size = INTERVAL_MS[target];
  if (!size) return bars;
  const out: Bar[] = [];
  let current: Bar | null = null;
  let bucket = -1;
  for (const b of bars) {
    const t = Date.parse(b.time);
    const key = Math.floor(t / size);
    if (current && key === bucket) {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += b.volume;
      current.interpolated = current.interpolated && b.interpolated;
    } else {
      current = { ...b, interval: target, time: new Date(key * size).toISOString() };
      if (current.provenance) current.provenance = { ...current.provenance, observedAt: current.time };
      out.push(current);
      bucket = key;
    }
  }
  return out;
}

// ---- tradability -----------------------------------------------------------

export function mapTradability(raw: RawTradability, brokerageAccountType: string, receivedAt: IsoTimestamp): Tradability {
  const haltSessions = raw.internal_halt_sessions ?? [];
  const rule = raw.account_type_tradabilities?.find((a) => a.account_type === brokerageAccountType)?.account_type_tradability;
  const allDay = raw.all_day_tradability === "tradable";
  return {
    symbol: raw.symbol,
    tradeable: raw.tradeable === true && raw.state !== "inactive",
    fractional: raw.fractional_tradability === "tradable",
    extendedHours: allDay,
    allDay,
    shortable: raw.short_selling_tradability === "tradable",
    halted: haltSessions.length > 0 || (typeof raw.internal_halt_reason === "string" && raw.internal_halt_reason.length > 0),
    haltReason: raw.internal_halt_details || raw.internal_halt_reason || null,
    accountRule: rule === "tradable" || rule === "untradable" || rule === "position_closing_only" ? rule : "unknown",
    provenance: mcpProvenance("get_equity_tradability", receivedAt, null, RELIABILITY.reference),
  };
}

/** Extracts the `cursor` query param from a `next` page URL (or treats a bare token as the cursor). */
export function cursorFromNext(next: string | undefined | null): string | null {
  if (!next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    return next;
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
