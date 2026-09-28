import type { PerformanceStats, TradeMemoryEntry } from "../types/index.js";
import { isFiniteNumber, mean, stddev } from "./math.js";

/**
 * Unit convention used throughout the learning engine: every `*Pct` value is in
 * percentage points (2.5 means +2.5%), slippage is in basis points and holding
 * periods are in calendar days.
 */
export interface ReturnObservation {
  returnPct: number;
  holdingDays?: number | null;
  slippageBps?: number | null;
}

export type StatsInput = TradeMemoryEntry | ReturnObservation;

export const TRADING_DAYS_PER_YEAR = 252;

export const EMPTY_STATS: Readonly<PerformanceStats> = Object.freeze({
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: null,
  profitFactor: null,
  expectancyPct: null,
  avgReturnPct: null,
  avgWinPct: null,
  avgLossPct: null,
  sharpe: null,
  sortino: null,
  maxDrawdownPct: null,
  avgHoldingDays: null,
  avgSlippageBps: null,
  netReturnPct: null,
});

function isMemoryEntry(x: StatsInput): x is TradeMemoryEntry {
  return "actualReturnPct" in x;
}

/** Normalises inputs; open trades (null return) are ignored. */
export function toObservations(entries: readonly StatsInput[]): ReturnObservation[] {
  const out: ReturnObservation[] = [];
  for (const e of entries) {
    if (isMemoryEntry(e)) {
      if (isFiniteNumber(e.actualReturnPct)) {
        out.push({ returnPct: e.actualReturnPct, holdingDays: e.holdingDays, slippageBps: e.slippageBps });
      }
    } else if (isFiniteNumber(e.returnPct)) {
      out.push(e);
    }
  }
  return out;
}

/** Maximum peak-to-trough decline (in %) of the compounded return path. */
export function maxDrawdownPct(returnsPct: readonly number[]): number | null {
  if (returnsPct.length === 0) return null;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returnsPct) {
    equity *= 1 + r / 100;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

export function computePerformanceStats(entries: readonly StatsInput[]): PerformanceStats {
  const obs = toObservations(entries);
  if (obs.length === 0) return { ...EMPTY_STATS };

  const returns = obs.map((o) => o.returnPct);
  const winsArr = returns.filter((r) => r > 0);
  const lossArr = returns.filter((r) => r < 0);
  const grossWin = winsArr.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossArr.reduce((a, b) => a + b, 0));
  const avg = mean(returns) as number;
  const sd = stddev(returns);

  const holdings = obs.map((o) => o.holdingDays).filter(isFiniteNumber);
  const slippages = obs.map((o) => o.slippageBps).filter(isFiniteNumber);
  const avgHolding = mean(holdings);
  // Annualise per-trade returns by the average holding period. Holding periods shorter than
  // one trading day are treated as one day, which is deliberately conservative.
  const periodsPerYear = TRADING_DAYS_PER_YEAR / Math.max(avgHolding ?? 1, 1);

  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (returns.length >= 2 && sd !== null && sd > 0) {
    sharpe = (avg / sd) * Math.sqrt(periodsPerYear);
  }
  if (returns.length >= 2) {
    const downside = Math.sqrt(returns.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / returns.length);
    if (downside > 0) sortino = (avg / downside) * Math.sqrt(periodsPerYear);
  }

  const net = (returns.reduce((eq, r) => eq * (1 + r / 100), 1) - 1) * 100;

  return {
    trades: obs.length,
    wins: winsArr.length,
    losses: lossArr.length,
    winRate: winsArr.length / obs.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyPct: avg,
    avgReturnPct: avg,
    avgWinPct: mean(winsArr),
    avgLossPct: mean(lossArr),
    sharpe,
    sortino,
    maxDrawdownPct: maxDrawdownPct(returns),
    avgHoldingDays: avgHolding,
    avgSlippageBps: mean(slippages),
    netReturnPct: net,
  };
}
