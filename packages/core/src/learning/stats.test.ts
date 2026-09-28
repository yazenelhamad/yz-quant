import { describe, expect, it } from "vitest";
import { computePerformanceStats, EMPTY_STATS, maxDrawdownPct, toObservations } from "./stats.js";
import { makeMemory } from "./testFixtures.js";

describe("computePerformanceStats", () => {
  it("returns nulls (never NaN) for an empty set", () => {
    const s = computePerformanceStats([]);
    expect(s).toEqual({ ...EMPTY_STATS });
    for (const v of Object.values(s)) expect(Number.isNaN(v as number)).toBe(false);
  });

  it("computes win rate, profit factor, expectancy and averages", () => {
    const s = computePerformanceStats([
      { returnPct: 4, holdingDays: 2 },
      { returnPct: -2, holdingDays: 4 },
      { returnPct: 2, holdingDays: 6 },
      { returnPct: -1, holdingDays: 4 },
    ]);
    expect(s.trades).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.profitFactor).toBeCloseTo(6 / 3);
    expect(s.expectancyPct).toBeCloseTo(0.75);
    expect(s.avgWinPct).toBeCloseTo(3);
    expect(s.avgLossPct).toBeCloseTo(-1.5);
    expect(s.avgHoldingDays).toBeCloseTo(4);
    expect(s.netReturnPct).toBeCloseTo((1.04 * 0.98 * 1.02 * 0.99 - 1) * 100);
  });

  it("annualises Sharpe by holding period and keeps Sortino null when there is no downside", () => {
    const flatUp = computePerformanceStats([{ returnPct: 1, holdingDays: 1 }, { returnPct: 2, holdingDays: 1 }, { returnPct: 3, holdingDays: 1 }]);
    expect(flatUp.sharpe).toBeCloseTo((2 / 1) * Math.sqrt(252));
    expect(flatUp.sortino).toBeNull();
    const longHold = computePerformanceStats([{ returnPct: 1, holdingDays: 21 }, { returnPct: 2, holdingDays: 21 }, { returnPct: 3, holdingDays: 21 }]);
    expect(longHold.sharpe).toBeCloseTo((2 / 1) * Math.sqrt(12));
    const withDownside = computePerformanceStats([{ returnPct: -3 }, { returnPct: 3 }, { returnPct: 3 }]);
    expect(withDownside.sortino).not.toBeNull();
    expect(withDownside.sortino as number).toBeGreaterThan(0);
  });

  it("returns a null Sharpe for constant returns and a null profit factor without losses", () => {
    const s = computePerformanceStats([{ returnPct: 1 }, { returnPct: 1 }]);
    expect(s.sharpe).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.maxDrawdownPct).toBe(0);
  });

  it("computes max drawdown from the compounded path", () => {
    expect(maxDrawdownPct([10, -10, -10, 20])).toBeCloseTo(19);
    expect(maxDrawdownPct([])).toBeNull();
    expect(maxDrawdownPct([1, 2, 3])).toBe(0);
  });

  it("accepts memory entries and ignores open trades", () => {
    const entries = [makeMemory({ actualReturnPct: 5, slippageBps: 6 }), makeMemory({ tradeId: "t2", actualReturnPct: null, exitPrice: null }), makeMemory({ tradeId: "t3", actualReturnPct: -1, slippageBps: 2 })];
    expect(toObservations(entries)).toHaveLength(2);
    const s = computePerformanceStats(entries);
    expect(s.trades).toBe(2);
    expect(s.avgSlippageBps).toBeCloseTo(4);
    expect(s.avgHoldingDays).toBeCloseTo(8);
  });
});
