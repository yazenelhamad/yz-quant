/**
 * `SimulatedBrokerAdapter` — SHADOW MODE ONLY.
 *
 * An in-memory account (cash, positions, orders, tax lots) with fill simulation driven by a
 * `QuoteSource` (normally the live shared market-data layer). It never talks to a broker.
 * Every object it fabricates carries `simulated: true` and provenance source "simulated".
 * Market data passed through from the quote source keeps its own (real) provenance: shadow
 * mode consumes real prices, it just does not send real orders.
 *
 * Deterministic: inject `clock` and `rng`. Fills happen in `tick()`, which every read runs first.
 */
import type { Bar, BrokerOrder, DataProvenance, Fill, OrderBook, OrderRequest, OrderReview, PortfolioSnapshot, Position, Quote, TaxLot, TenantScope, Tradability } from "@yz/core";
import { CrossTenantError, TERMINAL_ORDER_STATES, assertScope, assertSameScope } from "@yz/core";
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
  RawRecord,
  RealizedPnl,
  RealizedPnlSpan,
  SearchResults,
} from "../adapter.js";
import { BrokerError, maskAccountNumber } from "../errors.js";
import { REVIEW_MAX_AGE_MS, assertOrderRequestValid, assertReviewUsable } from "../orderRules.js";
import { simulatedProvenance } from "../provenance.js";
import { deriveFills } from "../robinhood/mapping.js";

export interface QuoteSource {
  getQuotes(symbols: readonly string[]): Promise<readonly Quote[]>;
}

export type Simulated<T> = T & { simulated: true };

export type MarketDataMethods = Pick<
  BrokerAdapter,
  | "getBars"
  | "getOrderBook"
  | "getTradability"
  | "search"
  | "getFundamentals"
  | "getFinancials"
  | "getAnalystRatings"
  | "getNews"
  | "getEarnings"
  | "getEarningsCalendar"
  | "getIndexes"
  | "getIndexQuotes"
  | "getIndexHistoricals"
  | "getOptionChains"
  | "getOptionInstruments"
  | "getOptionQuotes"
>;

export interface SimulatedAdapterOptions {
  scope: TenantScope;
  accountNumber: string;
  quoteSource: QuoteSource;
  /** Milliseconds since epoch. */
  clock?: () => number;
  /** Uniform [0,1). Defaults to a seeded PRNG for reproducibility. */
  rng?: () => number;
  seed?: number;
  initialCash?: number;
  initialPositions?: { symbol: string; quantity: number; averageCost: number }[];
  /** Market orders fill at ask/bid moved against us by this many basis points. */
  slippageBps?: number;
  /** When set, a fill may be partial with `probability`, filling at least `minFraction` of the remainder. */
  partialFills?: { probability: number; minFraction: number } | null;
  /** Orders are not eligible to fill until this long after submission. */
  latencyMs?: number;
  feePerFill?: number;
  /** Optional passthrough for market-data methods (e.g. the live adapter's market data). */
  marketData?: Partial<MarketDataMethods> | null;
  reviewMaxAgeMs?: number;
}

interface Lot {
  lotId: string;
  quantity: number;
  costPerShare: number;
  openDate: string;
}

interface SimPosition {
  quantity: number;
  averageCost: number;
  intraday: number;
  lots: Lot[];
}

interface SimOrder {
  order: BrokerOrder;
  /** Remaining shares (share orders) or remaining dollars (dollar-based orders). */
  remaining: number;
  dollarBased: boolean;
  submittedAt: number;
  triggered: boolean;
  reservedCash: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export class SimulatedBrokerAdapter implements BrokerAdapter {
  readonly binding: AdapterBinding;
  private readonly quoteSource: QuoteSource;
  private readonly clock: () => number;
  private readonly rng: () => number;
  private readonly slippage: number;
  private readonly partialFills: { probability: number; minFraction: number } | null;
  private readonly latencyMs: number;
  private readonly feePerFill: number;
  private readonly marketData: Partial<MarketDataMethods> | null;
  private readonly reviewMaxAgeMs: number;

  private cash: number;
  private readonly positions = new Map<string, SimPosition>();
  private readonly orders = new Map<string, SimOrder>();
  private readonly fillLog: Fill[] = [];
  private readonly realized: { at: string; symbol: string; gain: number }[] = [];
  private seq = 0;
  private readonly createdAt: string;

  constructor(opts: SimulatedAdapterOptions) {
    assertScope(opts.scope, "SimulatedBrokerAdapter");
    if (!opts.accountNumber) throw new BrokerError("invalid_request", "simulated adapter requires a bound account number");
    this.binding = Object.freeze({ scope: Object.freeze({ userId: opts.scope.userId, brokerAccountId: opts.scope.brokerAccountId }), accountNumber: opts.accountNumber, kind: "simulated" as const });
    this.quoteSource = opts.quoteSource;
    this.clock = opts.clock ?? Date.now;
    this.rng = opts.rng ?? mulberry32(opts.seed ?? 1);
    this.slippage = (opts.slippageBps ?? 5) / 10_000;
    this.partialFills = opts.partialFills ?? null;
    this.latencyMs = opts.latencyMs ?? 0;
    this.feePerFill = opts.feePerFill ?? 0;
    this.marketData = opts.marketData ?? null;
    this.reviewMaxAgeMs = opts.reviewMaxAgeMs ?? REVIEW_MAX_AGE_MS;
    this.cash = opts.initialCash ?? 100_000;
    this.createdAt = this.nowIso();
    for (const p of opts.initialPositions ?? []) {
      this.positions.set(p.symbol, { quantity: p.quantity, averageCost: p.averageCost, intraday: 0, lots: [{ lotId: this.nextId("lot"), quantity: p.quantity, costPerShare: p.averageCost, openDate: this.createdAt.slice(0, 10) }] });
    }
  }

  // ---- helpers ----------------------------------------------------------------

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `sim-${prefix}-${String(this.seq).padStart(6, "0")}`;
  }

  private prov(): DataProvenance {
    return simulatedProvenance(this.nowIso());
  }

  private guard(req: { scope: TenantScope; accountNumber: string }, context: string): void {
    assertSameScope(this.binding.scope, req.scope, context);
    if (req.accountNumber !== this.binding.accountNumber) {
      throw new CrossTenantError(`${context}: request targets account ${maskAccountNumber(req.accountNumber)} but this adapter is bound to ${maskAccountNumber(this.binding.accountNumber)}`, this.binding.scope, req.scope);
    }
  }

  private heldForSells(symbol: string): number {
    let held = 0;
    for (const o of this.orders.values()) {
      if (o.order.symbol === symbol && o.order.side === "sell" && !TERMINAL_ORDER_STATES.has(o.order.state) && !o.dollarBased) held += o.remaining;
    }
    return held;
  }

  private reservedCash(): number {
    let r = 0;
    for (const o of this.orders.values()) if (!TERMINAL_ORDER_STATES.has(o.order.state)) r += o.reservedCash;
    return r;
  }

  private buyingPower(): number {
    return round2(this.cash - this.reservedCash());
  }

  private async quotesFor(symbols: readonly string[]): Promise<Map<string, Quote>> {
    if (symbols.length === 0) return new Map();
    const qs = await this.quoteSource.getQuotes([...new Set(symbols)]);
    return new Map(qs.map((q) => [q.symbol, q]));
  }

  // ---- fill engine -------------------------------------------------------------

  /** Advances the simulation: evaluates open orders against current quotes. Returns the fills produced. */
  async tick(): Promise<Fill[]> {
    const now = this.clock();
    const open = [...this.orders.values()].filter((o) => !TERMINAL_ORDER_STATES.has(o.order.state) && o.order.state !== "pending_cancelled" && now >= o.submittedAt + this.latencyMs).sort((a, b) => a.submittedAt - b.submittedAt);
    if (open.length === 0) return [];
    const quotes = await this.quotesFor(open.map((o) => o.order.symbol));
    const produced: Fill[] = [];
    for (const sim of open) {
      const q = quotes.get(sim.order.symbol);
      if (!q) continue;
      const price = this.fillPrice(sim, q);
      if (price === null) continue;
      const fill = this.applyFill(sim, price, now);
      if (fill) produced.push(fill);
    }
    return produced;
  }

  private fillPrice(sim: SimOrder, q: Quote): number | null {
    const o = sim.order;
    const isStop = o.type === "stop_market" || o.type === "stop_limit";
    if (isStop && !sim.triggered) {
      const stop = o.stopPrice ?? 0;
      const trig = o.side === "buy" ? q.last >= stop : q.last <= stop;
      if (!trig) return null;
      sim.triggered = true;
    }
    const ask = q.ask ?? q.last;
    const bid = q.bid ?? q.last;
    const marketLike = o.type === "market" || o.type === "stop_market";
    if (marketLike) return o.side === "buy" ? ask * (1 + this.slippage) : bid * (1 - this.slippage);
    const limit = o.limitPrice ?? 0;
    if (o.side === "buy") return ask <= limit ? Math.min(ask, limit) : null;
    return bid >= limit ? Math.max(bid, limit) : null;
  }

  private applyFill(sim: SimOrder, price: number, now: number): Fill | null {
    const o = sim.order;
    let qty = sim.dollarBased ? round6(sim.remaining / price) : sim.remaining;
    if (this.partialFills && this.rng() < this.partialFills.probability) {
      const fraction = this.partialFills.minFraction + this.rng() * (1 - this.partialFills.minFraction);
      qty = Math.max(0.000001, round6(qty * fraction));
    }
    if (o.side === "sell") {
      const pos = this.positions.get(o.symbol);
      const available = pos ? pos.quantity - (this.heldForSells(o.symbol) - (sim.dollarBased ? 0 : sim.remaining)) : 0;
      qty = Math.min(qty, round6(available));
      if (qty <= 0) {
        this.finish(sim, "rejected", now, "no sellable shares");
        return null;
      }
    } else {
      const cost = qty * price + this.feePerFill;
      if (cost > this.cash + 1e-9) {
        this.finish(sim, "rejected", now, "insufficient buying power at fill time");
        return null;
      }
    }
    const notional = round2(qty * price);
    const prev: BrokerOrder = { ...o };
    // account
    if (o.side === "buy") {
      this.cash = round2(this.cash - notional - this.feePerFill);
      const pos = this.positions.get(o.symbol) ?? { quantity: 0, averageCost: 0, intraday: 0, lots: [] };
      const newQty = round6(pos.quantity + qty);
      pos.averageCost = newQty > 0 ? (pos.averageCost * pos.quantity + price * qty) / newQty : 0;
      pos.quantity = newQty;
      pos.intraday = round6(pos.intraday + qty);
      pos.lots.push({ lotId: this.nextId("lot"), quantity: qty, costPerShare: price, openDate: new Date(now).toISOString().slice(0, 10) });
      this.positions.set(o.symbol, pos);
    } else {
      this.cash = round2(this.cash + notional - this.feePerFill);
      const pos = this.positions.get(o.symbol);
      if (pos) {
        let left = qty;
        let gain = 0;
        while (left > 1e-9 && pos.lots.length > 0) {
          const lot = pos.lots[0] as Lot;
          const take = Math.min(lot.quantity, left);
          gain += (price - lot.costPerShare) * take;
          lot.quantity = round6(lot.quantity - take);
          left = round6(left - take);
          if (lot.quantity <= 1e-9) pos.lots.shift();
        }
        pos.quantity = round6(pos.quantity - qty);
        pos.intraday = round6(pos.intraday - qty);
        if (pos.quantity <= 1e-9) this.positions.delete(o.symbol);
        this.realized.push({ at: new Date(now).toISOString(), symbol: o.symbol, gain: round2(gain - this.feePerFill) });
      }
    }
    // order
    const prevCum = o.cumulativeQuantity;
    const newCum = round6(prevCum + qty);
    o.averagePrice = round6(((o.averagePrice ?? 0) * prevCum + price * qty) / newCum);
    o.cumulativeQuantity = newCum;
    o.fees = round2(o.fees + this.feePerFill);
    o.updatedAt = new Date(now).toISOString();
    sim.remaining = sim.dollarBased ? round2(sim.remaining - notional) : round6(sim.remaining - qty);
    if (sim.dollarBased && o.quantity === null) o.quantity = newCum;
    const done = sim.remaining <= (sim.dollarBased ? 0.01 : 1e-9);
    o.state = done ? "filled" : "partially_filled";
    if (done) sim.reservedCash = 0;
    else if (o.side === "buy") sim.reservedCash = round2(Math.max(0, sim.reservedCash - notional));
    o.raw = { ...(o.raw as Record<string, unknown>), simulated: true, fill_price: price };
    const [fill] = deriveFills(prev, o);
    if (fill) this.fillLog.push(fill);
    return fill ?? null;
  }

  private finish(sim: SimOrder, state: BrokerOrder["state"], now: number, reason?: string): void {
    sim.order.state = state;
    sim.order.updatedAt = new Date(now).toISOString();
    sim.reservedCash = 0;
    sim.order.raw = { ...(sim.order.raw as Record<string, unknown>), simulated: true, ...(reason ? { reject_reason: reason } : {}) };
  }

  /** All fills produced so far (derived, `derived: true`). */
  getFills(): Simulated<Fill>[] {
    return this.fillLog.map((f) => ({ ...f, simulated: true as const }));
  }

  // ---- BrokerAdapter ---------------------------------------------------------

  async status(): Promise<AdapterStatus> {
    return { status: "connected", detail: "SIMULATED shadow-mode adapter; no broker connection, no real orders", lastHealthyAt: this.nowIso(), consecutiveFailures: 0 };
  }

  async listTools(): Promise<string[]> {
    return ["simulated:get_portfolio", "simulated:get_positions", "simulated:get_orders", "simulated:review_order", "simulated:place_order", "simulated:cancel_order", "simulated:get_tax_lots", "simulated:get_realized_pnl", "simulated:get_quotes"];
  }

  async getAccounts(): Promise<Simulated<BrokerAccountListing>[]> {
    return [
      {
        simulated: true,
        kind: "simulated",
        accountNumber: this.binding.accountNumber,
        rhsAccountNumber: null,
        cryptoAccountNumber: null,
        accountType: "limited_margin",
        brokerageAccountType: "simulated",
        nickname: "SIMULATED",
        isDefault: true,
        agenticAllowed: true,
        optionLevel: "",
        optionsEnabled: false,
        state: "active",
        deactivated: false,
        permanentlyDeactivated: false,
        provenance: this.prov(),
        raw: { simulated: true },
      },
    ];
  }

  async getPortfolio(): Promise<Simulated<PortfolioSnapshot>> {
    await this.tick();
    const symbols = [...this.positions.keys()];
    const quotes = await this.quotesFor(symbols);
    let equity = 0;
    for (const [symbol, pos] of this.positions) {
      const q = quotes.get(symbol);
      equity += (q ? q.last : pos.averageCost) * pos.quantity;
    }
    const bp = this.buyingPower();
    return {
      simulated: true,
      scope: this.binding.scope,
      asOf: this.nowIso(),
      totalValue: round2(this.cash + equity),
      equityValue: round2(equity),
      optionsValue: 0,
      cryptoValue: 0,
      cash: round2(this.cash),
      pendingDeposits: 0,
      buyingPower: bp,
      unleveragedBuyingPower: bp,
      currency: "USD",
      provenance: this.prov(),
    };
  }

  async getPositions(): Promise<Simulated<Position>[]> {
    await this.tick();
    const quotes = await this.quotesFor([...this.positions.keys()]);
    const asOf = this.nowIso();
    return [...this.positions.entries()].map(([symbol, pos]) => {
      const q = quotes.get(symbol) ?? null;
      const mark = q ? q.last : null;
      return {
        simulated: true,
        scope: this.binding.scope,
        symbol,
        assetClass: "equity",
        quantity: pos.quantity,
        intradayQuantity: pos.intraday,
        sharesAvailableForSells: round6(Math.max(0, pos.quantity - this.heldForSells(symbol))),
        averageCost: round6(pos.averageCost),
        markPrice: mark,
        marketValue: mark === null ? null : round2(mark * pos.quantity),
        unrealizedPnl: mark === null ? null : round2((mark - pos.averageCost) * pos.quantity),
        asOf,
        provenance: this.prov(),
      };
    });
  }

  private snapshot(o: BrokerOrder): Simulated<BrokerOrder> {
    return { ...o, raw: { ...(o.raw as Record<string, unknown>), simulated: true }, simulated: true };
  }

  async getOrders(opts: GetOrdersOptions = {}): Promise<Simulated<BrokerOrder>[]> {
    await this.tick();
    const since = opts.since ? Date.parse(opts.since) : null;
    return [...this.orders.values()]
      .map((s) => s.order)
      .filter((o) => (!opts.orderId || o.brokerOrderId === opts.orderId) && (!opts.state || o.state === opts.state) && (!opts.symbol || o.symbol === opts.symbol) && (since === null || Date.parse(o.createdAt) >= since))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((o) => this.snapshot(o));
  }

  async getOrder(brokerOrderId: string): Promise<Simulated<BrokerOrder> | null> {
    await this.tick();
    const s = this.orders.get(brokerOrderId);
    return s ? this.snapshot(s.order) : null;
  }

  private sharesAvailable(symbol: string): number | null {
    const pos = this.positions.get(symbol);
    return pos ? round6(Math.max(0, pos.quantity - this.heldForSells(symbol))) : null;
  }

  private estimateCost(req: OrderRequest, q: Quote | null): number | null {
    if (req.dollarAmount !== null) return req.dollarAmount;
    if (req.quantity === null) return null;
    const px = req.limitPrice ?? (req.side === "buy" ? (q?.ask ?? q?.last ?? null) : (q?.bid ?? q?.last ?? null));
    return px === null ? null : round2(px * req.quantity);
  }

  async reviewOrder(req: OrderRequest): Promise<Simulated<OrderReview>> {
    this.guard(req, "reviewOrder");
    await this.tick();
    assertOrderRequestValid(req, { sharesAvailable: req.side === "sell" ? this.sharesAvailable(req.symbol) : undefined });
    const q = (await this.quotesFor([req.symbol])).get(req.symbol) ?? null;
    const alerts: OrderReview["alerts"] = [];
    if (!q) alerts.push({ code: "NO_QUOTE", severity: "blocking", message: `no quote available for ${req.symbol}` });
    const cost = this.estimateCost(req, q);
    if (req.side === "buy" && cost !== null && cost > this.buyingPower()) alerts.push({ code: "INSUFFICIENT_BUYING_POWER", severity: "blocking", message: `estimated cost ${cost} exceeds simulated buying power ${this.buyingPower()}` });
    if (req.marketHours !== "regular_hours") alerts.push({ code: "EXTENDED_HOURS", severity: "info", message: "simulated extended-hours fill uses the latest quote" });
    return {
      simulated: true,
      ok: !alerts.some((a) => a.severity === "blocking"),
      estimatedCost: cost,
      quote: q ? { last: q.last, bid: q.bid, ask: q.ask } : null,
      alerts,
      raw: {
        simulated: true,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        quantity: req.quantity === null ? null : String(req.quantity),
        dollar_amount: req.dollarAmount === null ? null : String(req.dollarAmount),
        limit_price: req.limitPrice === null ? null : String(req.limitPrice),
        stop_price: req.stopPrice === null ? null : String(req.stopPrice),
        quote: q,
      },
      reviewedAt: this.nowIso(),
    };
  }

  async placeOrder(req: OrderRequest, review: OrderReview): Promise<{ order: Simulated<BrokerOrder> }> {
    this.guard(req, "placeOrder");
    assertReviewUsable(review, req, this.clock(), this.reviewMaxAgeMs);
    assertOrderRequestValid(req, { sharesAvailable: req.side === "sell" ? this.sharesAvailable(req.symbol) : undefined });
    for (const s of this.orders.values()) {
      if (s.order.refId === req.refId) return { order: this.snapshot(s.order) }; // idempotent on ref_id
    }
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    const q = (await this.quotesFor([req.symbol])).get(req.symbol) ?? null;
    const cost = req.side === "buy" ? this.estimateCost(req, q) : null;
    const order: BrokerOrder = {
      scope: this.binding.scope,
      brokerOrderId: this.nextId("order"),
      refId: req.refId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      state: "confirmed",
      quantity: req.quantity,
      cumulativeQuantity: 0,
      limitPrice: req.limitPrice,
      stopPrice: req.stopPrice,
      averagePrice: null,
      fees: 0,
      timeInForce: req.timeInForce,
      marketHours: req.marketHours,
      placedAgent: "simulated",
      createdAt: nowIso,
      updatedAt: nowIso,
      raw: { simulated: true, dollar_based_amount: req.dollarAmount, trade_id: req.tradeId, strategy_id: req.strategyId },
    };
    const sim: SimOrder = { order, remaining: req.dollarAmount ?? (req.quantity as number), dollarBased: req.dollarAmount !== null, submittedAt: now, triggered: false, reservedCash: 0 };
    if (req.side === "buy") {
      if (cost === null || cost > this.buyingPower()) {
        this.finish(sim, "rejected", now, cost === null ? "no quote to price the order" : "insufficient buying power");
      } else {
        sim.reservedCash = cost;
      }
    }
    this.orders.set(order.brokerOrderId, sim);
    return { order: this.snapshot(order) };
  }

  async cancelOrder(brokerOrderId: string): Promise<{ accepted: boolean }> {
    const sim = this.orders.get(brokerOrderId);
    if (!sim || TERMINAL_ORDER_STATES.has(sim.order.state)) return { accepted: false };
    this.finish(sim, sim.order.cumulativeQuantity > 0 ? "partially_filled_rest_cancelled" : "cancelled", this.clock());
    return { accepted: true };
  }

  async getTaxLots(symbol: string): Promise<Simulated<TaxLot>[]> {
    const pos = this.positions.get(symbol);
    if (!pos) return [];
    const held = this.heldForSells(symbol);
    let remainingHold = held;
    return pos.lots.map((lot) => {
      const earmarked = Math.min(lot.quantity, remainingHold);
      remainingHold = round6(remainingHold - earmarked);
      const ageDays = (this.clock() - Date.parse(lot.openDate)) / 86_400_000;
      return { simulated: true, scope: this.binding.scope, symbol, lotId: lot.lotId, quantity: lot.quantity, quantityAvailable: round6(lot.quantity - earmarked), costPerShare: lot.costPerShare, openDate: lot.openDate, term: ageDays > 365 ? "lt" : "st" };
    });
  }

  async getRealizedPnl(span: RealizedPnlSpan): Promise<Simulated<RealizedPnl>> {
    const days: Record<string, number> = { day: 1, week: 7, month: 30, "3month": 90, year: 365 };
    const cutoff = span in days ? this.clock() - (days[span] as number) * 86_400_000 : -Infinity;
    const rows = this.realized.filter((r) => Date.parse(r.at) >= cutoff);
    const total = round2(rows.reduce((s, r) => s + r.gain, 0));
    return {
      simulated: true,
      scope: this.binding.scope,
      window: span,
      currency: "USD",
      dataPoints: [{ startTime: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : this.createdAt, endTime: this.nowIso(), realizedGain: total, rateOfRealizedGain: null, numberOfTrades: rows.length }],
      totalReturns: total,
      totalRateOfReturn: null,
      provenance: this.prov(),
      raw: { simulated: true, trades: rows },
    };
  }

  // ---- market data (passthrough) --------------------------------------------

  async getQuotes(symbols: readonly string[]): Promise<Quote[]> {
    return [...(await this.quoteSource.getQuotes(symbols))];
  }

  private md<K extends keyof MarketDataMethods>(name: K): MarketDataMethods[K] {
    const fn = this.marketData?.[name];
    if (!fn) throw new BrokerError("unsupported", `simulated adapter has no market-data source for ${name}; pass marketData (e.g. the live adapter) to enable it`);
    return fn as MarketDataMethods[K];
  }

  async getBars(symbols: readonly string[], opts: BarsOptions): Promise<Bar[]> {
    return this.md("getBars")(symbols, opts);
  }
  async getOrderBook(symbol: string): Promise<OrderBook> {
    return this.md("getOrderBook")(symbol);
  }
  async getTradability(symbols: readonly string[]): Promise<Tradability[]> {
    return this.md("getTradability")(symbols);
  }
  async search(query: string): Promise<SearchResults> {
    return this.md("search")(query);
  }
  async getFundamentals(symbol: string): Promise<RawRecord> {
    return this.md("getFundamentals")(symbol);
  }
  async getFinancials(symbol: string): Promise<RawRecord> {
    return this.md("getFinancials")(symbol);
  }
  async getAnalystRatings(symbol: string): Promise<AnalystRatings | null> {
    return this.md("getAnalystRatings")(symbol);
  }
  async getNews(symbol: string): Promise<NewsArticle[]> {
    return this.md("getNews")(symbol);
  }
  async getEarnings(symbol: string): Promise<EarningsRecord[]> {
    return this.md("getEarnings")(symbol);
  }
  async getEarningsCalendar(range: EarningsCalendarRange): Promise<EarningsRecord[]> {
    return this.md("getEarningsCalendar")(range);
  }
  async getIndexes(symbols?: readonly string[]): Promise<IndexRef[]> {
    return this.md("getIndexes")(symbols);
  }
  async getIndexQuotes(instrumentIds: readonly string[]): Promise<IndexQuote[]> {
    return this.md("getIndexQuotes")(instrumentIds);
  }
  async getIndexHistoricals(instrumentIds: readonly string[], opts: IndexHistoricalsOptions): Promise<IndexBar[]> {
    return this.md("getIndexHistoricals")(instrumentIds, opts);
  }
  async getOptionChains(underlyingSymbol: string): Promise<RawRecord[]> {
    return this.md("getOptionChains")(underlyingSymbol);
  }
  async getOptionInstruments(filter: OptionInstrumentsFilter): Promise<RawRecord[]> {
    return this.md("getOptionInstruments")(filter);
  }
  async getOptionQuotes(instrumentIds: readonly string[]): Promise<RawRecord[]> {
    return this.md("getOptionQuotes")(instrumentIds);
  }
}
