/**
 * `RobinhoodAgenticAdapter` — BrokerAdapter over Robinhood's official Agentic Trading MCP.
 *
 * Bound to one (userId, brokerAccountId, accountNumber). Every account-scoped call sends the
 * bound account number; any request that names another scope or account number is refused
 * with `CrossTenantError` before anything leaves the process.
 */
import type { Bar, BrokerOrder, OrderBook, OrderRequest, OrderReview, PortfolioSnapshot, Position, Quote, TaxLot, TenantScope, Tradability } from "@yz/core";
import { CrossTenantError, assertScope, assertSameScope } from "@yz/core";
import type {
  AdapterBinding,
  AdapterStatus,
  AnalystRatings,
  BarsOptions,
  BrokerAccountListing,
  BrokerAdapter,
  EarningsCalendarRange,
  EarningsRecord,
  GetOrdersOptions,
  IndexBar,
  IndexHistoricalsOptions,
  IndexQuote,
  IndexRef,
  NewsArticle,
  OptionInstrumentsFilter,
  QuoteLookup,
  RawRecord,
  RealizedPnl,
  RealizedPnlSpan,
  SearchResults,
} from "../adapter.js";
import { BrokerError, isBrokerError, maskAccountNumber } from "../errors.js";
import { REVIEW_MAX_AGE_MS, assertOrderRequestValid, assertReviewUsable } from "../orderRules.js";
import { RELIABILITY, mcpProvenance, toIso } from "../provenance.js";
import {
  aggregateBars,
  chunk,
  cursorFromNext,
  mapAccount,
  mapBar,
  mapOrder,
  mapPortfolio,
  mapPosition,
  mapQuote,
  mapTaxLot,
  mapTradability,
  num,
  toOrderArgs,
  toServerInterval,
} from "./mapping.js";
import type { z } from "zod";
import type { RobinhoodMcpClient } from "./mcpClient.js";
import {
  AccountsData,
  AnalystRatingsData,
  CancelOrderData,
  EarningsData,
  HistoricalsData,
  IndexHistoricalsData,
  IndexQuotesData,
  IndexesData,
  NewsData,
  OptionChainsData,
  OptionInstrumentsData,
  OptionQuotesData,
  OrdersData,
  PlaceOrderData,
  PortfolioData,
  PositionSchema,
  PositionsData,
  PriceBookData,
  QuotesData,
  RealizedPnlData,
  ReviewData,
  SearchData,
  SymbolResultsData,
  TaxLotsData,
  TradabilityData,
  compact,
  parseData,
} from "./schemas.js";

type RawPosition = z.infer<typeof PositionSchema>;

export interface RobinhoodAdapterOptions {
  scope: TenantScope;
  accountNumber: string;
  client: RobinhoodMcpClient;
  clock?: () => number;
  /** Shared market-data lookup used to mark positions. Without it `markPrice` stays null. */
  quoteLookup?: QuoteLookup | null;
  /** Brokerage account type used to select the matching `account_type_tradabilities` rule. */
  brokerageAccountType?: string;
  reviewMaxAgeMs?: number;
}

const BLOCKING_ALERT_RE = /INSUFFICIENT|NOT_ENOUGH|HALT|UNTRADABLE|NOT_TRADABLE|RESTRICT|PDT|PATTERN_DAY|CLOSING_ONLY|MARGIN_CALL|REJECT|INVALID|EXCEED|LOCKED|NO_BUYING_POWER|DEACTIVATED|NOT_ALLOWED|UNAVAILABLE/i;

/** `order_checks` → alerts. Unknown alert types are warnings; the risk engine decides what to do with them. */
export function alertsFromOrderChecks(checks: Record<string, unknown>): OrderReview["alerts"] {
  const keys = Object.keys(checks ?? {});
  if (keys.length === 0) return [];
  const alertType = typeof checks.alert_type === "string" ? checks.alert_type : null;
  if (!alertType) return [{ code: "UNKNOWN_ALERT", severity: "warning", message: `unrecognised order_checks shape (${keys.join(", ")})` }];
  const detailsKey = `${alertType.toLowerCase()}_alert_details`;
  const details = checks[detailsKey];
  let message = alertType;
  if (typeof details === "object" && details !== null) {
    const d = details as Record<string, unknown>;
    const text = [d.message, d.description, d.title, d.reason].find((v): v is string => typeof v === "string");
    if (text) message = `${alertType}: ${text}`;
  }
  return [{ code: alertType, severity: BLOCKING_ALERT_RE.test(alertType) ? "blocking" : "warning", message }];
}

export class RobinhoodAgenticAdapter implements BrokerAdapter {
  readonly binding: AdapterBinding;
  private readonly client: RobinhoodMcpClient;
  private readonly clock: () => number;
  private readonly quoteLookup: QuoteLookup | null;
  private readonly brokerageAccountType: string;
  private readonly reviewMaxAgeMs: number;

  constructor(opts: RobinhoodAdapterOptions) {
    assertScope(opts.scope, "RobinhoodAgenticAdapter");
    if (typeof opts.accountNumber !== "string" || opts.accountNumber.length === 0) throw new BrokerError("invalid_request", "adapter requires a bound account number");
    this.binding = Object.freeze({ scope: Object.freeze({ userId: opts.scope.userId, brokerAccountId: opts.scope.brokerAccountId }), accountNumber: opts.accountNumber, kind: "robinhood_agentic" as const });
    this.client = opts.client;
    this.clock = opts.clock ?? Date.now;
    this.quoteLookup = opts.quoteLookup ?? null;
    this.brokerageAccountType = opts.brokerageAccountType ?? "individual";
    this.reviewMaxAgeMs = opts.reviewMaxAgeMs ?? REVIEW_MAX_AGE_MS;
  }

  // ---- tenancy guard ---------------------------------------------------------

  /** Refuses any request for another scope or account number. */
  private guard(req: { scope: TenantScope; accountNumber: string }, context: string): void {
    assertSameScope(this.binding.scope, req.scope, context);
    if (req.accountNumber !== this.binding.accountNumber) {
      throw new CrossTenantError(`${context}: request targets account ${maskAccountNumber(req.accountNumber)} but this adapter is bound to ${maskAccountNumber(this.binding.accountNumber)}`, this.binding.scope, req.scope);
    }
  }

  private get accountNumber(): string {
    return this.binding.accountNumber;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  // ---- status ----------------------------------------------------------------

  status(): Promise<AdapterStatus> {
    return this.client.status();
  }

  async listTools(): Promise<string[]> {
    return (await this.client.listTools()).map((t) => t.name);
  }

  // ---- account ---------------------------------------------------------------

  async getAccounts(): Promise<BrokerAccountListing[]> {
    const r = await this.client.call("get_accounts", {});
    const data = parseData(AccountsData, r.data, "get_accounts");
    return compact(data.accounts).map((a) => mapAccount(a, r.receivedAt));
  }

  async getPortfolio(): Promise<PortfolioSnapshot> {
    const r = await this.client.call("get_portfolio", { account_number: this.accountNumber });
    return mapPortfolio(parseData(PortfolioData, r.data, "get_portfolio"), this.binding.scope, r.receivedAt);
  }

  private async fetchPositionsRaw(): Promise<{ positions: RawPosition[]; receivedAt: string }> {
    const args: Record<string, unknown> = { account_number: this.accountNumber };
    const all: RawPosition[] = [];
    let receivedAt = this.nowIso();
    for (let page = 0; page < 10; page++) {
      const r = await this.client.call("get_equity_positions", args);
      receivedAt = r.receivedAt;
      const data = parseData(PositionsData, r.data, "get_equity_positions");
      all.push(...compact(data.positions));
      const cursor = cursorFromNext(data.next);
      if (!cursor) break;
      args.cursor = cursor;
    }
    return { positions: all, receivedAt };
  }

  async getPositions(): Promise<Position[]> {
    const { positions, receivedAt } = await this.fetchPositionsRaw();
    let quotes = new Map<string, Quote>();
    if (this.quoteLookup && positions.length > 0) {
      const qs = await this.quoteLookup(positions.map((p) => p.symbol));
      quotes = new Map(qs.map((q) => [q.symbol, q]));
    }
    return positions.map((p) => mapPosition(p, this.binding.scope, receivedAt, quotes.get(p.symbol) ?? null));
  }

  async getOrders(opts: GetOrdersOptions = {}): Promise<BrokerOrder[]> {
    const args: Record<string, unknown> = { account_number: this.accountNumber };
    if (opts.orderId) args.order_id = opts.orderId;
    if (opts.state && opts.state !== "unknown") args.state = opts.state;
    if (opts.symbol) args.symbol = opts.symbol;
    if (opts.since) args.created_at_gte = opts.since;
    const maxPages = opts.maxPages ?? 5;
    const out: BrokerOrder[] = [];
    for (let page = 0; page < maxPages; page++) {
      const r = await this.client.call("get_equity_orders", args);
      const data = parseData(OrdersData, r.data, "get_equity_orders");
      out.push(...compact(data.orders).map((o) => mapOrder(o, this.binding.scope, r.receivedAt)));
      const cursor = cursorFromNext(data.next);
      if (!cursor) break;
      args.cursor = cursor;
    }
    return out;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    if (!brokerOrderId) throw new BrokerError("invalid_request", "brokerOrderId is required");
    const orders = await this.getOrders({ orderId: brokerOrderId, maxPages: 1 });
    return orders.find((o) => o.brokerOrderId === brokerOrderId) ?? null;
  }

  async reviewOrder(req: OrderRequest): Promise<OrderReview> {
    this.guard(req, "reviewOrder");
    let sharesAvailable: number | null | undefined;
    if (req.side === "sell") {
      const { positions } = await this.fetchPositionsRaw();
      const pos = positions.find((p) => p.symbol === req.symbol);
      sharesAvailable = pos ? (num(pos.shares_available_for_sells) ?? 0) : null;
    }
    assertOrderRequestValid(req, { sharesAvailable });

    const reviewedAt = this.nowIso();
    let r;
    try {
      r = await this.client.call("review_equity_order", toOrderArgs(req, this.accountNumber));
    } catch (e) {
      if (isBrokerError(e) && e.code === "upstream_rejected") {
        return { ok: false, estimatedCost: null, quote: null, alerts: [{ code: "UPSTREAM_REJECTED", severity: "blocking", message: e.message }], raw: { error: e.toJSON(), symbol: req.symbol, side: req.side, type: req.type }, reviewedAt };
      }
      throw e;
    }
    const data = parseData(ReviewData, r.data, "review_equity_order");
    const alerts = alertsFromOrderChecks(data.order_checks);
    const q = data.quote_data ? mapQuote(data.quote_data, r.receivedAt) : null;
    const quote = q ? { last: q.last, bid: q.bid, ask: q.ask } : null;
    let estimatedCost: number | null = null;
    if (req.dollarAmount !== null) estimatedCost = req.dollarAmount;
    else if (req.quantity !== null) {
      const px = req.limitPrice ?? (req.side === "buy" ? (quote?.ask ?? quote?.last ?? null) : (quote?.bid ?? quote?.last ?? null));
      estimatedCost = px === null ? null : px * req.quantity;
    }
    return { ok: !alerts.some((a) => a.severity === "blocking"), estimatedCost, quote, alerts, raw: data, reviewedAt: r.receivedAt < reviewedAt ? r.receivedAt : reviewedAt };
  }

  async placeOrder(req: OrderRequest, review: OrderReview): Promise<{ order: BrokerOrder }> {
    this.guard(req, "placeOrder");
    assertReviewUsable(review, req, this.clock(), this.reviewMaxAgeMs);
    assertOrderRequestValid(req);
    const args = { ...toOrderArgs(req, this.accountNumber), ref_id: req.refId };
    const r = await this.client.call("place_equity_order", args);
    const data = parseData(PlaceOrderData, r.data, "place_equity_order");
    if (!data.order) {
      throw new BrokerError("unknown", "place_equity_order answered without an order object; verify with get_equity_orders before retrying with the same ref_id", { tool: "place_equity_order", mayHaveReached: true });
    }
    return { order: mapOrder(data.order, this.binding.scope, r.receivedAt, req.refId) };
  }

  async cancelOrder(brokerOrderId: string): Promise<{ accepted: boolean }> {
    if (!brokerOrderId) throw new BrokerError("invalid_request", "brokerOrderId is required");
    const r = await this.client.call("cancel_equity_order", { account_number: this.accountNumber, order_id: brokerOrderId });
    return { accepted: parseData(CancelOrderData, r.data, "cancel_equity_order").accepted === true };
  }

  async getTaxLots(symbol: string): Promise<TaxLot[]> {
    const args: Record<string, unknown> = { account_number: this.accountNumber, symbol };
    const out: TaxLot[] = [];
    for (let page = 0; page < 10; page++) {
      const r = await this.client.call("get_equity_tax_lots", args);
      const data = parseData(TaxLotsData, r.data, "get_equity_tax_lots");
      out.push(...compact(data.tax_lots).map((l) => mapTaxLot(l, this.binding.scope, data.symbol || symbol)));
      const cursor = cursorFromNext(data.next);
      if (!cursor) break;
      args.cursor = cursor;
    }
    return out;
  }

  async getRealizedPnl(span: RealizedPnlSpan): Promise<RealizedPnl> {
    const r = await this.client.call("get_realized_pnl", { account_number: this.accountNumber, span });
    const data = parseData(RealizedPnlData, r.data, "get_realized_pnl");
    return {
      scope: this.binding.scope,
      window: data.window,
      currency: data.display_currency,
      dataPoints: (data.data_points ?? []).map((p) => ({ startTime: toIso(p.start_time), endTime: toIso(p.end_time), realizedGain: num(p.realized_gain), rateOfRealizedGain: num(p.rate_of_realized_gain), numberOfTrades: p.number_of_trades })),
      totalReturns: num(data.total_returns),
      totalRateOfReturn: num(data.total_rate_of_return),
      provenance: mcpProvenance("get_realized_pnl", r.receivedAt, null, RELIABILITY.account),
      raw: data,
    };
  }

  // ---- market data -----------------------------------------------------------

  async getQuotes(symbols: readonly string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const group of chunk(symbols, 20)) {
      const r = await this.client.call("get_equity_quotes", { symbols: group });
      const data = parseData(QuotesData, r.data, "get_equity_quotes");
      for (const entry of compact(data.results)) {
        if (!entry.quote) continue;
        const q = mapQuote(entry.quote, r.receivedAt);
        if (q) out.push(q);
      }
    }
    return out;
  }

  async getBars(symbols: readonly string[], opts: BarsOptions): Promise<Bar[]> {
    const interval = opts.interval ?? "day";
    const { server, aggregate } = toServerInterval(interval);
    const adjustment = opts.adjustment ?? "split";
    const out: Bar[] = [];
    for (const group of chunk(symbols, 10)) {
      const args: Record<string, unknown> = { symbols: group, start_time: opts.start, interval: server, adjustment_type: adjustment };
      if (opts.end) args.end_time = opts.end;
      if (opts.bounds) args.bounds = opts.bounds;
      const r = await this.client.call("get_equity_historicals", args);
      const data = parseData(HistoricalsData, r.data, "get_equity_historicals");
      for (const res of data.results ?? []) {
        const bars: Bar[] = [];
        for (const b of compact(res.bars)) {
          const bar = mapBar(b, res.symbol, aggregate > 1 ? (server as Bar["interval"]) : interval, adjustment, r.receivedAt);
          if (bar) bars.push(bar);
        }
        out.push(...(aggregate > 1 ? aggregateBars(bars, interval) : bars));
      }
    }
    return out;
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    const r = await this.client.call("get_equity_price_book", { symbols: [symbol] });
    const data = parseData(PriceBookData, r.data, "get_equity_price_book");
    const failure = data.errors?.find((e) => e.symbol === symbol);
    const book = compact(data.books).find((b) => b.symbol === symbol);
    if (!book) throw new BrokerError("upstream_rejected", `order book unavailable for ${symbol}${failure ? `: ${failure.error}` : ""}`, { tool: "get_equity_price_book" });
    const level = (l: { price: string; quantity: number }) => ({ price: num(l.price) ?? 0, size: l.quantity });
    return {
      symbol,
      bids: (book.bids ?? []).map(level).filter((l) => l.price > 0),
      asks: (book.asks ?? []).map(level).filter((l) => l.price > 0),
      provenance: mcpProvenance("get_equity_price_book", r.receivedAt, book.updated_at, RELIABILITY.depth),
    };
  }

  async getTradability(symbols: readonly string[]): Promise<Tradability[]> {
    const out: Tradability[] = [];
    for (const group of chunk(symbols, 10)) {
      const r = await this.client.call("get_equity_tradability", { account_number: this.accountNumber, symbols: group });
      const data = parseData(TradabilityData, r.data, "get_equity_tradability");
      out.push(...(data.results ?? []).map((t) => mapTradability(t, this.brokerageAccountType, r.receivedAt)));
    }
    return out;
  }

  async search(query: string): Promise<SearchResults> {
    const r = await this.client.call("search", { query });
    const data = parseData(SearchData, r.data, "search");
    return {
      query,
      equities: (data.results ?? []).map((e) => ({ instrumentId: e.instrument_id, symbol: e.symbol, name: e.name, simpleName: e.simple_name ?? null })),
      currencyPairs: (data.currency_pairs ?? []).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name })),
      indexes: (data.market_indexes ?? []).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name })),
      provenance: mcpProvenance("search", r.receivedAt, null, RELIABILITY.reference),
    };
  }

  private async symbolRecord(tool: "get_equity_fundamentals" | "get_financials", symbol: string): Promise<RawRecord> {
    const r = await this.client.call(tool, { symbols: [symbol] });
    const data = parseData(SymbolResultsData, r.data, tool);
    const rec = compact(data.results).find((x) => x.symbol === symbol) ?? compact(data.results)[0] ?? null;
    if (!rec) throw new BrokerError("upstream_rejected", `${tool}: no result for ${symbol}`, { tool });
    return { symbol, data: rec, provenance: mcpProvenance(tool, r.receivedAt, typeof rec.market_date === "string" ? rec.market_date : null, RELIABILITY.reference) };
  }

  getFundamentals(symbol: string): Promise<RawRecord> {
    return this.symbolRecord("get_equity_fundamentals", symbol);
  }

  getFinancials(symbol: string): Promise<RawRecord> {
    return this.symbolRecord("get_financials", symbol);
  }

  async getAnalystRatings(symbol: string): Promise<AnalystRatings | null> {
    const r = await this.client.call("get_equity_analyst_ratings", { symbols: [symbol] });
    const data = parseData(AnalystRatingsData, r.data, "get_equity_analyst_ratings");
    const rec = compact(data.results).find((x) => x.symbol === symbol);
    if (!rec?.ratings) return null;
    const ratings = rec.ratings;
    return {
      symbol,
      buy: ratings.num_buy_ratings,
      hold: ratings.num_hold_ratings,
      sell: ratings.num_sell_ratings,
      highPriceTarget: num(ratings.high_price_target),
      lowPriceTarget: num(ratings.low_price_target),
      meanPriceTarget: num(ratings.mean_price_target),
      updatedAt: toIso(ratings.updated_at),
      provenance: mcpProvenance("get_equity_analyst_ratings", r.receivedAt, ratings.updated_at, RELIABILITY.reference),
    };
  }

  async getNews(symbol: string): Promise<NewsArticle[]> {
    const r = await this.client.call("get_equity_news", { symbol });
    const data = parseData(NewsData, r.data, "get_equity_news");
    return compact(data.articles).map((a) => ({
      id: a.id,
      symbol: data.symbol || symbol,
      title: a.title,
      publisher: a.publisher,
      previewText: a.preview_text ?? null,
      content: a.content ?? null,
      publishedAt: toIso(a.published_at),
      sourceType: a.source_type,
      provenance: mcpProvenance("get_equity_news", r.receivedAt, a.published_at, RELIABILITY.reference),
    }));
  }

  private mapEarnings(tool: "get_earnings_results" | "get_earnings_calendar", data: ReturnType<typeof EarningsData.parse>, receivedAt: string): EarningsRecord[] {
    return compact(data.results).map((e) => ({
      symbol: e.symbol,
      year: e.year,
      quarter: e.quarter,
      epsEstimate: num(e.eps.estimate),
      epsActual: num(e.eps.actual),
      reportDate: e.report?.date ?? null,
      reportTiming: e.report?.timing ?? null,
      verified: e.report?.verified === true,
      provenance: mcpProvenance(tool, receivedAt, null, RELIABILITY.reference),
    }));
  }

  async getEarnings(symbol: string): Promise<EarningsRecord[]> {
    const r = await this.client.call("get_earnings_results", { symbol });
    return this.mapEarnings("get_earnings_results", parseData(EarningsData, r.data, "get_earnings_results"), r.receivedAt);
  }

  async getEarningsCalendar(range: EarningsCalendarRange): Promise<EarningsRecord[]> {
    const args: Record<string, unknown> = {};
    if (range.startDate) args.start_date = range.startDate;
    if (range.days !== undefined) args.days = range.days;
    if (range.filter) args.filter = range.filter;
    const r = await this.client.call("get_earnings_calendar", args);
    return this.mapEarnings("get_earnings_calendar", parseData(EarningsData, r.data, "get_earnings_calendar"), r.receivedAt);
  }

  async getIndexes(symbols?: readonly string[]): Promise<IndexRef[]> {
    const args: Record<string, unknown> = {};
    if (symbols && symbols.length > 0) args.symbols = symbols.join(",");
    const r = await this.client.call("get_indexes", args);
    const data = parseData(IndexesData, r.data, "get_indexes");
    return compact(data.indexes).map((i) => ({
      id: i.id,
      symbol: i.symbol,
      name: i.name,
      currentValue: num(i.current_value),
      tradeHalted: i.trade_halted,
      updatedAt: toIso(i.updated_at),
      provenance: mcpProvenance("get_indexes", r.receivedAt, i.updated_at, RELIABILITY.quotes),
    }));
  }

  async getIndexQuotes(instrumentIds: readonly string[]): Promise<IndexQuote[]> {
    const r = await this.client.call("get_index_quotes", { instrument_ids: [...instrumentIds] });
    const data = parseData(IndexQuotesData, r.data, "get_index_quotes");
    const out: IndexQuote[] = [];
    for (const q of compact(data.quotes)) {
      const value = num(q.value);
      if (value === null) continue;
      out.push({ instrumentId: q.instrument_id, symbol: q.symbol, value, state: q.state, venueTimestamp: toIso(q.venue_timestamp), provenance: mcpProvenance("get_index_quotes", r.receivedAt, q.venue_timestamp, RELIABILITY.quotes) });
    }
    return out;
  }

  async getIndexHistoricals(instrumentIds: readonly string[], opts: IndexHistoricalsOptions): Promise<IndexBar[]> {
    const args: Record<string, unknown> = { instrument_ids: [...instrumentIds], start_time: opts.start, interval: opts.interval };
    if (opts.end) args.end_time = opts.end;
    const r = await this.client.call("get_index_historicals", args);
    const data = parseData(IndexHistoricalsData, r.data, "get_index_historicals");
    const out: IndexBar[] = [];
    for (const res of compact(data.results)) {
      for (const b of compact(res.bars)) {
        const time = toIso(b.begins_at);
        const open = num(b.open_value);
        const high = num(b.high_value);
        const low = num(b.low_value);
        const close = num(b.close_value);
        if (time === null || open === null || high === null || low === null || close === null) continue;
        out.push({ instrumentId: res.instrument_id, symbol: res.symbol, interval: res.interval, time, open, high, low, close, interpolated: b.interpolated === true, provenance: mcpProvenance("get_index_historicals", r.receivedAt, time, RELIABILITY.bars) });
      }
    }
    return out;
  }

  async getOptionChains(underlyingSymbol: string): Promise<RawRecord[]> {
    const r = await this.client.call("get_option_chains", { underlying_symbol: underlyingSymbol });
    const data = parseData(OptionChainsData, r.data, "get_option_chains");
    return compact(data.chains).map((c) => ({ symbol: typeof c.symbol === "string" ? c.symbol : underlyingSymbol, data: c, provenance: mcpProvenance("get_option_chains", r.receivedAt, null, RELIABILITY.reference) }));
  }

  async getOptionInstruments(filter: OptionInstrumentsFilter): Promise<RawRecord[]> {
    const args: Record<string, unknown> = {};
    if (filter.chainId) args.chain_id = filter.chainId;
    if (filter.chainSymbol) args.chain_symbol = filter.chainSymbol;
    if (filter.expirationDates) args.expiration_dates = filter.expirationDates;
    if (filter.strikePrice) args.strike_price = filter.strikePrice;
    if (filter.type) args.type = filter.type;
    if (filter.state) args.state = filter.state;
    if (filter.tradability) args.tradability = filter.tradability;
    if (filter.ids) args.ids = filter.ids;
    const r = await this.client.call("get_option_instruments", args);
    const data = parseData(OptionInstrumentsData, r.data, "get_option_instruments");
    return compact(data.instruments).map((i) => ({ symbol: typeof i.chain_symbol === "string" ? i.chain_symbol : null, data: i, provenance: mcpProvenance("get_option_instruments", r.receivedAt, null, RELIABILITY.reference) }));
  }

  async getOptionQuotes(instrumentIds: readonly string[]): Promise<RawRecord[]> {
    const r = await this.client.call("get_option_quotes", { instrument_ids: [...instrumentIds] });
    const data = parseData(OptionQuotesData, r.data, "get_option_quotes");
    return compact(data.results)
      .filter((x) => x.quote !== null)
      .map((x) => ({ symbol: null, data: x.quote as Record<string, unknown>, provenance: mcpProvenance("get_option_quotes", r.receivedAt, null, RELIABILITY.quotes) }));
  }
}
