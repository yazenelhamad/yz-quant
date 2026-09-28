import type { Bar, BarInterval } from "../types/index.js";

/**
 * Deterministic synthetic bar generators for tests, sensitivity studies and documentation.
 * Uses a seeded LCG so results are reproducible; no `Math.random`, no clock.
 */

export function seededRandom(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1_664_525, s) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

/** Standard normal via Box–Muller from a seeded uniform generator. */
export function seededNormal(rand: () => number): () => number {
  return () => {
    let u = rand();
    let v = rand();
    if (u <= 1e-12) u = 1e-12;
    if (v <= 1e-12) v = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface SyntheticSeriesOptions {
  symbol: string;
  /** ISO time of the first bar (UTC). Defaults to 2025-01-02T00:00:00Z. */
  start?: string;
  bars: number;
  interval?: BarInterval;
  /** Daily drift (fraction), e.g. 0.001 = +0.1%/day. */
  drift?: number;
  /** Daily volatility (fraction), e.g. 0.01 = 1%/day. */
  vol?: number;
  startPrice?: number;
  volume?: number;
  seed?: number;
  /** Skip weekends when interval is daily. Default true. */
  skipWeekends?: boolean;
  /** Optional per-bar override applied after generation (index, bar) => bar. */
  transform?: (index: number, bar: Bar) => Bar;
}

/** Geometric random walk bars. */
export function syntheticBars(opts: SyntheticSeriesOptions): Bar[] {
  const interval = opts.interval ?? "day";
  const stepMs = interval === "day" ? 86_400_000 : interval === "5minute" ? 300_000 : interval === "minute" ? 60_000 : interval === "hour" ? 3_600_000 : interval === "30minute" ? 1_800_000 : interval === "15minute" ? 900_000 : interval === "10minute" ? 600_000 : interval === "4hour" ? 14_400_000 : interval === "week" ? 7 * 86_400_000 : 30 * 86_400_000;
  const skipWeekends = opts.skipWeekends ?? interval === "day";
  const rand = seededRandom(opts.seed ?? 42);
  const normal = seededNormal(rand);
  const drift = opts.drift ?? 0;
  const vol = opts.vol ?? 0.01;
  let price = opts.startPrice ?? 100;
  let t = Date.parse(opts.start ?? "2025-01-02T00:00:00Z");
  const out: Bar[] = [];
  let i = 0;
  while (out.length < opts.bars) {
    const dow = new Date(t).getUTCDay();
    if (skipWeekends && (dow === 0 || dow === 6)) { t += stepMs; continue; }
    const r = drift + vol * normal();
    const open = price;
    const close = price * Math.exp(r);
    const wiggle = Math.abs(vol * normal()) * price * 0.5;
    const high = Math.max(open, close) + wiggle;
    const low = Math.max(0.01, Math.min(open, close) - wiggle);
    const volume = Math.round((opts.volume ?? 1_000_000) * (0.7 + 0.6 * rand()));
    let bar: Bar = {
      symbol: opts.symbol,
      interval,
      time: new Date(t).toISOString(),
      open, high, low, close, volume,
      interpolated: false,
      adjusted: "all",
    };
    if (opts.transform) bar = opts.transform(i, bar);
    out.push(bar);
    price = bar.close;
    t += stepMs;
    i += 1;
  }
  return out;
}

/** Deterministic linear trend with small noise, useful for trend-strength assertions. */
export function trendingBars(symbol: string, bars: number, dailyReturn: number, seed = 7, start?: string): Bar[] {
  return syntheticBars({ symbol, bars, drift: dailyReturn, vol: Math.abs(dailyReturn) * 0.5 + 0.002, seed, start });
}

/** Oscillating (range-bound) series: sine wave around a level. */
export function rangeBoundBars(symbol: string, bars: number, level = 100, amplitude = 3, period = 20, seed = 11, start?: string): Bar[] {
  const rand = seededRandom(seed);
  const t0 = Date.parse(start ?? "2025-01-02T00:00:00Z");
  const out: Bar[] = [];
  let t = t0;
  let i = 0;
  while (out.length < bars) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) { t += 86_400_000; continue; }
    const close = level + amplitude * Math.sin((2 * Math.PI * i) / period) + (rand() - 0.5) * 0.3;
    const open = i === 0 ? close : (out[out.length - 1] as Bar).close;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    out.push({ symbol, interval: "day", time: new Date(t).toISOString(), open, high, low, close, volume: 1_000_000 + Math.round(rand() * 100_000), interpolated: false, adjusted: "all" });
    t += 86_400_000;
    i += 1;
  }
  return out;
}

/**
 * Mean-reverting (AR(1) around a level) series: price_t = level + phi * (price_{t-1} - level) + noise.
 * With phi well below 1 daily returns are negatively autocorrelated, which is what a
 * range-bound, mean-reverting market looks like to the regime engine.
 */
export function meanRevertingBars(symbol: string, bars: number, level = 100, phi = 0.3, noise = 1.0, seed = 17, start?: string): Bar[] {
  const rand = seededRandom(seed);
  const normal = seededNormal(rand);
  const t0 = Date.parse(start ?? "2025-01-02T00:00:00Z");
  const out: Bar[] = [];
  let t = t0;
  let prev = level;
  while (out.length < bars) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) { t += 86_400_000; continue; }
    const close = level + phi * (prev - level) + noise * normal();
    const open = prev;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    out.push({ symbol, interval: "day", time: new Date(t).toISOString(), open, high, low, close, volume: 1_000_000 + Math.round(rand() * 100_000), interpolated: false, adjusted: "all" });
    prev = close;
    t += 86_400_000;
  }
  return out;
}

/** Last bar time of a series (or the given fallback). */
export function lastBarTime(bars: readonly Bar[], fallback = "2025-01-02T00:00:00Z"): string {
  const b = bars[bars.length - 1];
  return b ? b.time : fallback;
}
