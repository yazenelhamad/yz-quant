import type { IsoTimestamp } from "../types/index.js";
import { shiftDateKey, zonedParts } from "./time.js";

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Pearson correlation of two equally sized return series. Null when undefined (too short, zero variance). */
export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i];
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    sumA += x; sumB += y;
  }
  const meanA = sumA / n; const meanB = sumB / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const dx = (a[i] as number) - meanA; const dy = (b[i] as number) - meanB;
    cov += dx * dy; varA += dx * dx; varB += dy * dy;
  }
  if (varA === 0 || varB === 0) return null;
  return clamp(cov / Math.sqrt(varA * varB), -1, 1);
}

export type CorrelationMatrix = Record<string, Record<string, number>>;

/** Symmetric pairwise Pearson matrix over named return series. Missing pairs are omitted (not fabricated). */
export function computeCorrelationMatrix(series: Record<string, readonly number[]>): CorrelationMatrix {
  const keys = Object.keys(series);
  const out: CorrelationMatrix = {};
  for (const k of keys) out[k] = { [k]: 1 };
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const ki = keys[i] as string; const kj = keys[j] as string;
      const r = pearsonCorrelation(series[ki] as readonly number[], series[kj] as readonly number[]);
      if (r !== null) {
        (out[ki] as Record<string, number>)[kj] = r;
        (out[kj] as Record<string, number>)[ki] = r;
      }
    }
  }
  return out;
}

export function lookupCorrelation(matrix: CorrelationMatrix | null | undefined, a: string, b: string): number | null {
  if (!matrix) return null;
  if (a === b) return 1;
  const v = matrix[a]?.[b] ?? matrix[b]?.[a];
  return isFiniteNumber(v) ? v : null;
}

/** Average of the off-diagonal correlations weighted equally. Null when no pair is known. */
export function averagePairwiseCorrelation(symbols: readonly string[], matrix: CorrelationMatrix | null | undefined): number | null {
  let sum = 0; let count = 0;
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const r = lookupCorrelation(matrix, symbols[i] as string, symbols[j] as string);
      if (r !== null) { sum += r; count++; }
    }
  }
  return count === 0 ? null : sum / count;
}

export interface BetaPosition { beta: number | null; marketValue: number | null }

/**
 * Beta-weighted exposure as a fraction of `totalValue` (sum(beta_i * mv_i) / totalValue).
 * Returns null when any position lacks a beta or a market value (never assumes).
 */
export function portfolioBeta(positions: readonly BetaPosition[], totalValue: number): number | null {
  if (!isFiniteNumber(totalValue) || totalValue <= 0) return null;
  let sum = 0;
  for (const p of positions) {
    if (!isFiniteNumber(p.beta) || !isFiniteNumber(p.marketValue)) return null;
    sum += p.beta * p.marketValue;
  }
  return sum / totalValue;
}

/** Herfindahl-Hirschman index over absolute weights (0..1; 1 = single position). 0 when empty. */
export function herfindahl(values: readonly number[]): number {
  const total = values.reduce((s, v) => s + Math.abs(v), 0);
  if (total <= 0) return 0;
  return values.reduce((s, v) => s + (Math.abs(v) / total) ** 2, 0);
}

export interface ValuePoint { asOf: IsoTimestamp; totalValue: number }

export interface DrawdownResult {
  peakValue: number | null;
  currentValue: number | null;
  /** Positive fraction, e.g. 0.08 = 8% below peak. */
  currentDrawdownPct: number | null;
  maxDrawdownPct: number | null;
  points: number;
}

/** Drawdown statistics over an equity curve (numbers or {asOf,totalValue} in chronological order). */
export function computeDrawdown(history: readonly (number | ValuePoint)[]): DrawdownResult {
  const values = history
    .map((h) => (typeof h === "number" ? h : h.totalValue))
    .filter((v): v is number => isFiniteNumber(v));
  if (values.length === 0) return { peakValue: null, currentValue: null, currentDrawdownPct: null, maxDrawdownPct: null, points: 0 };
  let peak = -Infinity; let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  const current = values[values.length - 1] as number;
  const currentDd = peak > 0 ? Math.max(0, (peak - current) / peak) : null;
  return { peakValue: peak, currentValue: current, currentDrawdownPct: currentDd, maxDrawdownPct: maxDd, points: values.length };
}

export interface PeriodPnl {
  baselineAt: IsoTimestamp;
  baselineValue: number;
  currentAt: IsoTimestamp;
  currentValue: number;
  pnl: number;
  /** Signed fraction of the baseline value. */
  pnlPct: number;
}

function sortedSnapshots(snapshots: readonly ValuePoint[]): ValuePoint[] {
  return snapshots
    .filter((s) => isFiniteNumber(s.totalValue) && Number.isFinite(Date.parse(s.asOf)))
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
}

function periodPnl(snapshots: readonly ValuePoint[], now: IsoTimestamp, periodStartKey: string, timeZone: string): PeriodPnl | null {
  const sorted = sortedSnapshots(snapshots);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  let baseline: ValuePoint | null = null;
  let current: ValuePoint | null = null;
  for (const s of sorted) {
    const ms = Date.parse(s.asOf);
    if (ms > nowMs) break;
    const key = zonedParts(s.asOf, timeZone)?.dateKey;
    if (key === undefined) return null;
    if (key < periodStartKey) baseline = s;
    current = s;
  }
  if (!baseline || !current || baseline.totalValue <= 0) return null;
  const pnl = current.totalValue - baseline.totalValue;
  return {
    baselineAt: baseline.asOf,
    baselineValue: baseline.totalValue,
    currentAt: current.asOf,
    currentValue: current.totalValue,
    pnl,
    pnlPct: pnl / baseline.totalValue,
  };
}

/**
 * Daily P&L: change from the last snapshot taken on a previous calendar day (in `timeZone`)
 * to the latest snapshot at or before `now`. Null when the baseline is unavailable.
 */
export function computeDailyPnl(snapshots: readonly ValuePoint[], now: IsoTimestamp, timeZone = "America/New_York"): PeriodPnl | null {
  const today = zonedParts(now, timeZone);
  if (!today) return null;
  return periodPnl(snapshots, now, today.dateKey, timeZone);
}

/** Weekly P&L: baseline is the last snapshot before Monday of the current week (in `timeZone`). */
export function computeWeeklyPnl(snapshots: readonly ValuePoint[], now: IsoTimestamp, timeZone = "America/New_York"): PeriodPnl | null {
  const today = zonedParts(now, timeZone);
  if (!today) return null;
  const daysSinceMonday = (today.weekday + 6) % 7;
  const weekStart = shiftDateKey(today.dateKey, -daysSinceMonday);
  return periodPnl(snapshots, now, weekStart, timeZone);
}
