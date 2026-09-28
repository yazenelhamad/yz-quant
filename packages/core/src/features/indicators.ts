import type { Bar } from "../types/index.js";
import { clamp, linearRegression, mean, stddev, sum } from "./math.js";

/**
 * Indicator library on ascending, already-filtered bar arrays.
 * Every function returns `null` when it cannot be computed from the bars provided; nothing is
 * ever extrapolated. Series-returning functions align with the input (null while warming up).
 */

export function closes(bars: readonly Bar[]): number[] {
  return bars.map((b) => b.close);
}

export function sma(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  return sum(values.slice(values.length - period)) / period;
}

export function smaSeries(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let acc = 0;
  for (let i = 0; i < values.length; i += 1) {
    acc += values[i] as number;
    if (i >= period) acc -= values[i - period] as number;
    if (i >= period - 1) out[i] = acc / period;
  }
  return out;
}

export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let e = sum(values.slice(0, period)) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i += 1) {
    e = (values[i] as number) * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length > 0 ? (s[s.length - 1] ?? null) : null;
}

/** Simple return over `period` bars: close[t] / close[t-period] - 1. */
export function returnOver(values: readonly number[], period: number): number | null {
  const n = values.length;
  if (period <= 0 || n <= period) return null;
  const a = values[n - 1 - period] as number;
  const b = values[n - 1] as number;
  if (a <= 0) return null;
  return b / a - 1;
}

/** 12-1 momentum: return from t-252 to t-21 (skipping the most recent month). */
export function momentum12_1(values: readonly number[], lookback = 252, skip = 21): number | null {
  const n = values.length;
  if (n <= lookback) return null;
  const a = values[n - 1 - lookback] as number;
  const b = values[n - 1 - skip] as number;
  if (a <= 0) return null;
  return b / a - 1;
}

/** Log returns series (length n-1). */
export function logReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const a = values[i - 1] as number;
    const b = values[i] as number;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

export function simpleReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const a = values[i - 1] as number;
    const b = values[i] as number;
    if (a > 0) out.push(b / a - 1);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(values: readonly number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = (values[i] as number) - (values[i - 1] as number);
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const d = (values[i] as number) - (values[i - 1] as number);
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): { macd: number; signal: number; histogram: number } | null {
  if (values.length < slow + signalPeriod) return null;
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const line: number[] = [];
  for (let i = slow - 1; i < values.length; i += 1) {
    const fv = f[i];
    const sv = s[i];
    if (fv === null || fv === undefined || sv === null || sv === undefined) continue;
    line.push(fv - sv);
  }
  const sig = ema(line, signalPeriod);
  const m = line[line.length - 1];
  if (sig === null || m === undefined) return null;
  return { macd: m, signal: sig, histogram: m - sig };
}

export function trueRanges(bars: readonly Bar[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i] as Bar;
    const prev = i > 0 ? (bars[i - 1] as Bar).close : b.close;
    out.push(Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)));
  }
  return out;
}

/** Wilder ATR. */
export function atr(bars: readonly Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr = trueRanges(bars);
  let a = sum(tr.slice(1, period + 1)) / period;
  for (let i = period + 1; i < tr.length; i += 1) {
    a = (a * (period - 1) + (tr[i] as number)) / period;
  }
  return a;
}

export function bollingerZ(values: readonly number[], period = 20): number | null {
  if (values.length < period) return null;
  const window = values.slice(values.length - period);
  const m = mean(window);
  const sd = stddev(window);
  if (m === null || sd === null || sd === 0) return null;
  return ((values[values.length - 1] as number) - m) / sd;
}

/** Annualised realised volatility of log returns over the last `period` returns. */
export function realizedVol(values: readonly number[], period: number, periodsPerYear = 252): number | null {
  const r = logReturns(values);
  if (r.length < period) return null;
  const sd = stddev(r.slice(r.length - period));
  return sd === null ? null : sd * Math.sqrt(periodsPerYear);
}

/** Daily (non-annualised) realised vol. */
export function realizedVolDaily(values: readonly number[], period: number): number | null {
  const r = logReturns(values);
  if (r.length < period) return null;
  return stddev(r.slice(r.length - period));
}

/** Volume-weighted average price of a set of bars (typical price weighted by volume). */
export function vwap(bars: readonly Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    if (b.volume <= 0) continue;
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

export function relativeVolume(bars: readonly Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const prior = bars.slice(bars.length - 1 - period, bars.length - 1).map((b) => b.volume);
  const avg = mean(prior);
  if (avg === null || avg <= 0) return null;
  return (bars[bars.length - 1] as Bar).volume / avg;
}

export function gapPct(bars: readonly Bar[]): number | null {
  if (bars.length < 2) return null;
  const prev = (bars[bars.length - 2] as Bar).close;
  const open = (bars[bars.length - 1] as Bar).open;
  if (prev <= 0) return null;
  return open / prev - 1;
}

export function highestHigh(bars: readonly Bar[], period: number, excludeLast = true): number | null {
  const end = excludeLast ? bars.length - 1 : bars.length;
  const start = end - period;
  if (start < 0 || end <= 0) return null;
  let h = -Infinity;
  for (let i = start; i < end; i += 1) h = Math.max(h, (bars[i] as Bar).high);
  return Number.isFinite(h) ? h : null;
}

export function lowestLow(bars: readonly Bar[], period: number, excludeLast = true): number | null {
  const end = excludeLast ? bars.length - 1 : bars.length;
  const start = end - period;
  if (start < 0 || end <= 0) return null;
  let l = Infinity;
  for (let i = start; i < end; i += 1) l = Math.min(l, (bars[i] as Bar).low);
  return Number.isFinite(l) ? l : null;
}

/**
 * Breakout: last close above the highest high of the prior `period` bars, confirmed by
 * relative volume >= `volumeMultiple`. Returns 1/0, null when not computable.
 */
export function breakoutFlag(bars: readonly Bar[], period: number, volumeMultiple = 1.5): number | null {
  const hh = highestHigh(bars, period);
  const rv = relativeVolume(bars, Math.min(20, period));
  if (hh === null || rv === null) return null;
  const lastBar = bars[bars.length - 1] as Bar;
  return lastBar.close > hh && rv >= volumeMultiple ? 1 : 0;
}

/**
 * Failed breakout: within the last `window` bars a close pushed above the prior `period`-bar
 * high and the latest close is back below that level. Returns 1/0.
 */
export function failedBreakoutFlag(bars: readonly Bar[], period = 20, window = 5): number | null {
  if (bars.length < period + window + 1) return null;
  const lastClose = (bars[bars.length - 1] as Bar).close;
  for (let k = 1; k <= window; k += 1) {
    const idx = bars.length - 1 - k;
    const sub = bars.slice(0, idx + 1);
    const hh = highestHigh(sub, period);
    if (hh === null) continue;
    const c = (bars[idx] as Bar).close;
    if (c > hh && lastClose < hh) return 1;
  }
  return 0;
}

/**
 * Pivot-based support/resistance. Pivot highs/lows (local extrema with `left`/`right` bars on
 * each side) are clustered when within `tolerance` (fraction) of each other; the cluster
 * level is the mean. Returns levels ascending with their touch counts.
 */
export function pivotLevels(bars: readonly Bar[], left = 3, right = 3, tolerance = 0.01): { level: number; touches: number }[] {
  const pivots: number[] = [];
  for (let i = left; i < bars.length - right; i += 1) {
    const b = bars[i] as Bar;
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      const o = bars[j] as Bar;
      if (o.high > b.high) isHigh = false;
      if (o.low < b.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push(b.high);
    if (isLow) pivots.push(b.low);
  }
  pivots.sort((a, b) => a - b);
  const clusters: { level: number; touches: number }[] = [];
  for (const p of pivots) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p - c.level) / c.level <= tolerance) {
      c.level = (c.level * c.touches + p) / (c.touches + 1);
      c.touches += 1;
    } else {
      clusters.push({ level: p, touches: 1 });
    }
  }
  return clusters;
}

export function nearestLevels(levels: readonly { level: number; touches: number }[], price: number): { support: number | null; resistance: number | null } {
  let support: number | null = null;
  let resistance: number | null = null;
  for (const l of levels) {
    if (l.level < price && (support === null || l.level > support)) support = l.level;
    if (l.level > price && (resistance === null || l.level < resistance)) resistance = l.level;
  }
  return { support, resistance };
}

/** Wilder ADX. Null when fewer than 2*period+1 bars. */
export function adx(bars: readonly Bar[], period = 14): number | null {
  if (bars.length < 2 * period + 1) return null;
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i] as Bar;
    const p = bars[i - 1] as Bar;
    const up = b.high - p.high;
    const down = p.low - b.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  let sTR = sum(tr.slice(0, period));
  let sPlus = sum(plusDM.slice(0, period));
  let sMinus = sum(minusDM.slice(0, period));
  const dxs: number[] = [];
  const pushDx = (): void => {
    if (sTR === 0) { dxs.push(0); return; }
    const pdi = (100 * sPlus) / sTR;
    const mdi = (100 * sMinus) / sTR;
    const denom = pdi + mdi;
    dxs.push(denom === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / denom);
  };
  pushDx();
  for (let i = period; i < tr.length; i += 1) {
    sTR = sTR - sTR / period + (tr[i] as number);
    sPlus = sPlus - sPlus / period + (plusDM[i] as number);
    sMinus = sMinus - sMinus / period + (minusDM[i] as number);
    pushDx();
  }
  if (dxs.length < period) return null;
  let a = sum(dxs.slice(0, period)) / period;
  for (let i = period; i < dxs.length; i += 1) a = (a * (period - 1) + (dxs[i] as number)) / period;
  return clamp(a, 0, 100);
}

/** t-statistic of the OLS slope of log price over the last `period` bars. */
/**
 * Trend t-statistic over `period` bars: the t-test of the mean log return against zero
 * (mean / (sd / sqrt(n))). A regression of price levels on time is not used: levels are
 * autocorrelated, so such a t-stat is inflated several-fold and says little about whether the
 * drift is real. Positive when the window's average return is significantly above zero.
 */
export function trendTStat(values: readonly number[], period: number): number | null {
  if (values.length < period || period < 3) return null;
  const window = values.slice(values.length - period);
  if (window.some((v) => v <= 0)) return null;
  const rets: number[] = [];
  for (let i = 1; i < window.length; i += 1) rets.push(Math.log((window[i] as number) / (window[i - 1] as number)));
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (const r of rets) ss += (r - mean) * (r - mean);
  const sd = Math.sqrt(ss / (n - 1));
  if (!(sd > 0)) return null;
  return mean / (sd / Math.sqrt(n));
}

/** OLS slope of log price over `period` bars, expressed as total log change over the window. */
export function trendSlope(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  const window = values.slice(values.length - period);
  if (window.some((v) => v <= 0)) return null;
  const reg = linearRegression(window.map((v) => Math.log(v)));
  return reg ? reg.slope * (period - 1) : null;
}

/** Z-score of the last close against the mean/std of the last `period` closes. */
export function meanReversionZ(values: readonly number[], period: number): number | null {
  return bollingerZ(values, period);
}

/** Maximum drawdown (as a positive fraction) over the last `period` closes. */
export function maxDrawdown(values: readonly number[], period: number): number | null {
  if (values.length < 2) return null;
  const window = values.slice(Math.max(0, values.length - period));
  let peak = -Infinity;
  let mdd = 0;
  for (const v of window) {
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.max(mdd, 1 - v / peak);
  }
  return mdd;
}

export function averageDollarVolume(bars: readonly Bar[], period = 20): number | null {
  if (bars.length < period) return null;
  const w = bars.slice(bars.length - period);
  return sum(w.map((b) => b.close * b.volume)) / period;
}

export function spreadBpsFromQuote(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 10_000;
}

/**
 * Liquidity score in [0, 1] from average dollar volume and spread. ADV maps log-linearly from
 * $1M (0) to $1B (1); spread penalises linearly from 0 bps (1) to 50 bps (0). Missing spread
 * counts as neutral 0.7.
 */
export function liquidityScore(adv: number | null, spreadBps: number | null): number | null {
  if (adv === null || adv <= 0) return null;
  const advScore = clamp((Math.log10(adv) - 6) / 3, 0, 1);
  const spreadScore = spreadBps === null ? 0.7 : clamp(1 - spreadBps / 50, 0, 1);
  return clamp(0.6 * advScore + 0.4 * spreadScore, 0, 1);
}

/** Percentile ranks (0..1) of each symbol's value; null values are excluded. */
export function crossSectionalRank(entries: readonly { symbol: string; value: number | null }[]): Record<string, number> {
  const valid = entries.filter((e): e is { symbol: string; value: number } => e.value !== null && Number.isFinite(e.value));
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const out: Record<string, number> = {};
  const n = sorted.length;
  if (n === 0) return out;
  if (n === 1) { out[(sorted[0] as { symbol: string }).symbol] = 0.5; return out; }
  for (let i = 0; i < n; i += 1) {
    out[(sorted[i] as { symbol: string }).symbol] = i / (n - 1);
  }
  return out;
}
