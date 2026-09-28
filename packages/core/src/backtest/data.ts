/**
 * Backtest dataset model and look-ahead / survivorship protections.
 *
 * All helpers are pure. Bars are expected to be ascending by `time` and daily unless the
 * dataset says otherwise; the guards in this module make sure no code path can observe a
 * bar after the decision time (`asOf`).
 */
import type { Bar, IsoTimestamp } from "../types/index.js";
import { fnv1a64 } from "./random.js";

export interface CorporateAction {
  symbol: string;
  /** ISO timestamp of the effective date (ex-date for splits/dividends). */
  date: IsoTimestamp;
  kind: "split" | "dividend" | "delisting";
  /** For splits: new shares per old share (2 = 2-for-1, 0.1 = 1-for-10 reverse). */
  ratio?: number;
  /** For dividends: cash amount per share. */
  amount?: number;
}

export interface BacktestDataset {
  symbols: string[];
  /** Daily bars per symbol, ascending by time. */
  bars: Record<string, Bar[]>;
  /** Optional finer bars per symbol, ascending by time. */
  intradayBars?: Record<string, Bar[]>;
  /** Benchmark (SPY) daily bars, ascending. Drives the trading calendar when none is given. */
  benchmark: Bar[];
  vix?: Bar[];
  corporateActions: CorporateAction[];
  /** Symbol -> time at which the security stopped trading. */
  delistings: Record<string, IsoTimestamp>;
  /** Optional explicit list of trading-day timestamps (ascending). */
  calendar?: IsoTimestamp[];
}

export class LookaheadError extends Error {
  override readonly name = "LookaheadError";
}

export class DatasetError extends Error {
  override readonly name = "DatasetError";
}

/** Timestamps compare lexicographically when they are ISO-8601 UTC strings of equal shape. */
export function compareTime(a: IsoTimestamp, b: IsoTimestamp): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? -1 : a > b ? 1 : 0;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/** Index of the last bar with time <= asOf, or -1. Bars must be ascending. Binary search. */
export function lastIndexAtOrBefore(bars: readonly Bar[], asOf: IsoTimestamp): number {
  let lo = 0;
  let hi = bars.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bar = bars[mid] as Bar;
    if (compareTime(bar.time, asOf) <= 0) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Bars strictly at or before `asOf` (look-ahead protection). Returns a new array; the
 * original is never mutated. Interpolated bars are dropped so feature computation never
 * sees synthesised data.
 */
export function sliceUpTo(bars: readonly Bar[], asOf: IsoTimestamp, opts: { includeInterpolated?: boolean } = {}): Bar[] {
  const idx = lastIndexAtOrBefore(bars, asOf);
  if (idx < 0) return [];
  const slice = bars.slice(0, idx + 1);
  return opts.includeInterpolated ? slice : slice.filter((b) => !b.interpolated);
}

/** Throws when any bar is after `asOf`. Used as a defensive guard on every strategy context. */
export function assertNoLookahead(bars: readonly Bar[], asOf: IsoTimestamp, context = "bars"): void {
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i] as Bar;
    if (compareTime(bar.time, asOf) > 0) {
      throw new LookaheadError(`${context}: bar at ${bar.time} is after asOf ${asOf}`);
    }
    // Ascending input: once we are at/before asOf, all earlier bars are too.
    break;
  }
}

/** Validates ordering and basic integrity of a bar series. */
export function assertAscending(bars: readonly Bar[], label = "bars"): void {
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1] as Bar;
    const cur = bars[i] as Bar;
    if (compareTime(prev.time, cur.time) >= 0) {
      throw new DatasetError(`${label}: bars not strictly ascending at index ${i} (${prev.time} >= ${cur.time})`);
    }
  }
}

export function validateDataset(dataset: BacktestDataset): string[] {
  const warnings: string[] = [];
  assertAscending(dataset.benchmark, "benchmark");
  if (dataset.calendar) {
    for (let i = 1; i < dataset.calendar.length; i++) {
      if (compareTime(dataset.calendar[i - 1] as string, dataset.calendar[i] as string) >= 0) {
        throw new DatasetError("calendar not strictly ascending");
      }
    }
  }
  for (const symbol of dataset.symbols) {
    const bars = dataset.bars[symbol];
    if (!bars) {
      warnings.push(`no bars for ${symbol}`);
      continue;
    }
    assertAscending(bars, symbol);
    for (const bar of bars) {
      if (bar.high < bar.low || bar.open <= 0 || bar.close <= 0 || bar.volume < 0) {
        throw new DatasetError(`${symbol}: invalid bar at ${bar.time}`);
      }
    }
    const intraday = dataset.intradayBars?.[symbol];
    if (intraday) assertAscending(intraday, `${symbol} intraday`);
  }
  return warnings;
}

/** True when the symbol is delisted at or before asOf. */
export function isDelistedAt(dataset: BacktestDataset, symbol: string, asOf: IsoTimestamp): boolean {
  const at = dataset.delistings[symbol];
  return at !== undefined && compareTime(at, asOf) <= 0;
}

/**
 * The investable universe at `asOf`: symbols that exist in the dataset and have not yet
 * been delisted. Delisted names are included before their delisting date so that the
 * backtest is not survivorship-biased (a strategy can buy a name that later dies).
 */
export function universeAt(dataset: BacktestDataset, asOf: IsoTimestamp, includeDelisted = true): string[] {
  return dataset.symbols.filter((symbol) => {
    if (!dataset.bars[symbol] || (dataset.bars[symbol] as Bar[]).length === 0) return false;
    const delistedAt = dataset.delistings[symbol];
    if (delistedAt === undefined) return true;
    if (!includeDelisted) return false;
    return compareTime(delistedAt, asOf) > 0;
  });
}

/** Trading-day timestamps between start and end inclusive, from the calendar or benchmark bars. */
export function tradingDays(dataset: BacktestDataset, start: IsoTimestamp, end: IsoTimestamp): IsoTimestamp[] {
  const source = dataset.calendar ?? dataset.benchmark.map((b) => b.time);
  return source.filter((t) => compareTime(t, start) >= 0 && compareTime(t, end) <= 0);
}

/**
 * Back-adjusts unadjusted bars for splits (and dividends when `mode === "all"`).
 * Bars already marked as adjusted are returned unchanged. Adjustment is applied to all bars
 * strictly before the action's effective date, which is the standard convention.
 */
export function applyCorporateActions(
  bars: readonly Bar[],
  actions: readonly CorporateAction[],
  mode: "split" | "all" = "split",
): Bar[] {
  if (bars.length === 0) return [];
  const symbol = (bars[0] as Bar).symbol;
  const relevant = actions
    .filter((a) => a.symbol === symbol && (a.kind === "split" || (mode === "all" && a.kind === "dividend")))
    .sort((a, b) => compareTime(a.date, b.date));
  if (relevant.length === 0) return bars.slice();
  const out = bars.map((b) => ({ ...b }));
  for (const action of relevant) {
    const firstAfter = out.findIndex((b) => compareTime(b.time, action.date) >= 0);
    const affected = firstAfter < 0 ? out.length : firstAfter;
    if (affected === 0) continue;
    let priceFactor = 1;
    let volumeFactor = 1;
    if (action.kind === "split" && action.ratio && action.ratio > 0) {
      priceFactor = 1 / action.ratio;
      volumeFactor = action.ratio;
    } else if (action.kind === "dividend" && action.amount && action.amount > 0) {
      const prevClose = (out[affected - 1] as Bar).close;
      if (prevClose > 0) priceFactor = 1 - action.amount / prevClose;
    }
    for (let i = 0; i < affected; i++) {
      const b = out[i] as Bar;
      if (b.adjusted !== "none") continue;
      b.open *= priceFactor;
      b.high *= priceFactor;
      b.low *= priceFactor;
      b.close *= priceFactor;
      b.volume *= volumeFactor;
    }
  }
  const target: Bar["adjusted"] = mode === "all" ? "all" : "split";
  for (const b of out) if (b.adjusted === "none") b.adjusted = target;
  return out;
}

/** Applies corporate actions to every symbol in the dataset (returns a new dataset). */
export function adjustDataset(dataset: BacktestDataset, mode: "split" | "all" = "split"): BacktestDataset {
  const bars: Record<string, Bar[]> = {};
  for (const symbol of dataset.symbols) {
    bars[symbol] = applyCorporateActions(dataset.bars[symbol] ?? [], dataset.corporateActions, mode);
  }
  return { ...dataset, bars };
}

/**
 * Stable FNV-1a fingerprint of the dataset: symbols, bar counts, first/last times and last
 * closes, benchmark shape, corporate actions and delistings. Two datasets with the same
 * fingerprint reproduce the same backtest.
 */
export function fingerprint(dataset: BacktestDataset): string {
  const parts: string[] = [];
  const describe = (label: string, bars: readonly Bar[] | undefined): void => {
    if (!bars || bars.length === 0) {
      parts.push(`${label}:0`);
      return;
    }
    const first = bars[0] as Bar;
    const last = bars[bars.length - 1] as Bar;
    parts.push(`${label}:${bars.length}:${first.time}:${last.time}:${last.close.toFixed(6)}:${last.volume}`);
  };
  for (const symbol of [...dataset.symbols].sort()) {
    describe(symbol, dataset.bars[symbol]);
    if (dataset.intradayBars?.[symbol]) describe(`${symbol}@intraday`, dataset.intradayBars[symbol]);
  }
  describe("benchmark", dataset.benchmark);
  describe("vix", dataset.vix);
  for (const a of [...dataset.corporateActions].sort((x, y) => (x.symbol + x.date + x.kind).localeCompare(y.symbol + y.date + y.kind))) {
    parts.push(`ca:${a.symbol}:${a.date}:${a.kind}:${a.ratio ?? ""}:${a.amount ?? ""}`);
  }
  for (const symbol of Object.keys(dataset.delistings).sort()) parts.push(`dl:${symbol}:${dataset.delistings[symbol]}`);
  if (dataset.calendar) parts.push(`cal:${dataset.calendar.length}:${dataset.calendar[0] ?? ""}:${dataset.calendar[dataset.calendar.length - 1] ?? ""}`);
  return fnv1a64(parts.join("|"));
}

/** Convenience: index bars by time for O(1) lookups. */
export function indexByTime(bars: readonly Bar[]): Map<IsoTimestamp, number> {
  const map = new Map<IsoTimestamp, number>();
  bars.forEach((b, i) => map.set(b.time, i));
  return map;
}
