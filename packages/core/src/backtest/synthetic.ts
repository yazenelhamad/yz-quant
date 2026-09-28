/**
 * SYNTHETIC DATA GENERATOR.
 *
 * Everything produced here is fabricated from a seeded geometric Brownian motion with
 * regime shifts. It exists for unit tests, demos and engine research only and must never be
 * presented as, mixed with, or persisted as real market data. Every bar carries a provenance
 * source of "synthetic:gbm" so downstream code can refuse it.
 */
import type { Bar, BarInterval, IsoTimestamp } from "../types/index.js";
import type { BacktestDataset, CorporateAction } from "./data.js";
import { mulberry32, randomNormal, type Rng } from "./random.js";

export const SYNTHETIC_SOURCE = "synthetic:gbm";

export interface SyntheticRegime {
  /** Number of bars this regime lasts. */
  bars: number;
  /** Annualised drift, e.g. 0.10. */
  drift: number;
  /** Annualised volatility, e.g. 0.20. */
  vol: number;
}

export interface SyntheticBarsOptions {
  symbol: string;
  /** First bar date, ISO (UTC). Defaults to 2020-01-02. */
  start?: IsoTimestamp;
  bars: number;
  seed: number;
  initialPrice?: number;
  /** Regime schedule; cycled when shorter than `bars`. Defaults to a mild bull regime. */
  regimes?: SyntheticRegime[];
  baseVolume?: number;
  /** Splits to embed as unadjusted price jumps: bar index -> ratio. */
  splits?: { atBar: number; ratio: number }[];
  interval?: BarInterval;
  /** Bars per year for scaling drift/vol (252 for daily). */
  periodsPerYear?: number;
}

const DAY_MS = 86_400_000;

/** Adds `n` calendar days to a UTC ISO timestamp (pure). */
export function addDays(iso: IsoTimestamp, n: number): IsoTimestamp {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString();
}

/** Next weekday (Mon-Fri) strictly after `iso`. Weekends are skipped; holidays are not modelled. */
export function nextTradingDay(iso: IsoTimestamp): IsoTimestamp {
  let t = Date.parse(iso) + DAY_MS;
  while (true) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) return new Date(t).toISOString();
    t += DAY_MS;
  }
}

/** Deterministic list of `count` weekday timestamps starting at (or after) `start`. */
export function syntheticCalendar(start: IsoTimestamp, count: number): IsoTimestamp[] {
  const out: IsoTimestamp[] = [];
  let t = Date.parse(start);
  const dow0 = new Date(t).getUTCDay();
  if (dow0 === 0 || dow0 === 6) t = Date.parse(nextTradingDay(new Date(t).toISOString()));
  let cur = new Date(t).toISOString();
  while (out.length < count) {
    out.push(cur);
    cur = nextTradingDay(cur);
  }
  return out;
}

/**
 * Generates synthetic OHLCV bars via seeded GBM with regime shifts.
 * The output is SYNTHETIC and only suitable for tests and research demos.
 */
export function generateSyntheticBars(options: SyntheticBarsOptions): Bar[] {
  const {
    symbol,
    bars: count,
    seed,
    initialPrice = 100,
    baseVolume = 1_000_000,
    interval = "day",
    periodsPerYear = 252,
  } = options;
  const start = options.start ?? "2020-01-02T00:00:00.000Z";
  const regimes = options.regimes && options.regimes.length > 0 ? options.regimes : [{ bars: count, drift: 0.08, vol: 0.18 }];
  const rng: Rng = mulberry32(seed);
  const calendar = syntheticCalendar(start, count);
  const splitsAt = new Map<number, number>();
  for (const s of options.splits ?? []) splitsAt.set(s.atBar, s.ratio);

  const out: Bar[] = [];
  let price = initialPrice;
  let regimeIdx = 0;
  let regimeLeft = (regimes[0] as SyntheticRegime).bars;
  for (let i = 0; i < count; i++) {
    if (regimeLeft <= 0) {
      regimeIdx = (regimeIdx + 1) % regimes.length;
      regimeLeft = (regimes[regimeIdx] as SyntheticRegime).bars;
    }
    const regime = regimes[regimeIdx] as SyntheticRegime;
    regimeLeft--;
    const dt = 1 / periodsPerYear;
    const z = randomNormal(rng);
    const ret = (regime.drift - 0.5 * regime.vol * regime.vol) * dt + regime.vol * Math.sqrt(dt) * z;
    const split = splitsAt.get(i);
    if (split && split > 0) price = price / split; // unadjusted series jumps on the split date
    const open = price * (1 + 0.25 * regime.vol * Math.sqrt(dt) * randomNormal(rng));
    const close = price * Math.exp(ret);
    const wiggle = Math.abs(regime.vol * Math.sqrt(dt) * randomNormal(rng)) * price;
    const high = Math.max(open, close) + wiggle;
    const low = Math.max(0.01, Math.min(open, close) - wiggle);
    const volume = Math.round(baseVolume * (0.6 + 0.8 * rng()) * (1 + 2 * Math.abs(z) * regime.vol));
    out.push({
      symbol,
      interval,
      time: calendar[i] as IsoTimestamp,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
      interpolated: false,
      adjusted: "none",
      provenance: { source: SYNTHETIC_SOURCE, observedAt: calendar[i] as IsoTimestamp, receivedAt: calendar[i] as IsoTimestamp, reliability: 0 },
    });
    price = close;
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

export interface SyntheticDatasetOptions {
  symbols: string[];
  bars: number;
  seed: number;
  start?: IsoTimestamp;
  regimes?: SyntheticRegime[];
  /** Symbols to delist at a given bar index (their bars stop there). */
  delistings?: { symbol: string; atBar: number }[];
  splits?: { symbol: string; atBar: number; ratio: number }[];
  initialPrice?: number;
  baseVolume?: number;
  includeVix?: boolean;
}

/** A complete SYNTHETIC dataset (symbols + SPY-like benchmark + optional VIX-like series). */
export function generateSyntheticDataset(options: SyntheticDatasetOptions): BacktestDataset {
  const start = options.start ?? "2020-01-02T00:00:00.000Z";
  const calendar = syntheticCalendar(start, options.bars);
  const bars: Record<string, Bar[]> = {};
  const corporateActions: CorporateAction[] = [];
  const delistings: Record<string, IsoTimestamp> = {};
  options.symbols.forEach((symbol, i) => {
    const splits = (options.splits ?? []).filter((s) => s.symbol === symbol).map((s) => ({ atBar: s.atBar, ratio: s.ratio }));
    let series = generateSyntheticBars({
      symbol,
      start,
      bars: options.bars,
      seed: options.seed + 1000 * (i + 1),
      initialPrice: options.initialPrice ?? 50 + 25 * i,
      regimes: options.regimes,
      baseVolume: options.baseVolume,
      splits,
    });
    for (const s of splits) {
      corporateActions.push({ symbol, date: calendar[s.atBar] as IsoTimestamp, kind: "split", ratio: s.ratio });
    }
    const delist = (options.delistings ?? []).find((d) => d.symbol === symbol);
    if (delist) {
      series = series.slice(0, Math.max(1, delist.atBar));
      const at = calendar[Math.min(delist.atBar, calendar.length - 1)] as IsoTimestamp;
      delistings[symbol] = at;
      corporateActions.push({ symbol, date: at, kind: "delisting" });
    }
    bars[symbol] = series;
  });
  const benchmark = generateSyntheticBars({
    symbol: "SPY",
    start,
    bars: options.bars,
    seed: options.seed,
    initialPrice: 300,
    regimes: options.regimes,
    baseVolume: 50_000_000,
  });
  const dataset: BacktestDataset = { symbols: options.symbols, bars, benchmark, corporateActions, delistings, calendar };
  if (options.includeVix) {
    dataset.vix = generateSyntheticBars({
      symbol: "VIX",
      start,
      bars: options.bars,
      seed: options.seed + 7,
      initialPrice: 18,
      regimes: [{ bars: options.bars, drift: 0, vol: 0.9 }],
      baseVolume: 0,
    });
  }
  return dataset;
}
