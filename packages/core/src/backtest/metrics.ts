/**
 * Performance metrics over an equity curve and a trade list.
 *
 * Every ratio that is undefined for the input (no trades, zero variance, empty curve) is
 * returned as `null`, never `NaN` or `Infinity`, so results can be serialised and compared.
 */
import type { BacktestMetrics, BacktestTrade, EquityPoint } from "../types/index.js";

export interface MetricsOptions {
  /** Total explicit costs (commissions, spread, impact). Defaults to the sum of trade costs. */
  totalCosts?: number;
  /** Starting equity; defaults to the first equity point. */
  initialCapital?: number;
}

export function meanOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). Null when fewer than 2 observations. */
export function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = meanOf(xs) as number;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Linear-interpolated percentile (p in [0, 1]) of a sample. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const pos = Math.min(sorted.length - 1, Math.max(0, p * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

function finite(x: number | null): number | null {
  return x === null || !Number.isFinite(x) ? null : x;
}

/** Simple per-period returns of an equity series. */
export function periodReturns(equity: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1] as number;
    const cur = equity[i] as number;
    out.push(prev > 0 ? cur / prev - 1 : 0);
  }
  return out;
}

/** Max drawdown (fraction, >= 0) and its longest duration in bars (peak to recovery or end). */
export function equityMaxDrawdown(equity: readonly number[]): { maxDrawdown: number; maxDurationBars: number } {
  let peak = -Infinity;
  let maxDd = 0;
  let maxDur = 0;
  let sincePeak = 0;
  for (const e of equity) {
    if (e >= peak) {
      peak = e;
      sincePeak = 0;
    } else {
      sincePeak++;
      const dd = peak > 0 ? (peak - e) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }
    if (sincePeak > maxDur) maxDur = sincePeak;
  }
  return { maxDrawdown: maxDd, maxDurationBars: maxDur };
}

export function sharpeRatio(returns: readonly number[], periodsPerYear: number): number | null {
  const m = meanOf(returns);
  const sd = stdev(returns);
  if (m === null || sd === null || sd === 0) return null;
  return finite((m / sd) * Math.sqrt(periodsPerYear));
}

export function sortinoRatio(returns: readonly number[], periodsPerYear: number): number | null {
  const m = meanOf(returns);
  if (m === null || returns.length < 2) return null;
  let s = 0;
  for (const r of returns) if (r < 0) s += r * r;
  const downside = Math.sqrt(s / (returns.length - 1));
  if (downside === 0) return null;
  return finite((m / downside) * Math.sqrt(periodsPerYear));
}

export function byRegimeAttribution(trades: readonly BacktestTrade[]): BacktestMetrics["byRegime"] {
  const out: BacktestMetrics["byRegime"] = {};
  const groups = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    if (t.exitTime === null) continue;
    const list = groups.get(t.regime) ?? [];
    list.push(t);
    groups.set(t.regime, list);
  }
  for (const [regime, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wins = list.filter((t) => t.netPnl > 0).length;
    out[regime] = {
      trades: list.length,
      returnPct: list.reduce((s, t) => s + t.returnPct, 0),
      winRate: list.length > 0 ? wins / list.length : null,
    };
  }
  return out;
}

export function emptyMetrics(): BacktestMetrics {
  return {
    cagr: null,
    totalReturnPct: 0,
    annualizedVolatility: null,
    sharpe: null,
    sortino: null,
    calmar: null,
    maxDrawdownPct: 0,
    maxDrawdownDurationBars: 0,
    winRate: null,
    profitFactor: null,
    expectancyPct: null,
    avgWinPct: null,
    avgLossPct: null,
    turnover: 0,
    exposure: 0,
    var95Pct: null,
    cvar95Pct: null,
    tradeCount: 0,
    grossReturnPct: 0,
    totalCosts: 0,
    netReturnPct: 0,
    byRegime: {},
  };
}

/**
 * Computes the full metric set. `periodsPerYear` is 252 for daily bars.
 * Percent fields are in percent units (1.5 means 1.5%).
 */
export function computeMetrics(
  equityCurve: readonly EquityPoint[],
  trades: readonly BacktestTrade[],
  periodsPerYear: number,
  options: MetricsOptions = {},
): BacktestMetrics {
  const closed = trades.filter((t) => t.exitTime !== null);
  const totalCosts = options.totalCosts ?? trades.reduce((s, t) => s + t.costs, 0);
  if (equityCurve.length === 0) {
    const m = emptyMetrics();
    m.tradeCount = closed.length;
    m.totalCosts = totalCosts;
    m.byRegime = byRegimeAttribution(trades);
    Object.assign(m, tradeStats(closed));
    return m;
  }

  const equity = equityCurve.map((p) => p.equity);
  const initial = options.initialCapital ?? (equity[0] as number);
  const final = equity[equity.length - 1] as number;
  const netReturn = initial > 0 ? final / initial - 1 : 0;
  const grossReturn = initial > 0 ? netReturn + totalCosts / initial : 0;
  const returns = periodReturns(equity);
  const periods = returns.length;
  const years = periods / periodsPerYear;
  const cagr = years > 0 && initial > 0 && final > 0 ? Math.pow(final / initial, 1 / years) - 1 : null;
  const sd = stdev(returns);
  const annVol = sd === null ? null : sd * Math.sqrt(periodsPerYear);
  const dd = equityMaxDrawdown(equity);
  const calmar = cagr !== null && dd.maxDrawdown > 0 ? cagr / dd.maxDrawdown : null;
  const var95 = percentile(returns, 0.05);
  const tail = var95 === null ? [] : returns.filter((r) => r <= var95);
  const cvar95 = tail.length > 0 ? (meanOf(tail) as number) : null;
  const exposure = meanOf(equityCurve.map((p) => p.exposure)) ?? 0;
  const avgEquity = meanOf(equity) ?? initial;
  const notional = trades.reduce((s, t) => s + t.quantity * (t.entryPrice + (t.exitPrice ?? 0)), 0);
  const turnover = avgEquity > 0 && years > 0 ? notional / avgEquity / years : 0;

  return {
    cagr: finite(cagr === null ? null : cagr * 100),
    totalReturnPct: netReturn * 100,
    annualizedVolatility: finite(annVol === null ? null : annVol * 100),
    sharpe: sharpeRatio(returns, periodsPerYear),
    sortino: sortinoRatio(returns, periodsPerYear),
    calmar: finite(calmar),
    maxDrawdownPct: dd.maxDrawdown * 100,
    maxDrawdownDurationBars: dd.maxDurationBars,
    ...tradeStats(closed),
    turnover: finite(turnover) ?? 0,
    exposure,
    var95Pct: finite(var95 === null ? null : var95 * 100),
    cvar95Pct: finite(cvar95 === null ? null : cvar95 * 100),
    tradeCount: closed.length,
    grossReturnPct: grossReturn * 100,
    totalCosts,
    netReturnPct: netReturn * 100,
    byRegime: byRegimeAttribution(trades),
  };
}

function tradeStats(closed: readonly BacktestTrade[]): Pick<BacktestMetrics, "winRate" | "profitFactor" | "expectancyPct" | "avgWinPct" | "avgLossPct"> {
  if (closed.length === 0) return { winRate: null, profitFactor: null, expectancyPct: null, avgWinPct: null, avgLossPct: null };
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  return {
    winRate: wins.length / closed.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? null : 0,
    expectancyPct: meanOf(closed.map((t) => t.returnPct)),
    avgWinPct: meanOf(wins.map((t) => t.returnPct)),
    avgLossPct: meanOf(losses.map((t) => t.returnPct)),
  };
}
