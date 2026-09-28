/**
 * zod schemas for the official tool outputs we depend on (docs/robinhood/official-mcp-tools.observed.json).
 * Loose (`passthrough`) on extra fields, strict on the fields the adapter reads: a changed field
 * shape is reported as `schema_drift` instead of being silently mapped to a wrong number.
 */
import { z } from "zod";
import { BrokerError } from "../errors.js";

const dec = z.string();
const decNull = z.string().nullable();
const decOpt = z.string().nullable().optional();

export const AccountSchema = z
  .object({
    account_number: z.string(),
    rhs_account_number: z.string().optional(),
    rhc_account_number: z.string().optional(),
    type: z.string(),
    brokerage_account_type: z.string().optional(),
    nickname: z.string().optional(),
    is_default: z.boolean().optional(),
    agentic_allowed: z.boolean(),
    option_level: z.string().optional(),
    state: z.string().optional(),
    deactivated: z.boolean().optional(),
    permanently_deactivated: z.boolean().optional(),
  })
  .passthrough();
export const AccountsData = z.object({ accounts: z.array(AccountSchema.nullable()).nullable() }).passthrough();

export const PortfolioData = z
  .object({
    total_value: dec,
    equity_value: dec,
    options_value: dec,
    crypto_value: dec,
    cash: dec,
    pending_deposits: dec,
    currency: z.string(),
    buying_power: z.object({ buying_power: dec, unleveraged_buying_power: dec }).passthrough().nullable(),
  })
  .passthrough();

export const PositionSchema = z
  .object({
    symbol: z.string(),
    quantity: dec,
    intraday_quantity: dec,
    average_buy_price: decOpt,
    shares_available_for_sells: dec,
    type: z.string().optional(),
  })
  .passthrough();
export const PositionsData = z.object({ positions: z.array(PositionSchema.nullable()).nullable(), next: z.string().optional() }).passthrough();

export const ExecutionSchema = z.object({ id: z.string(), price: dec, quantity: dec, timestamp: z.string(), fees: dec }).passthrough();

export const OrderSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    side: z.string(),
    type: z.string(),
    state: z.string(),
    quantity: decNull,
    cumulative_quantity: dec,
    price: decNull,
    stop_price: decNull,
    average_price: decNull,
    fees: dec.optional(),
    dollar_based_amount: z.object({ amount: dec, currency_code: z.string() }).passthrough().nullable().optional(),
    time_in_force: z.string().optional(),
    market_hours: z.string().optional(),
    trigger: z.string().optional(),
    placed_agent: z.string().optional(),
    created_at: z.string(),
    last_transaction_at: z.string().nullable().optional(),
    executions: z.array(ExecutionSchema).nullable().optional(),
    reject_reason: z.string().optional(),
    ref_id: z.string().optional(),
  })
  .passthrough();
export type RawOrder = z.infer<typeof OrderSchema>;
export const OrdersData = z.object({ orders: z.array(OrderSchema.nullable()).nullable(), next: z.string().optional() }).passthrough();
export const PlaceOrderData = z.object({ order: OrderSchema.nullable().optional() }).passthrough();
export const CancelOrderData = z.object({ accepted: z.boolean() }).passthrough();

export const QuoteSchema = z
  .object({
    symbol: z.string(),
    last_trade_price: dec,
    venue_last_trade_time: z.string().optional(),
    last_non_reg_trade_price: decOpt,
    venue_last_non_reg_trade_time: z.string().nullable().optional(),
    adjusted_previous_close: dec.optional(),
    previous_close: dec.optional(),
    bid_price: dec.optional(),
    venue_bid_time: z.string().optional(),
    ask_price: dec.optional(),
    venue_ask_time: z.string().optional(),
    has_traded: z.boolean().optional(),
    state: z.string().optional(),
  })
  .passthrough();
export type RawQuote = z.infer<typeof QuoteSchema>;
export const QuotesData = z
  .object({
    results: z.array(z.object({ quote: QuoteSchema.nullable(), close: z.unknown().optional() }).passthrough().nullable()).nullable(),
    closes_error: z.string().optional(),
  })
  .passthrough();

export const ReviewData = z
  .object({
    symbol: z.string(),
    side: z.string(),
    type: z.string(),
    quantity: z.string().optional(),
    dollar_amount: z.string().optional(),
    limit_price: z.string().optional(),
    stop_price: z.string().optional(),
    order_checks: z.record(z.unknown()),
    quote_data: QuoteSchema.nullable(),
    market_data_disclosure: z.string().optional(),
  })
  .passthrough();

export const BarSchema = z
  .object({
    begins_at: z.string(),
    open_price: dec,
    close_price: dec,
    high_price: dec,
    low_price: dec,
    volume: z.number(),
    session: z.string().optional(),
    interpolated: z.boolean().optional(),
  })
  .passthrough();
export type RawBar = z.infer<typeof BarSchema>;
export const HistoricalsData = z
  .object({
    results: z.array(z.object({ symbol: z.string(), interval: z.string(), bounds: z.string().optional(), bars: z.array(BarSchema.nullable()).nullable() }).passthrough()).nullable(),
    not_found: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const LevelSchema = z.object({ price: dec, quantity: z.number() }).passthrough();
export const PriceBookData = z
  .object({
    books: z.array(z.object({ symbol: z.string(), updated_at: z.string().optional(), asks: z.array(LevelSchema).nullable(), bids: z.array(LevelSchema).nullable() }).passthrough().nullable()).nullable(),
    errors: z.array(z.object({ symbol: z.string(), error: z.string() }).passthrough()).nullable().optional(),
  })
  .passthrough();

export const TradabilitySchema = z
  .object({
    symbol: z.string(),
    tradeable: z.boolean(),
    state: z.string().optional(),
    fractional_tradability: z.string().optional(),
    all_day_tradability: z.string().optional(),
    twenty_four_seven_tradability: z.string().optional(),
    short_selling_tradability: z.string().optional(),
    internal_halt_reason: z.string().optional(),
    internal_halt_details: z.string().optional(),
    internal_halt_sessions: z.array(z.string()).nullable().optional(),
    account_type_tradabilities: z.array(z.object({ account_type: z.string(), account_type_tradability: z.string() }).passthrough()).nullable().optional(),
  })
  .passthrough();
export type RawTradability = z.infer<typeof TradabilitySchema>;
export const TradabilityData = z.object({ results: z.array(TradabilitySchema).nullable(), not_found: z.array(z.string()).nullable().optional() }).passthrough();

export const TaxLotSchema = z
  .object({
    open_lot_id: z.string(),
    quantity: dec,
    quantity_available: dec,
    is_selectable: z.boolean(),
    cost_per_share: decOpt,
    tax_cost_basis: decOpt,
    open_date: z.string().optional(),
    term: z.string().optional(),
    order_id: z.string().optional(),
  })
  .passthrough();
export const TaxLotsData = z.object({ symbol: z.string(), tax_lots: z.array(TaxLotSchema.nullable()).nullable(), next: z.string().optional() }).passthrough();

export const RealizedPnlData = z
  .object({
    window: z.string(),
    display_currency: z.string(),
    data_points: z
      .array(z.object({ start_time: z.string(), end_time: z.string(), realized_gain: decNull, rate_of_realized_gain: decNull, number_of_trades: z.number() }).passthrough())
      .nullable(),
    total_returns: z.string(),
    total_rate_of_return: z.string(),
  })
  .passthrough();

const NamedRef = z.object({ id: z.string(), symbol: z.string(), name: z.string() }).passthrough();
export const SearchData = z
  .object({
    results: z.array(z.object({ instrument_id: z.string(), symbol: z.string(), name: z.string(), simple_name: z.string().optional() }).passthrough()).nullable().optional(),
    currency_pairs: z.array(NamedRef).nullable().optional(),
    market_indexes: z.array(NamedRef).nullable().optional(),
  })
  .passthrough();

export const PopularWatchlistsData = z
  .object({ lists: z.array(z.object({ id: z.string(), display_name: z.string(), item_count: z.number().optional() }).passthrough().nullable()).nullable().optional() })
  .passthrough();
export const WatchlistItemsData = z
  .object({ items: z.array(z.object({ symbol: z.string().optional(), object_type: z.string().optional() }).passthrough().nullable()).nullable().optional() })
  .passthrough();

const EarningsSchema = z
  .object({
    symbol: z.string(),
    year: z.number(),
    quarter: z.number(),
    eps: z.object({ estimate: decNull, actual: decNull }).passthrough(),
    report: z.object({ date: z.string().nullable(), timing: z.string().nullable(), verified: z.boolean() }).passthrough().nullable(),
  })
  .passthrough();
export const EarningsData = z.object({ results: z.array(EarningsSchema.nullable()).nullable() }).passthrough();

export const AnalystRatingsData = z
  .object({
    results: z
      .array(
        z
          .object({
            symbol: z.string(),
            ratings: z
              .object({
                num_buy_ratings: z.number(),
                num_hold_ratings: z.number(),
                num_sell_ratings: z.number(),
                high_price_target: decOpt,
                low_price_target: decOpt,
                mean_price_target: decOpt,
                updated_at: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable(),
      )
      .nullable(),
  })
  .passthrough();

export const NewsData = z
  .object({
    symbol: z.string(),
    articles: z
      .array(
        z
          .object({ id: z.string(), title: z.string(), publisher: z.string(), preview_text: z.string().optional(), content: z.string().optional(), published_at: z.string(), source_type: z.string() })
          .passthrough()
          .nullable(),
      )
      .nullable(),
  })
  .passthrough();

export const IndexesData = z
  .object({
    indexes: z.array(z.object({ id: z.string(), symbol: z.string(), name: z.string(), current_value: z.string(), trade_halted: z.boolean(), updated_at: z.string() }).passthrough().nullable()).nullable(),
  })
  .passthrough();

export const IndexQuotesData = z
  .object({
    quotes: z.array(z.object({ instrument_id: z.string(), symbol: z.string(), value: z.string(), state: z.string(), venue_timestamp: z.string(), updated_at: z.string().optional() }).passthrough().nullable()).nullable(),
  })
  .passthrough();

export const IndexHistoricalsData = z
  .object({
    results: z
      .array(
        z
          .object({
            instrument_id: z.string(),
            symbol: z.string(),
            interval: z.string(),
            bars: z.array(z.object({ begins_at: z.string(), open_value: dec, high_value: dec, low_value: dec, close_value: dec, interpolated: z.boolean().optional() }).passthrough().nullable()).nullable(),
          })
          .passthrough()
          .nullable(),
      )
      .nullable(),
  })
  .passthrough();

export const SymbolResultsData = z.object({ results: z.array(z.record(z.unknown()).nullable()).nullable() }).passthrough();
export const OptionChainsData = z.object({ chains: z.array(z.record(z.unknown()).nullable()).nullable() }).passthrough();
export const OptionInstrumentsData = z.object({ instruments: z.array(z.record(z.unknown()).nullable()).nullable() }).passthrough();
export const OptionQuotesData = z.object({ results: z.array(z.object({ quote: z.record(z.unknown()).nullable() }).passthrough().nullable()).nullable() }).passthrough();

/** Parses `data` with `schema`; a mismatch is `schema_drift` (paths only, no values, in details). */
export function parseData<T extends z.ZodTypeAny>(schema: T, data: unknown, tool: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
  throw new BrokerError("schema_drift", `unexpected ${tool} payload shape: ${issues.join("; ")}`, { tool, details: { issues } });
}

/** Drops null entries the official schemas allow inside arrays. */
export function compact<T>(items: (T | null)[] | null | undefined): T[] {
  return (items ?? []).filter((x): x is T => x !== null);
}
