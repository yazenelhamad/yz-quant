/**
 * Small numeric helpers shared by the learning engine. All functions are pure and
 * return `null` (never NaN) when a quantity is undefined for the given input.
 */

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (lo > hi) [lo, hi] = [hi, lo];
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

/** Sample standard deviation (n-1). Null when fewer than two points. */
export function stddev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Aligns two series on their tails (the last `min(length)` points). */
export function alignTail(a: readonly number[], b: readonly number[]): [number[], number[]] {
  const n = Math.min(a.length, b.length);
  return [a.slice(a.length - n), b.slice(b.length - n)];
}

/** Pearson correlation. Null when fewer than 3 points or either series is constant. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const [x, y] = alignTail(a, b);
  if (x.length < 3) return null;
  const mx = mean(x) as number;
  const my = mean(y) as number;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return clamp(sxy / Math.sqrt(sxx * syy), -1, 1);
}

/** Average ranks (ties share the mean rank), 1-based. */
export function rank(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const ranks = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as { v: number }).v === (idx[i] as { v: number }).v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[(idx[k] as { i: number }).i] = r;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation (information coefficient). */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  const [x, y] = alignTail(a, b);
  if (x.length < 3) return null;
  return pearson(rank(x), rank(y));
}

/** Cosine similarity in [-1, 1]; 0 when either vector has zero norm. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return clamp(dot / Math.sqrt(na * nb), -1, 1);
}

/** Ordinary least squares y = a + b x. Null when x is constant or < 2 points. */
export function linearFit(x: readonly number[], y: readonly number[]): { intercept: number; slope: number } | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = mean(x.slice(0, n)) as number;
  const my = mean(y.slice(0, n)) as number;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((x[i] as number) - mx) * ((y[i] as number) - my);
    sxx += ((x[i] as number) - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Days between two ISO timestamps (b - a). Null when either is unparseable. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return (tb - ta) / 86_400_000;
}

export function safeRatio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0 || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return num / den;
}

export function pct(x: number | null, digits = 2): string {
  return x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = keyOf(item);
    if (k === null) continue;
    (out[k] ??= []).push(item);
  }
  return out;
}
