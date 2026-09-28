/**
 * Small, dependency-free numeric helpers shared by the feature engine, the regime engine
 * and the strategy library. All functions are pure and return `null` when there is not
 * enough data instead of producing NaN.
 */

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function round(x: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return sum(xs) / xs.length;
}

/** Sample standard deviation (n-1). Null when fewer than two points. */
export function stddev(xs: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = sum(xs) / n;
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (n - 1));
}

export function last<T>(xs: readonly T[]): T | undefined {
  return xs.length > 0 ? xs[xs.length - 1] : undefined;
}

export function tail<T>(xs: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  return xs.length <= n ? [...xs] : xs.slice(xs.length - n);
}

/** Percentile rank of `value` within `history` in [0, 1]. Null when history is empty. */
export function percentileRank(history: readonly number[], value: number): number | null {
  if (history.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const h of history) {
    if (h < value) below += 1;
    else if (h === value) equal += 1;
  }
  return (below + 0.5 * equal) / history.length;
}

/** Z-score of `value` against `history` (sample std). Null when std is 0 or history too short. */
export function zScore(history: readonly number[], value: number): number | null {
  const m = mean(history);
  const sd = stddev(history);
  if (m === null || sd === null || sd === 0) return null;
  return (value - m) / sd;
}

export interface LinearRegression {
  slope: number;
  intercept: number;
  /** t-statistic of the slope (slope / standard error). */
  tStat: number;
  r2: number;
}

/** Ordinary least squares of y on x = 0..n-1. Null when fewer than three points or degenerate. */
export function linearRegression(ys: readonly number[]): LinearRegression | null {
  const n = ys.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  let yMean = 0;
  for (const y of ys) yMean += y;
  yMean /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    sxx += dx * dx;
    sxy += dx * ((ys[i] as number) - yMean);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i += 1) {
    const y = ys[i] as number;
    const fit = intercept + slope * i;
    sse += (y - fit) * (y - fit);
    sst += (y - yMean) * (y - yMean);
  }
  const dof = n - 2;
  const se = dof > 0 && sxx > 0 ? Math.sqrt(sse / dof / sxx) : 0;
  const tStat = se === 0 ? (slope === 0 ? 0 : Math.sign(slope) * 1e6) : slope / se;
  const r2 = sst === 0 ? 1 : 1 - sse / sst;
  return { slope, intercept, tStat: clamp(tStat, -1e6, 1e6), r2 };
}

/** Pearson correlation. Null when fewer than three pairs or zero variance. */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const aa = a.slice(a.length - n);
  const bb = b.slice(b.length - n);
  const ma = sum(aa) / n;
  const mb = sum(bb) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (aa[i] as number) - ma;
    const db = (bb[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

/** OLS beta of `asset` returns on `benchmark` returns. Null when too short or benchmark has no variance. */
export function beta(asset: readonly number[], benchmark: readonly number[]): number | null {
  const n = Math.min(asset.length, benchmark.length);
  if (n < 3) return null;
  const a = asset.slice(asset.length - n);
  const b = benchmark.slice(benchmark.length - n);
  const ma = sum(a) / n;
  const mb = sum(b) / n;
  let cov = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    vb += db * db;
  }
  if (vb === 0) return null;
  return cov / vb;
}

/** Lag-k autocorrelation of a series. */
export function autocorrelation(xs: readonly number[], lag = 1): number | null {
  if (xs.length < lag + 3) return null;
  return correlation(xs.slice(0, xs.length - lag), xs.slice(lag));
}

/**
 * Lo–MacKinlay variance ratio VR(q) = Var(q-period returns) / (q * Var(1-period returns)).
 * > 1 indicates persistence (momentum), < 1 indicates mean reversion. Null when too short.
 */
export function varianceRatio(returns: readonly number[], q: number): number | null {
  const n = returns.length;
  if (q < 2 || n < q * 4) return null;
  const v1 = variance(returns);
  if (v1 === null || v1 === 0) return null;
  const agg: number[] = [];
  for (let i = 0; i + q <= n; i += q) {
    let s = 0;
    for (let j = i; j < i + q; j += 1) s += returns[j] as number;
    agg.push(s);
  }
  const vq = variance(agg);
  if (vq === null) return null;
  return vq / (q * v1);
}

export function variance(xs: readonly number[]): number | null {
  const sd = stddev(xs);
  return sd === null ? null : sd * sd;
}

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Softmax with temperature; returns probabilities that sum to 1 (uniform when all scores are -Infinity). */
export function softmax(scores: readonly number[], temperature = 1): number[] {
  const t = temperature > 0 ? temperature : 1;
  const max = Math.max(...scores);
  if (!Number.isFinite(max)) return scores.map(() => 1 / scores.length);
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const total = sum(exps);
  return exps.map((e) => e / total);
}

export function sign(x: number): -1 | 0 | 1 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function fmtSigned(x: number, decimals = 2): string {
  const r = x.toFixed(decimals);
  return x >= 0 ? `+${r}` : r;
}

export function pct(x: number, decimals = 1): string {
  return `${(x * 100).toFixed(decimals)}%`;
}
