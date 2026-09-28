/**
 * `BrokerAdapter` — the only way capital-touching code talks to a broker.
 *
 * An adapter instance is bound to exactly one (userId, brokerAccountId, accountNumber)
 * triple and refuses any request whose scope or account number differs by throwing
 * `CrossTenantError` from @yz/core. Implementations:
 *
 *  - `RobinhoodAgenticAdapter` (src/robinhood/adapter.ts): Robinhood's official Agentic Trading MCP.
 *  - `SimulatedBrokerAdapter` (src/simulated/adapter.ts): SHADOW mode only, every payload carries `simulated: true`.
 */
import type {
  Bar,
  BarInterval,
  BrokerConnectionStatus,
  BrokerKind,
  BrokerOrder,
  BrokerOrderState,
  DataProvenance,
  Fill,
  IsoTimestamp,
  OrderBook,
  OrderRequest,
  OrderReview,
  PortfolioSnapshot,
  Position,
  Quote,
  TaxLot,
  TenantScope,
  Tradability,
} from "@yz/core";

export interface AdapterBinding {
  readonly scope: TenantScope;
  /** Broker account number this adapter may act on. Masked (last 4) wherever it is displayed or logged. */
  readonly accountNumber: string;
  readonly kind: BrokerKind;
}

export interface AdapterStatus {
  status: BrokerConnectionStatus;
  /** Human-readable, secret-free explanation. */
  detail: string;
  lastHealthyAt: IsoTimestamp | null;
  consecutiveFailures: number;
}

/** `get_accounts` record mapped to platform vocabulary. Not a stored `BrokerAccountRef` (that is the API's job). */
export interface BrokerAccountListing {
  kind: BrokerKind;
  accountNumber: string;
  rhsAccountNumber: string | null;
  cryptoAccountNumber: string | null;
  accountType: "cash" | "margin" | "limited_margin" | "unknown";
  brokerageAccountType: string;
  nickname: string | null;
  isDefault: boolean;
  agenticAllowed: boolean;
  optionLevel: string;
  optionsEnabled: boolean;
  state: string;
  deactivated: boolean;
  permanentlyDeactivated: boolean;
  provenance: DataProvenance;
  raw: unknown;
}

export interface GetOrdersOptions {
  /** Single upstream state filter. */
  state?: BrokerOrderState;
  symbol?: string;
  /** Lower bound on created time (inclusive). */
  since?: IsoTimestamp;
  orderId?: string;
  /** Pages to follow (default 5). */
  maxPages?: number;
}

export type BarBounds = "regular" | "extended" | "trading" | "24_5" | "24_7";
export type BarAdjustment = "none" | "split" | "all";

export interface BarsOptions {
  start: IsoTimestamp;
  end?: IsoTimestamp;
  interval?: BarInterval;
  bounds?: BarBounds;
  adjustment?: BarAdjustment;
}

export interface RealizedPnlPoint {
  startTime: IsoTimestamp | null;
  endTime: IsoTimestamp | null;
  realizedGain: number | null;
  rateOfRealizedGain: number | null;
  numberOfTrades: number;
}

export interface RealizedPnl {
  scope: TenantScope;
  window: string;
  currency: string;
  dataPoints: RealizedPnlPoint[];
  totalReturns: number | null;
  totalRateOfReturn: number | null;
  provenance: DataProvenance;
  raw: unknown;
}

export type RealizedPnlSpan = "day" | "week" | "month" | "3month" | "year" | "all" | string;

export interface SearchResult {
  instrumentId: string;
  symbol: string;
  name: string;
  simpleName: string | null;
}

export interface SearchResults {
  query: string;
  equities: SearchResult[];
  currencyPairs: { id: string; symbol: string; name: string }[];
  indexes: { id: string; symbol: string; name: string }[];
  provenance: DataProvenance;
}

/** A raw upstream record with provenance. Used for reference data that the platform only reads (never trades on directly). */
export interface RawRecord<T = Record<string, unknown>> {
  symbol: string | null;
  data: T;
  provenance: DataProvenance;
}

export interface AnalystRatings {
  symbol: string;
  buy: number;
  hold: number;
  sell: number;
  highPriceTarget: number | null;
  lowPriceTarget: number | null;
  meanPriceTarget: number | null;
  updatedAt: IsoTimestamp | null;
  provenance: DataProvenance;
}

export interface NewsArticle {
  id: string;
  symbol: string;
  title: string;
  publisher: string;
  previewText: string | null;
  content: string | null;
  publishedAt: IsoTimestamp | null;
  sourceType: string;
  provenance: DataProvenance;
}

export interface EarningsRecord {
  symbol: string;
  year: number;
  quarter: number;
  epsEstimate: number | null;
  epsActual: number | null;
  reportDate: string | null;
  reportTiming: string | null;
  verified: boolean;
  provenance: DataProvenance;
}

export interface EarningsCalendarRange {
  startDate?: string;
  days?: number;
  filter?: string;
}

export interface IndexRef {
  id: string;
  symbol: string;
  name: string;
  currentValue: number | null;
  tradeHalted: boolean;
  updatedAt: IsoTimestamp | null;
  provenance: DataProvenance;
}

export interface IndexQuote {
  instrumentId: string;
  symbol: string;
  value: number;
  state: string;
  venueTimestamp: IsoTimestamp | null;
  provenance: DataProvenance;
}

export interface IndexHistoricalsOptions {
  start: IsoTimestamp;
  end?: IsoTimestamp;
  interval: BarInterval;
}

export interface IndexBar {
  instrumentId: string;
  symbol: string;
  interval: string;
  time: IsoTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  interpolated: boolean;
  provenance: DataProvenance;
}

export interface OptionInstrumentsFilter {
  chainId?: string;
  chainSymbol?: string;
  expirationDates?: string;
  strikePrice?: string;
  type?: "call" | "put";
  state?: string;
  tradability?: string;
  ids?: string;
}

/** Resolves current marks for positions. Provided by the shared market-data layer. */
export type QuoteLookup = (symbols: readonly string[]) => Promise<readonly Quote[]>;

export interface BrokerAdapter {
  readonly binding: AdapterBinding;

  status(): Promise<AdapterStatus>;

  // ---- account ----
  getAccounts(): Promise<BrokerAccountListing[]>;
  getPortfolio(): Promise<PortfolioSnapshot>;
  getPositions(): Promise<Position[]>;
  getOrders(opts?: GetOrdersOptions): Promise<BrokerOrder[]>;
  getOrder(brokerOrderId: string): Promise<BrokerOrder | null>;
  reviewOrder(req: OrderRequest): Promise<OrderReview>;
  /** Refuses when `review.ok` is false or `review.reviewedAt` is older than the review window (60 s). */
  placeOrder(req: OrderRequest, review: OrderReview): Promise<{ order: BrokerOrder }>;
  cancelOrder(brokerOrderId: string): Promise<{ accepted: boolean }>;
  getTaxLots(symbol: string): Promise<TaxLot[]>;
  getRealizedPnl(span: RealizedPnlSpan): Promise<RealizedPnl>;

  // ---- market data (shareable across users; carries no tenant data) ----
  getQuotes(symbols: readonly string[]): Promise<Quote[]>;
  getBars(symbols: readonly string[], opts: BarsOptions): Promise<Bar[]>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  getTradability(symbols: readonly string[]): Promise<Tradability[]>;
  search(query: string): Promise<SearchResults>;
  getFundamentals(symbol: string): Promise<RawRecord>;
  getFinancials(symbol: string): Promise<RawRecord>;
  getAnalystRatings(symbol: string): Promise<AnalystRatings | null>;
  getNews(symbol: string): Promise<NewsArticle[]>;
  getEarnings(symbol: string): Promise<EarningsRecord[]>;
  getEarningsCalendar(range: EarningsCalendarRange): Promise<EarningsRecord[]>;
  getIndexes(symbols?: readonly string[]): Promise<IndexRef[]>;
  getIndexQuotes(instrumentIds: readonly string[]): Promise<IndexQuote[]>;
  getIndexHistoricals(instrumentIds: readonly string[], opts: IndexHistoricalsOptions): Promise<IndexBar[]>;
  getOptionChains(underlyingSymbol: string): Promise<RawRecord[]>;
  getOptionInstruments(filter: OptionInstrumentsFilter): Promise<RawRecord[]>;
  getOptionQuotes(instrumentIds: readonly string[]): Promise<RawRecord[]>;

  /** Tool names advertised by the broker (tools/list). Simulated adapters report their own capability list. */
  listTools(): Promise<string[]>;
}

/** Re-exported for convenience so callers can type fill derivation without importing core separately. */
export type { Fill };
