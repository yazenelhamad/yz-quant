import { describe, expect, it } from "vitest";
import type { BacktestTrade, EquityPoint } from "../types/index.js";
import { computeMetrics, maxDrawdown, percentile, sharpeRatio, sortinoRatio, stdev } from "./metrics.js";

function curve(equity: number[]): EquityPoint[] {
  let peak = -Infinity;
  return equity.map((e, i) => {
    peak = Math.max(peak, e);
    return { time: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, equity: e, drawdownPct: ((peak - e) / peak) * 100, exposure: 0.5 };
  });
}

function trade(netPnl: number, returnPct: number, regime = "bull_trend", costs = 0): BacktestTrade {
  return {
    symbol: "AAA",
    entryTime: "2024-01-01T00:00:00.000Z",
    exitTime: "2024-01-05T00:00:00.000Z",
    entryPrice: 100,
    exitPrice: 100 + returnPct,
    quantity: 10,
    side: "long",
    grossPnl: netPnl + costs,
    costs,
    netPnl,
    returnPct,
    holdingBars: 4,
    regime,
    confidence: 0.8,
    maePct: -1,
    mfePct: 2,
    exitReason: "exit",
  };
}

describe("computeMetrics", () => {
  it("returns nulls (never NaN) on empty inputs", () => {
    const m = computeMetrics([], [], 252);
    expect(m.sharpe).toBeNull();
    expect(m.cagr).toBeNull();
    expect(m.winRate).toBeNull();
    expect(m.profitFactor).toBeNull();
    expect(m.var95Pct).toBeNull();
    expect(m.tradeCount).toBe(0);
    for (const v of Object.values(m)) if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
  });

  it("single equity point yields no ratios but a valid total return", () => {
    const m = computeMetrics(curve([100]), [], 252);
    expect(m.totalReturnPct).toBe(0);
    expect(m.sharpe).toBeNull();
    expect(m.annualizedVolatility).toBeNull();
    expect(m.maxDrawdownPct).toBe(0);
  });

  it("matches the Sharpe formula on an alternating known series", () => {
    // Returns alternate +2%, +0%: mean 1%, sample stdev computed explicitly.
    const equity = [100];
    for (let i = 0; i < 20; i++) equity.push((equity[equity.length - 1] as number) * (i % 2 === 0 ? 1.02 : 1.0));
    const rets = equity.slice(1).map((e, i) => e / (equity[i] as number) - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    const expected = (mean / sd) * Math.sqrt(252);
    const m = computeMetrics(curve(equity), [], 252);
    expect(m.sharpe).toBeCloseTo(expected, 10);
    expect(m.annualizedVolatility).toBeCloseTo(sd * Math.sqrt(252) * 100, 10);
    expect(m.totalReturnPct).toBeCloseTo(((equity[20] as number) / 100 - 1) * 100, 10);
    // 20 periods = 20/252 years.
    expect(m.cagr).toBeCloseTo((Math.pow((equity[20] as number) / 100, 252 / 20) - 1) * 100, 8);
    expect(m.maxDrawdownPct).toBe(0);
    // No negative returns: Sortino undefined.
    expect(m.sortino).toBeNull();
  });

  it("constant returns give zero variance and a null Sharpe rather than Infinity", () => {
    const equity = [100, 101, 102.01, 103.0301];
    expect(sharpeRatio([0.01, 0.01, 0.01], 252)).toBeNull();
    expect(computeMetrics(curve(equity), [], 252).sharpe).toBeNull();
  });

  it("computes drawdown depth and duration", () => {
    const dd = maxDrawdown([100, 110, 99, 105, 120, 90, 100, 130]);
    expect(dd.maxDrawdown).toBeCloseTo(0.25);
    expect(dd.maxDurationBars).toBe(2);
    const m = computeMetrics(curve([100, 110, 99, 105, 120, 90, 100, 130]), [], 252);
    expect(m.maxDrawdownPct).toBeCloseTo(25);
    expect(m.maxDrawdownDurationBars).toBe(2);
    expect(m.calmar).not.toBeNull();
  });

  it("computes trade statistics, profit factor and regime attribution", () => {
    const trades = [trade(100, 10), trade(-50, -5), trade(30, 3, "bear_trend"), trade(-20, -2, "bear_trend")];
    const m = computeMetrics(curve([1000, 1100, 1050, 1080, 1060]), trades, 252);
    expect(m.tradeCount).toBe(4);
    expect(m.winRate).toBeCloseTo(0.5);
    expect(m.profitFactor).toBeCloseTo(130 / 70);
    expect(m.expectancyPct).toBeCloseTo(1.5);
    expect(m.avgWinPct).toBeCloseTo(6.5);
    expect(m.avgLossPct).toBeCloseTo(-3.5);
    expect(m.byRegime.bull_trend).toEqual({ trades: 2, returnPct: 5, winRate: 0.5 });
    expect(m.byRegime.bear_trend).toEqual({ trades: 2, returnPct: 1, winRate: 0.5 });
    expect(m.exposure).toBeCloseTo(0.5);
    expect(m.turnover).toBeGreaterThan(0);
  });

  it("open trades are excluded from trade stats but counted in costs", () => {
    const open: BacktestTrade = { ...trade(5, 1, "bull_trend", 2), exitTime: null, exitPrice: null, exitReason: "open" };
    const m = computeMetrics(curve([100, 101]), [open], 252);
    expect(m.tradeCount).toBe(0);
    expect(m.winRate).toBeNull();
    expect(m.totalCosts).toBe(2);
  });

  it("separates gross and net returns by total costs", () => {
    const m = computeMetrics(curve([1000, 1010, 1020]), [], 252, { totalCosts: 10 });
    expect(m.netReturnPct).toBeCloseTo(2);
    expect(m.grossReturnPct).toBeCloseTo(3);
  });

  it("historical VaR/CVaR are the tail of per-period returns", () => {
    const rets = [-0.05, -0.03, -0.01, 0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
    const equity = [100];
    for (const r of rets) equity.push((equity[equity.length - 1] as number) * (1 + r));
    const m = computeMetrics(curve(equity), [], 252);
    const var95 = percentile(rets, 0.05) as number;
    expect(m.var95Pct).toBeCloseTo(var95 * 100, 8);
    expect(m.cvar95Pct as number).toBeLessThanOrEqual(m.var95Pct as number);
  });

  it("helper functions handle degenerate inputs", () => {
    expect(stdev([1])).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
    expect(sortinoRatio([0.01], 252)).toBeNull();
    expect(sharpeRatio([], 252)).toBeNull();
  });
});
