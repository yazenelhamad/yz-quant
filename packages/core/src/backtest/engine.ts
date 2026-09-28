/**
 * Event-driven backtest engine.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. The engine walks the trading
 * calendar bar by bar; at each bar it (1) force-closes delisted names, (2) fills orders that
 * were queued on earlier bars, (3) manages open positions (stops, targets, holding limits,
 * MAE/MFE), (4) asks the strategy for a view using only bars at or before the decision time
 * and (5) marks the book to market. Orders created at a decision bar can never fill before
 * the next bar's open, regardless of `executionDelayBars`.
 */
import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  Bar,
  CostModel,
  EquityPoint,
  Freshness,
  IsoTimestamp,
  Quote,
  RegimeAssessment,
} from "../types/index.js";
import type { Strategy, StrategyContext, StrategyOutput } from "../strategies/contract.js";
import {
  type BacktestDataset,
  assertNoLookahead,
  compareTime,
  fingerprint,
  indexByTime,
  isDelistedAt,
  sliceUpTo,
  tradingDays,
  universeAt,
  validateDataset,
} from "./data.js";
import { computeMetrics } from "./metrics.js";
import { fnv1a64 } from "./random.js";

// ---------------------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------------------

export interface FeatureResult {
  values: Record<string, number | null>;
  freshness: Freshness;
  featureVersion: string;
  warnings: string[];
}

/**
 * Feature and regime engines are injected so the backtester never depends on their
 * implementation. Both must be pure functions of the bars they are given.
 */
export interface BacktestDependencies {
  computeFeatures(bars: Bar[], intradayBars?: Bar[], quote?: Quote | null, benchmarkBars?: Bar[]): FeatureResult;
  assessRegime(benchmarkBars: Bar[], asOf: IsoTimestamp, vixBars?: Bar[]): RegimeAssessment;
}

export interface SizerInput {
  symbol: string;
  equity: number;
  cash: number;
  price: number;
  confidence: number;
  strength: number;
  view: NonNullable<StrategyOutput["view"]>;
  parameters: BacktestConfig["parameters"];
  openPositions: number;
  maxPositionFraction: number;
  allowFractional: boolean;
}

/** Returns the quantity (shares) to buy; 0 or negative means no order. */
export type Sizer = (input: SizerInput) => number;

export interface BacktestOptions {
  sizer?: Sizer;
  /** Cap on a single position as a fraction of equity (default 0.10). */
  maxPositionFraction?: number;
  /** Force an exit after this many bars in a position (null = no limit). */
  maxHoldingBars?: number | null;
  /** Entry order type. Limit entries rest at close * (1 - limitOffsetBps/1e4). */
  entryOrderType?: "market" | "limit";
  limitOffsetBps?: number;
  /** Fraction of the position sold on a "reduce" view (default 0.5). */
  reduceFraction?: number;
  /** Haircut applied to the last available price when force-closing a delisted name (default 5%). */
  delistingHaircutPct?: number;
  /** Extra bars an unfilled or partially filled order is carried before being cancelled (default 0). */
  carryUnfilledBars?: number;
  maxOpenPositions?: number;
  allowFractional?: boolean;
  /** Recorded as `ranAt` on the result (the engine has no clock). Defaults to config.end. */
  ranAt?: IsoTimestamp;
  kind?: BacktestResult["kind"];
  id?: string;
}

/** Engine result: the shared `BacktestResult` plus the per-bar regime labels used for attribution. */
export interface BacktestRunResult extends BacktestResult {
  barRegimes: { time: IsoTimestamp; regime: string }[];
  /** Positions still open at the end of the window (also included in `trades` with exitTime null). */
  openPositions: number;
}

// ---------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------

interface PendingOrder {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  type: "market" | "limit";
  limitPrice: number | null;
  createdIndex: number;
  /** Earliest bar index at which the order may fill. */
  fillIndex: number;
  /** Last bar index at which the order may fill. */
  expiresIndex: number;
  reason: string;
  view: NonNullable<StrategyOutput["view"]> | null;
  regime: string;
}

interface OpenPosition {
  symbol: string;
  quantity: number;
  /** Average pre-cost reference price (fill bar open or limit). */
  avgRef: number;
  /** Average actual fill price (after spread and impact). */
  avgFill: number;
  /** Entry costs (explicit + implicit) attributable to the whole position. */
  entryCosts: number;
  openedAt: IsoTimestamp;
  openedIndex: number;
  stop: number | null;
  target: number | null;
  confidence: number;
  regime: string;
  minLow: number;
  maxHigh: number;
  barsHeld: number;
  lastClose: number;
}

interface Fill {
  quantity: number;
  refPrice: number;
  fillPrice: number;
  commission: number;
  /** Implicit + explicit costs of the fill. */
  costs: number;
}

export const PERIODS_PER_YEAR: Record<BacktestConfig["interval"], number> = {
  day: 252,
  hour: 252 * 7,
  "30minute": 252 * 13,
  "5minute": 252 * 78,
};

// ---------------------------------------------------------------------------------------
// Default sizing
// ---------------------------------------------------------------------------------------

/** Fixed fraction of equity scaled by confidence, capped at `maxPositionFraction` and by cash. */
export const defaultSizer: Sizer = (input) => {
  const confidence = Math.min(1, Math.max(0, input.confidence));
  const fraction = input.maxPositionFraction * confidence;
  const notional = Math.min(input.equity * fraction, input.cash);
  if (notional <= 0 || input.price <= 0) return 0;
  const raw = notional / input.price;
  return input.allowFractional ? raw : Math.floor(raw);
};

// ---------------------------------------------------------------------------------------
// Fill model
// ---------------------------------------------------------------------------------------

function commissionFor(cost: CostModel, quantity: number): number {
  if (quantity <= 0) return 0;
  return Math.max(cost.commissionMin, cost.commissionPerShare * quantity);
}

/** Impact in bps: k * sqrt(participation). */
export function impactBps(cost: CostModel, quantity: number, barVolume: number): number {
  if (barVolume <= 0 || quantity <= 0) return 0;
  return cost.impactCoefficient * Math.sqrt(quantity / barVolume);
}

/**
 * Simulates a fill against a bar. Market orders trade at the open plus half-spread and
 * impact (adverse to the taker). Limit orders fill only when the bar's range crosses the
 * limit and are treated as passive (commission only). Quantity is capped by
 * `maxParticipation * volume`; the remainder is left unfilled.
 */
export function simulateFill(order: Pick<PendingOrder, "side" | "quantity" | "type" | "limitPrice">, bar: Bar, cost: CostModel): Fill | null {
  const maxQty = bar.volume > 0 ? bar.volume * cost.maxParticipation : order.quantity;
  const quantity = Math.min(order.quantity, maxQty);
  if (quantity <= 0) return null;
  const sign = order.side === "buy" ? 1 : -1;
  if (order.type === "limit" && order.limitPrice !== null) {
    const crosses = order.side === "buy" ? bar.low <= order.limitPrice : bar.high >= order.limitPrice;
    if (!crosses) return null;
    // Gap through the limit: the order fills at the (better) open.
    const refPrice = order.side === "buy" ? Math.min(bar.open, order.limitPrice) : Math.max(bar.open, order.limitPrice);
    const commission = commissionFor(cost, quantity);
    return { quantity, refPrice, fillPrice: refPrice, commission, costs: commission };
  }
  const refPrice = bar.open;
  const slippageBps = cost.defaultHalfSpreadBps + impactBps(cost, quantity, bar.volume);
  const fillPrice = refPrice * (1 + (sign * slippageBps) / 10_000);
  const commission = commissionFor(cost, quantity);
  const implicit = Math.abs(fillPrice - refPrice) * quantity;
  return { quantity, refPrice, fillPrice, commission, costs: implicit + commission };
}

/** Fill at a specific trigger price (stop hit, target hit or forced close). */
function fillAtPrice(side: "buy" | "sell", quantity: number, refPrice: number, bar: Bar | null, cost: CostModel, aggressive: boolean): Fill {
  const sign = side === "buy" ? 1 : -1;
  const slippageBps = aggressive ? cost.defaultHalfSpreadBps + impactBps(cost, quantity, bar?.volume ?? 0) : 0;
  const fillPrice = refPrice * (1 + (sign * slippageBps) / 10_000);
  const commission = commissionFor(cost, quantity);
  return { quantity, refPrice, fillPrice, commission, costs: Math.abs(fillPrice - refPrice) * quantity + commission };
}

// ---------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------

export function runBacktest(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategy: Strategy,
  deps: BacktestDependencies,
  opts: BacktestOptions = {},
): BacktestRunResult {
  const warnings: string[] = validateDataset(dataset);
  const warn = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  const cost = config.costModel;
  const sizer = opts.sizer ?? defaultSizer;
  const maxPositionFraction = opts.maxPositionFraction ?? 0.1;
  const maxHoldingBars = opts.maxHoldingBars ?? null;
  const entryOrderType = opts.entryOrderType ?? "market";
  const limitOffsetBps = opts.limitOffsetBps ?? 0;
  const reduceFraction = opts.reduceFraction ?? 0.5;
  const haircut = (opts.delistingHaircutPct ?? 5) / 100;
  const carryUnfilledBars = opts.carryUnfilledBars ?? 0;
  const maxOpenPositions = opts.maxOpenPositions ?? Number.POSITIVE_INFINITY;
  const allowFractional = opts.allowFractional ?? false;
  const delay = Math.max(1, Math.floor(cost.executionDelayBars));
  const includeDelisted = config.includeDelisted;

  const requested = config.symbols.length > 0 ? config.symbols : dataset.symbols;
  const symbols = requested.filter((s) => dataset.symbols.includes(s));
  for (const s of requested) if (!symbols.includes(s)) warn(`symbol ${s} not in dataset`);
  const scopedDataset: BacktestDataset = { ...dataset, symbols };

  const days = tradingDays(dataset, config.start, config.end);
  const barIndex = new Map<string, Map<IsoTimestamp, number>>();
  for (const s of symbols) barIndex.set(s, indexByTime(dataset.bars[s] ?? []));
  const barAt = (symbol: string, t: IsoTimestamp): Bar | null => {
    const idx = barIndex.get(symbol)?.get(t);
    if (idx === undefined) return null;
    const bar = (dataset.bars[symbol] as Bar[])[idx] as Bar;
    return bar.interpolated ? null : bar;
  };
  const lastBarAtOrBefore = (symbol: string, t: IsoTimestamp): Bar | null => {
    const bars = sliceUpTo(dataset.bars[symbol] ?? [], t);
    return bars.length > 0 ? (bars[bars.length - 1] as Bar) : null;
  };

  const regimeCache = new Map<IsoTimestamp, RegimeAssessment>();
  const regimeAt = (t: IsoTimestamp): RegimeAssessment => {
    const cached = regimeCache.get(t);
    if (cached) return cached;
    const bench = sliceUpTo(dataset.benchmark, t);
    assertNoLookahead(bench, t, "benchmark");
    const vix = dataset.vix ? sliceUpTo(dataset.vix, t) : undefined;
    const r = deps.assessRegime(bench, t, vix);
    regimeCache.set(t, r);
    return r;
  };

  let cash = config.initialCapital;
  const positions = new Map<string, OpenPosition>();
  const pending: PendingOrder[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const barRegimes: { time: IsoTimestamp; regime: string }[] = [];
  let peakEquity = config.initialCapital;
  let nextOrderId = 1;
  let totalCosts = 0;

  const closeLot = (pos: OpenPosition, fill: Fill, t: IsoTimestamp, index: number, reason: string): void => {
    const qty = fill.quantity;
    const share = pos.quantity > 0 ? qty / pos.quantity : 1;
    const entryCosts = pos.entryCosts * share;
    const grossPnl = (fill.refPrice - pos.avgRef) * qty;
    const costs = entryCosts + fill.costs;
    const netPnl = grossPnl - costs;
    cash += fill.fillPrice * qty - fill.commission;
    totalCosts += fill.costs;
    const basis = pos.avgFill * qty;
    trades.push({
      symbol: pos.symbol,
      entryTime: pos.openedAt,
      exitTime: t,
      entryPrice: pos.avgFill,
      exitPrice: fill.fillPrice,
      quantity: qty,
      side: "long",
      grossPnl,
      costs,
      netPnl,
      returnPct: basis > 0 ? (netPnl / basis) * 100 : 0,
      holdingBars: index - pos.openedIndex,
      regime: pos.regime,
      confidence: pos.confidence,
      maePct: (pos.minLow / pos.avgRef - 1) * 100,
      mfePct: (pos.maxHigh / pos.avgRef - 1) * 100,
      exitReason: reason,
    });
    pos.quantity -= qty;
    pos.entryCosts -= entryCosts;
    if (pos.quantity <= 1e-9) positions.delete(pos.symbol);
  };

  const queueOrder = (o: Omit<PendingOrder, "id">): void => {
    pending.push({ ...o, id: nextOrderId++ });
  };

  for (let i = 0; i < days.length; i++) {
    const t = days[i] as IsoTimestamp;
    const regime = regimeAt(t);

    // 1. Survivorship: force-close positions in names that have been delisted.
    for (const pos of [...positions.values()]) {
      if (!isDelistedAt(dataset, pos.symbol, t)) continue;
      const last = lastBarAtOrBefore(pos.symbol, t);
      const lastPrice = (last?.close ?? pos.lastClose) * (1 - haircut);
      const fill = fillAtPrice("sell", pos.quantity, lastPrice, last, cost, false);
      closeLot(pos, fill, t, i, "delisting");
      warn(`${pos.symbol} force-closed on delisting at ${t}`);
      for (let k = pending.length - 1; k >= 0; k--) if ((pending[k] as PendingOrder).symbol === pos.symbol) pending.splice(k, 1);
    }

    // 2. Fill orders queued on earlier bars. Never fills on the bar the order was created.
    for (let k = pending.length - 1; k >= 0; k--) {
      const order = pending[k] as PendingOrder;
      if (order.fillIndex > i) continue;
      const bar = barAt(order.symbol, t);
      let fill: Fill | null = null;
      if (bar) {
        if (order.side === "sell") {
          const pos = positions.get(order.symbol);
          if (!pos) {
            pending.splice(k, 1);
            continue;
          }
          order.quantity = Math.min(order.quantity, pos.quantity);
        }
        fill = simulateFill(order, bar, cost);
      }
      if (fill) {
        if (order.side === "buy") {
          const existing = positions.get(order.symbol);
          const cashNeeded = fill.fillPrice * fill.quantity + fill.commission;
          if (cashNeeded > cash + 1e-9) {
            // Scale down to available cash (never trade on margin).
            const affordable = allowFractional ? (cash - fill.commission) / fill.fillPrice : Math.floor((cash - fill.commission) / fill.fillPrice);
            if (affordable <= 0) {
              pending.splice(k, 1);
              warn(`${order.symbol} buy cancelled at ${t}: insufficient cash`);
              continue;
            }
            const ratio = affordable / fill.quantity;
            fill = { ...fill, quantity: affordable, costs: fill.costs * ratio + fill.commission * (1 - ratio) };
          }
          cash -= fill.fillPrice * fill.quantity + fill.commission;
          totalCosts += fill.costs;
          if (existing) {
            const total = existing.quantity + fill.quantity;
            existing.avgRef = (existing.avgRef * existing.quantity + fill.refPrice * fill.quantity) / total;
            existing.avgFill = (existing.avgFill * existing.quantity + fill.fillPrice * fill.quantity) / total;
            existing.entryCosts += fill.costs;
            existing.quantity = total;
          } else {
            positions.set(order.symbol, {
              symbol: order.symbol,
              quantity: fill.quantity,
              avgRef: fill.refPrice,
              avgFill: fill.fillPrice,
              entryCosts: fill.costs,
              openedAt: t,
              openedIndex: i,
              stop: order.view?.invalidationPrice ?? null,
              target: order.view?.targetPrice ?? null,
              confidence: order.view?.confidence ?? 0,
              regime: order.regime,
              minLow: fill.refPrice,
              maxHigh: fill.refPrice,
              barsHeld: 0,
              lastClose: bar ? bar.close : fill.fillPrice,
            });
          }
        } else {
          const pos = positions.get(order.symbol) as OpenPosition;
          closeLot(pos, fill, t, i, order.reason);
        }
        order.quantity -= fill.quantity;
      }
      if (order.quantity <= 1e-9 || i >= order.expiresIndex) {
        if (order.quantity > 1e-9) warn(`${order.symbol} ${order.side} order partially/unfilled and cancelled at ${t}`);
        pending.splice(k, 1);
      }
    }

    // 3. Manage open positions on this bar: MAE/MFE, stops, targets, holding limits.
    for (const pos of [...positions.values()]) {
      const bar = barAt(pos.symbol, t);
      if (!bar) continue;
      pos.lastClose = bar.close;
      pos.minLow = Math.min(pos.minLow, bar.low);
      pos.maxHigh = Math.max(pos.maxHigh, bar.high);
      if (i > pos.openedIndex) pos.barsHeld++;
      // Stops are resting orders: they trigger inside the bar, before the close is known.
      if (pos.stop !== null && bar.low <= pos.stop) {
        const ref = Math.min(bar.open, pos.stop);
        closeLot(pos, fillAtPrice("sell", pos.quantity, ref, bar, cost, true), t, i, "stop");
        continue;
      }
      if (pos.target !== null && bar.high >= pos.target) {
        const ref = Math.max(bar.open, pos.target);
        closeLot(pos, fillAtPrice("sell", pos.quantity, ref, bar, cost, false), t, i, "target");
        continue;
      }
      if (maxHoldingBars !== null && pos.barsHeld >= maxHoldingBars && !pending.some((o) => o.symbol === pos.symbol && o.side === "sell")) {
        queueOrder({
          symbol: pos.symbol,
          side: "sell",
          quantity: pos.quantity,
          type: "market",
          limitPrice: null,
          createdIndex: i,
          fillIndex: i + 1,
          expiresIndex: i + 1 + carryUnfilledBars,
          reason: "max_holding",
          view: null,
          regime: regime.primary,
        });
      }
    }

    // 4. Decisions at the close of bar i using only data <= t.
    const equityNow = markToMarket(cash, positions);
    const universe = universeAt(scopedDataset, t, includeDelisted).filter((s) => barAt(s, t) !== null);
    const benchBars = sliceUpTo(dataset.benchmark, t);
    let universeFeatures: { symbol: string; features: Record<string, number | null> }[] | undefined;
    const featureCache = new Map<string, FeatureResult>();
    const featuresFor = (symbol: string, bars: Bar[], intraday: Bar[] | undefined, quote: Quote): FeatureResult => {
      const cached = featureCache.get(symbol);
      if (cached) return cached;
      const f = deps.computeFeatures(bars, intraday, quote, benchBars);
      featureCache.set(symbol, f);
      return f;
    };
    const contextInputs = new Map<string, { bars: Bar[]; intraday: Bar[] | undefined; quote: Quote }>();
    for (const symbol of universe) {
      const bars = sliceUpTo(dataset.bars[symbol] ?? [], t);
      assertNoLookahead(bars, t, symbol);
      if (bars.length < strategy.descriptor.warmupBars) continue;
      const intradayRaw = dataset.intradayBars?.[symbol];
      const intraday = intradayRaw ? sliceUpTo(intradayRaw, t) : undefined;
      if (intraday) assertNoLookahead(intraday, t, `${symbol} intraday`);
      const last = bars[bars.length - 1] as Bar;
      const prev = bars.length > 1 ? (bars[bars.length - 2] as Bar) : null;
      const quote = quoteFromBar(last, prev, cost);
      contextInputs.set(symbol, { bars, intraday, quote });
    }
    if (strategy.descriptor.needsUniverse) {
      universeFeatures = [];
      for (const [symbol, input] of contextInputs) {
        universeFeatures.push({ symbol, features: featuresFor(symbol, input.bars, input.intraday, input.quote).values });
      }
    }

    for (const [symbol, input] of contextInputs) {
      if (pending.some((o) => o.symbol === symbol)) continue;
      const features = featuresFor(symbol, input.bars, input.intraday, input.quote);
      for (const w of features.warnings) warn(`features(${symbol}): ${w}`);
      const pos = positions.get(symbol) ?? null;
      const ctx: StrategyContext = {
        asOf: t,
        symbol,
        bars: input.bars,
        quote: input.quote,
        features: features.values,
        regime,
        upcomingEvents: [],
        position: pos ? { quantity: pos.quantity, averageCost: pos.avgFill, openedAt: pos.openedAt, strategyKey: strategy.descriptor.key } : null,
        parameters: config.parameters,
        featureVersion: features.featureVersion,
      };
      if (input.intraday) ctx.intradayBars = input.intraday;
      if (universeFeatures) ctx.universe = universeFeatures;
      const output = strategy.evaluate(ctx);
      // Defensive: a strategy must not have grown the bar array past asOf.
      assertNoLookahead(ctx.bars, t, `${symbol} after evaluate`);
      const view = output.view;
      if (!view || view.direction === "flat") continue;
      const lastClose = input.quote.last;

      if (view.direction === "long") {
        if (pos) {
          // Refresh protective levels from the latest view.
          if (view.invalidationPrice !== null) pos.stop = view.invalidationPrice;
          if (view.targetPrice !== null) pos.target = view.targetPrice;
          continue;
        }
        if (positions.size + pending.filter((o) => o.side === "buy").length >= maxOpenPositions) continue;
        const qty = sizer({
          symbol,
          equity: equityNow,
          cash,
          price: lastClose,
          confidence: view.confidence,
          strength: view.strength,
          view,
          parameters: config.parameters,
          openPositions: positions.size,
          maxPositionFraction,
          allowFractional,
        });
        if (!(qty > 0)) continue;
        queueOrder({
          symbol,
          side: "buy",
          quantity: allowFractional ? qty : Math.floor(qty),
          type: entryOrderType,
          limitPrice: entryOrderType === "limit" ? lastClose * (1 - limitOffsetBps / 10_000) : null,
          createdIndex: i,
          fillIndex: i + delay,
          expiresIndex: i + delay + carryUnfilledBars,
          reason: "entry",
          view,
          regime: regime.primary,
        });
      } else if (pos && (view.direction === "exit" || view.direction === "reduce")) {
        const qty = view.direction === "exit" ? pos.quantity : allowFractional ? pos.quantity * reduceFraction : Math.floor(pos.quantity * reduceFraction);
        if (qty <= 0) continue;
        queueOrder({
          symbol,
          side: "sell",
          quantity: qty,
          type: "market",
          limitPrice: null,
          createdIndex: i,
          fillIndex: i + delay,
          expiresIndex: i + delay + carryUnfilledBars,
          reason: view.direction,
          view,
          regime: regime.primary,
        });
      }
    }

    // 5. Mark to market at the close.
    const equity = markToMarket(cash, positions);
    if (equity > peakEquity) peakEquity = equity;
    const invested = equity - cash;
    equityCurve.push({
      time: t,
      equity,
      drawdownPct: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
      exposure: equity > 0 ? Math.max(0, invested / equity) : 0,
    });
    barRegimes.push({ time: t, regime: regime.primary });
  }

  // Open positions at the end are reported as open trades (marked at the last close).
  const lastIndex = Math.max(0, days.length - 1);
  for (const pos of positions.values()) {
    const unrealizedGross = (pos.lastClose - pos.avgRef) * pos.quantity;
    trades.push({
      symbol: pos.symbol,
      entryTime: pos.openedAt,
      exitTime: null,
      entryPrice: pos.avgFill,
      exitPrice: null,
      quantity: pos.quantity,
      side: "long",
      grossPnl: unrealizedGross,
      costs: pos.entryCosts,
      netPnl: unrealizedGross - pos.entryCosts,
      returnPct: pos.avgFill > 0 ? ((pos.lastClose - pos.avgFill) / pos.avgFill) * 100 : 0,
      holdingBars: lastIndex - pos.openedIndex,
      regime: pos.regime,
      confidence: pos.confidence,
      maePct: (pos.minLow / pos.avgRef - 1) * 100,
      mfePct: (pos.maxHigh / pos.avgRef - 1) * 100,
      exitReason: "open",
    });
  }

  trades.sort((a, b) => compareTime(a.entryTime, b.entryTime) || a.symbol.localeCompare(b.symbol));
  const periodsPerYear = PERIODS_PER_YEAR[config.interval];
  const metrics = computeMetrics(equityCurve, trades, periodsPerYear, { totalCosts, initialCapital: config.initialCapital });
  const dataFingerprint = fingerprint(dataset);
  const id = opts.id ?? `bt_${fnv1a64(`${dataFingerprint}|${stableStringify(config)}|${strategy.descriptor.key}`)}`;
  return {
    id,
    config,
    kind: opts.kind ?? "in_sample",
    metrics,
    trades,
    equityCurve,
    warnings,
    dataFingerprint,
    ranAt: opts.ranAt ?? config.end,
    durationMs: 0,
    barRegimes,
    openPositions: positions.size,
  };
}

function markToMarket(cash: number, positions: Map<string, OpenPosition>): number {
  let equity = cash;
  for (const p of positions.values()) equity += p.quantity * p.lastClose;
  return equity;
}

/** A quote synthesised from the latest bar so strategies get the same shape as in live trading. */
export function quoteFromBar(last: Bar, prev: Bar | null, cost: CostModel): Quote {
  const half = cost.defaultHalfSpreadBps / 10_000;
  return {
    symbol: last.symbol,
    last: last.close,
    bid: last.close * (1 - half),
    ask: last.close * (1 + half),
    previousClose: prev ? prev.close : null,
    lastTradeAt: last.time,
    session: "regular",
    instrumentState: "active",
    provenance: { source: "backtest:bar", observedAt: last.time, receivedAt: last.time, reliability: 1 },
  };
}

/** JSON with sorted keys so identical configs hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
