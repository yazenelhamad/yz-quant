/**
 * Small numeric helpers shared by the variant perception engine.
 * Pure, null-safe, no I/O. Every function returns null (never NaN) when inputs are unusable.
 */

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function round(v: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Keep only finite numbers. */
export function finiteValues(values: readonly (number | null | undefined)[] | null | undefined): number[] {
  if (!values) return [];
  return values.filter(isNum);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sample standard deviation (n-1). Null when fewer than 2 values. */
export function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let ss = 0;
  for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (values.length - 1));
}

export function minMax(values: readonly number[]): [number, number] | null {
  if (values.length === 0) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Percent difference of `a` relative to `|b|`. Null when either side is missing or b is zero. */
export function pctDiff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (!isNum(a) || !isNum(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

/** Weighted mean over entries whose value is a finite number; null when nothing usable. */
export function weightedMean(entries: readonly { value: number | null; weight: number }[]): number | null {
  let num = 0;
  let den = 0;
  for (const e of entries) {
    if (!isNum(e.value) || !isNum(e.weight) || e.weight <= 0) continue;
    num += e.value * e.weight;
    den += e.weight;
  }
  return den > 0 ? num / den : null;
}

/** Ordinary least squares y = intercept + slope * x. Null when fewer than `minPoints` points or x has no variance. */
export function leastSquares(points: readonly { x: number; y: number }[], minPoints = 2): { slope: number; intercept: number; r2: number; n: number } | null {
  const pts = points.filter((p) => isNum(p.x) && isNum(p.y));
  const n = pts.length;
  if (n < minPoints) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) * (p.y - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : clamp01((sxy * sxy) / (sxx * syy));
  return { slope, intercept, r2, n };
}

/** Truncate a string to `max` characters, collapsing whitespace. Never throws on non-strings. */
export function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (s.length <= max) return s;
  return max > 1 ? s.slice(0, max - 1) + "…" : s.slice(0, max);
}

export function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
