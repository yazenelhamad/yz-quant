import { describe, expect, it } from "vitest";
import type { Bar } from "../types/index.js";
import { type BacktestDataset, LookaheadError } from "./data.js";
import { defaultSizer, impactBps, runBacktest, simulateFill, stableStringify } from "./engine.js";
import { generateSyntheticDataset, syntheticCalendar } from "./synthetic.js";
import { barsFromCloses, buyAndHold, makeConfig, makeStrategy, recording, REALISTIC_COSTS, scripted, stubDeps, view, ZERO_COSTS } from "./test-helpers.js";

const T = syntheticCalendar("2024-01-01T00:00:00.000Z", 12);

function simpleDataset(closes: Record<string, number[]>, volume = 1_000_000): BacktestDataset {
  const symbols = Object.keys(closes);
  const bars: Record<string, Bar[]> = {};
  for (const s of symbols) bars[s] = barsFromCloses(s, T.slice(0, (closes[s] as number[]).length), closes[s] as number[], volume);
  const benchmark = barsFromCloses("SPY", T, T.map((_, i) => 400 + i));
  return { symbols, bars, benchmark, corporateActions: [], delistings: {}, calendar: T };
}

const flat = Array.from({ length: 12 }, () => 100);

describe("look-ahead protection", () => {
  it("never hands the strategy a bar after asOf and always includes the asOf bar", () => {
    const dataset = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 40, seed: 5 });
    const rec = recording(buyAndHold);
    runBacktest(makeConfig(), dataset, rec.strategy, stubDeps);
    expect(rec.contexts.length).toBeGreaterThan(0);
    for (const ctx of rec.contexts) {
      const last = ctx.bars[ctx.bars.length - 1] as Bar;
      expect(last.time).toBe(ctx.asOf);
      for (const b of ctx.bars) expect(Date.parse(b.time)).toBeLessThanOrEqual(Date.parse(ctx.asOf));
      expect(ctx.quote?.last).toBe(last.close);
    }
  });

  it("catches a strategy that injects future bars into its context", () => {
    const dataset = simpleDataset({ AAA: flat });
    const cheat = makeStrategy((ctx) => {
      const future = (dataset.bars.AAA as Bar[])[ctx.bars.length];
      if (future) ctx.bars.push(future);
      return { signals: [], view: null };
    });
    expect(() => runBacktest(makeConfig(), dataset, cheat, stubDeps)).toThrow(LookaheadError);
  });

  it("regime assessment only sees benchmark bars at or before asOf", () => {
    const dataset = simpleDataset({ AAA: flat });
    const seen: string[] = [];
    const deps = {
      ...stubDeps,
      assessRegime(bench: Bar[], asOf: string) {
        for (const b of bench) expect(Date.parse(b.time)).toBeLessThanOrEqual(Date.parse(asOf));
        seen.push(asOf);
        return stubDeps.assessRegime(bench, asOf);
      },
    };
    runBacktest(makeConfig(), dataset, buyAndHold, deps);
    expect(seen).toEqual(T);
  });
});

describe("order execution", () => {
  it("fills a market entry at the next bar's open, never at the signal close", () => {
    const closes = [100, 100, 110, 120, 120, 120, 120, 120, 120, 120, 120, 120];
    const dataset = simpleDataset({ AAA: closes });
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const r = runBacktest(makeConfig(), dataset, strat, stubDeps);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0] as (typeof r.trades)[number];
    expect(t.entryTime).toBe(T[2]);
    // Open of bar 2 = previous close = 100 (not the 110 close of bar 2).
    expect(t.entryPrice).toBe(100);
  });

  it("delay of zero still fills no earlier than the next bar", () => {
    const dataset = simpleDataset({ AAA: flat });
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const r = runBacktest(makeConfig({ costModel: { ...ZERO_COSTS, executionDelayBars: 0 } }), dataset, strat, stubDeps);
    expect(r.trades[0]?.entryTime).toBe(T[2]);
  });

  it("honours executionDelayBars greater than one", () => {
    const dataset = simpleDataset({ AAA: flat });
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const r = runBacktest(makeConfig({ costModel: { ...ZERO_COSTS, executionDelayBars: 3 } }), dataset, strat, stubDeps);
    expect(r.trades[0]?.entryTime).toBe(T[4]);
  });

  it("limit entries fill only when the bar range crosses the limit", () => {
    // Signal on bar 1 (close 100, limit = 98). Bars 2-3 have low 99 (no fill); bar 4 closes at 97 (low 96.03) and fills at 98.
    const closes = [100, 100, 100, 100, 97, 97, 97, 97, 97, 97, 97, 97];
    const dataset = simpleDataset({ AAA: closes });
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const opts = { entryOrderType: "limit" as const, limitOffsetBps: 200, carryUnfilledBars: 5 };
    const r = runBacktest(makeConfig(), dataset, strat, stubDeps, opts);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]?.entryTime).toBe(T[4]);
    expect(r.trades[0]?.entryPrice).toBeCloseTo(98);
    // Without carry, the order expires unfilled on bar 2.
    const none = runBacktest(makeConfig(), dataset, strat, stubDeps, { ...opts, carryUnfilledBars: 0 });
    expect(none.trades).toHaveLength(0);
    expect(none.warnings.some((w) => w.includes("cancelled"))).toBe(true);
  });

  it("limit orders that gap through fill at the better open", () => {
    const bar: Bar = { symbol: "A", interval: "day", time: T[0] as string, open: 95, high: 99, low: 94, close: 98, volume: 1e6, interpolated: false, adjusted: "none" };
    const fill = simulateFill({ side: "buy", quantity: 10, type: "limit", limitPrice: 98 }, bar, ZERO_COSTS);
    expect(fill?.fillPrice).toBe(95);
    const noFill = simulateFill({ side: "buy", quantity: 10, type: "limit", limitPrice: 90 }, bar, ZERO_COSTS);
    expect(noFill).toBeNull();
  });

  it("market fills pay half spread and impact; participation is capped", () => {
    const bar: Bar = { symbol: "A", interval: "day", time: T[0] as string, open: 100, high: 101, low: 99, close: 100, volume: 10_000, interpolated: false, adjusted: "none" };
    const fill = simulateFill({ side: "buy", quantity: 5_000, type: "market", limitPrice: null }, bar, REALISTIC_COSTS);
    expect(fill?.quantity).toBe(1_000); // 10% of volume
    const expectedBps = REALISTIC_COSTS.defaultHalfSpreadBps + impactBps(REALISTIC_COSTS, 1_000, 10_000);
    expect(fill?.fillPrice).toBeCloseTo(100 * (1 + expectedBps / 10_000));
    expect(fill?.commission).toBe(5);
    expect(fill?.costs).toBeCloseTo((fill?.fillPrice as number - 100) * 1_000 + 5);
    const sell = simulateFill({ side: "sell", quantity: 100, type: "market", limitPrice: null }, bar, REALISTIC_COSTS);
    expect(sell?.fillPrice as number).toBeLessThan(100);
  });

  it("partial fills beyond max participation are cancelled with a warning when not carried", () => {
    const dataset = simpleDataset({ AAA: flat }, 500);
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const r = runBacktest(makeConfig({ costModel: { ...ZERO_COSTS, maxParticipation: 0.1 } }), dataset, strat, stubDeps);
    expect(r.trades[0]?.quantity).toBe(50);
    expect(r.warnings.some((w) => w.includes("partially/unfilled"))).toBe(true);
  });

  it("never buys on margin", () => {
    const dataset = simpleDataset({ AAA: flat });
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const r = runBacktest(makeConfig({ initialCapital: 10_000 }), dataset, strat, stubDeps, { sizer: () => 1_000_000 });
    expect(r.trades[0]?.quantity).toBe(100);
    expect((r.equityCurve[r.equityCurve.length - 1] as { equity: number }).equity).toBeCloseTo(10_000);
  });
});

describe("position management", () => {
  it("exits at the stop when the bar trades through it", () => {
    const closes = [100, 100, 100, 100, 90, 90, 90, 90, 90, 90, 90, 90];
    const dataset = simpleDataset({ AAA: closes });
    const strat = scripted({ [T[1] as string]: view({ direction: "long", invalidationPrice: 95 }) });
    const r = runBacktest(makeConfig(), dataset, strat, stubDeps);
    const t = r.trades[0] as (typeof r.trades)[number];
    expect(t.exitReason).toBe("stop");
    expect(t.exitTime).toBe(T[4]);
    expect(t.exitPrice).toBe(95);
    expect(t.netPnl).toBeCloseTo(-5 * t.quantity);
    expect(t.maePct).toBeLessThan(-5);
  });

  it("exits at the target when the bar reaches it", () => {
    const closes = [100, 100, 100, 100, 112, 112, 112, 112, 112, 112, 112, 112];
    const dataset = simpleDataset({ AAA: closes });
    const strat = scripted({ [T[1] as string]: view({ direction: "long", targetPrice: 110 }) });
    const r = runBacktest(makeConfig(), dataset, strat, stubDeps);
    const t = r.trades[0] as (typeof r.trades)[number];
    expect(t.exitReason).toBe("target");
    expect(t.exitTime).toBe(T[4]);
    expect(t.exitPrice).toBe(110);
    expect(t.mfePct).toBeGreaterThan(10);
  });

  it("enforces the maximum holding period", () => {
    const dataset = simpleDataset({ AAA: flat });
    const strat = scripted({ [T[1] as string]: view({ direction: "long" }) });
    const r = runBacktest(makeConfig(), dataset, strat, stubDeps, { maxHoldingBars: 3 });
    const t = r.trades[0] as (typeof r.trades)[number];
    expect(t.exitReason).toBe("max_holding");
    expect(t.entryTime).toBe(T[2]);
    expect(t.exitTime).toBe(T[6]);
    expect(t.holdingBars).toBe(4);
  });

  it("reduce sells a fraction and exit closes the rest", () => {
    const dataset = simpleDataset({ AAA: flat });
    const strat = scripted({
      [T[1] as string]: view({ direction: "long" }),
      [T[4] as string]: view({ direction: "reduce" }),
      [T[7] as string]: view({ direction: "exit" }),
    });
    const r = runBacktest(makeConfig(), dataset, strat, stubDeps);
    expect(r.trades).toHaveLength(2);
    const [a, b] = r.trades as [(typeof r.trades)[number], (typeof r.trades)[number]];
    expect(a.exitReason).toBe("reduce");
    expect(a.exitTime).toBe(T[5]);
    expect(b.exitReason).toBe("exit");
    expect(b.exitTime).toBe(T[8]);
    expect(a.quantity).toBe(b.quantity);
    expect(r.openPositions).toBe(0);
  });

  it("reports still-open positions as open trades marked at the last close", () => {
    const dataset = simpleDataset({ AAA: flat });
    const r = runBacktest(makeConfig(), dataset, buyAndHold, stubDeps);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]?.exitTime).toBeNull();
    expect(r.trades[0]?.exitReason).toBe("open");
    expect(r.openPositions).toBe(1);
    expect(r.metrics.tradeCount).toBe(0);
  });

  it("force-closes positions in delisted names at a haircut and keeps running", () => {
    const dataset = generateSyntheticDataset({ symbols: ["CCC"], bars: 30, seed: 11, delistings: [{ symbol: "CCC", atBar: 15 }] });
    const cal = dataset.calendar as string[];
    const r = runBacktest(makeConfig({ symbols: ["CCC"] }), dataset, buyAndHold, stubDeps, { delistingHaircutPct: 10 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0] as (typeof r.trades)[number];
    expect(t.exitReason).toBe("delisting");
    expect(t.exitTime).toBe(cal[15]);
    const lastBar = (dataset.bars.CCC as Bar[])[14] as Bar;
    expect(t.exitPrice).toBeCloseTo(lastBar.close * 0.9);
    expect(r.warnings.some((w) => w.includes("delisting"))).toBe(true);
    expect(r.equityCurve).toHaveLength(30);
    expect(r.openPositions).toBe(0);
  });

  it("excludes delisted names entirely when includeDelisted is false", () => {
    const dataset = generateSyntheticDataset({ symbols: ["AAA", "CCC"], bars: 30, seed: 11, delistings: [{ symbol: "CCC", atBar: 15 }] });
    const r = runBacktest(makeConfig({ includeDelisted: false }), dataset, buyAndHold, stubDeps);
    expect(r.trades.every((t) => t.symbol === "AAA")).toBe(true);
  });
});

describe("costs and sizing", () => {
  it("costs reduce net versus gross and are reconciled per trade", () => {
    const dataset = generateSyntheticDataset({ symbols: ["AAA", "BBB", "CCC"], bars: 120, seed: 21 });
    const strat = makeStrategy((ctx) => {
      const n = ctx.bars.length;
      if (!ctx.position && n % 7 === 0) return { signals: [], view: view({ direction: "long", confidence: 0.8 }) };
      if (ctx.position && n % 7 === 4) return { signals: [], view: view({ direction: "exit" }) };
      return { signals: [], view: null };
    });
    const free = runBacktest(makeConfig(), dataset, strat, stubDeps);
    const paid = runBacktest(makeConfig({ costModel: REALISTIC_COSTS }), dataset, strat, stubDeps);
    expect(free.metrics.tradeCount).toBeGreaterThan(5);
    expect(paid.metrics.totalCosts).toBeGreaterThan(0);
    expect(free.metrics.totalCosts).toBe(0);
    expect(paid.metrics.netReturnPct).toBeLessThan(free.metrics.netReturnPct);
    expect(paid.metrics.grossReturnPct).toBeGreaterThan(paid.metrics.netReturnPct);
    expect(paid.metrics.grossReturnPct - paid.metrics.netReturnPct).toBeCloseTo((paid.metrics.totalCosts / 100_000) * 100, 6);
    for (const t of paid.trades) {
      expect(t.costs).toBeGreaterThan(0);
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.costs, 8);
    }
    expect(paid.trades.reduce((s, t) => s + t.costs, 0)).toBeCloseTo(paid.metrics.totalCosts, 6);
  });

  it("default sizer uses a confidence-scaled fraction of equity capped at 10%", () => {
    const dataset = simpleDataset({ AAA: flat });
    const half = scripted({ [T[1] as string]: view({ direction: "long", confidence: 0.5 }) });
    const r = runBacktest(makeConfig(), dataset, half, stubDeps);
    expect(r.trades[0]?.quantity).toBe(50); // 5% of 100k at 100
    const full = scripted({ [T[1] as string]: view({ direction: "long", confidence: 1 }) });
    expect(runBacktest(makeConfig(), dataset, full, stubDeps).trades[0]?.quantity).toBe(100);
    expect(defaultSizer({ symbol: "A", equity: 1000, cash: 1000, price: 10, confidence: 2, strength: 1, view: view({ direction: "long" }) as never, parameters: {}, openPositions: 0, maxPositionFraction: 0.1, allowFractional: false })).toBe(10);
  });

  it("uses a custom sizer when provided and respects maxOpenPositions", () => {
    const dataset = simpleDataset({ AAA: flat, BBB: flat, CCC: flat });
    const r = runBacktest(makeConfig(), dataset, buyAndHold, stubDeps, { sizer: () => 7, maxOpenPositions: 2 });
    expect(r.trades).toHaveLength(2);
    expect(r.trades.every((t) => t.quantity === 7)).toBe(true);
  });
});

describe("result shape and determinism", () => {
  it("produces identical results for identical inputs and a stable id", () => {
    const dataset = generateSyntheticDataset({ symbols: ["AAA", "BBB"], bars: 60, seed: 3 });
    const a = runBacktest(makeConfig({ costModel: REALISTIC_COSTS }), dataset, buyAndHold, stubDeps);
    const b = runBacktest(makeConfig({ costModel: REALISTIC_COSTS }), dataset, buyAndHold, stubDeps);
    expect(a).toEqual(b);
    expect(a.id).toMatch(/^bt_[0-9a-f]{16}$/);
    expect(a.dataFingerprint).toBe(b.dataFingerprint);
    expect(a.ranAt).toBe(a.config.end);
  });

  it("records equity, drawdown, exposure and regime for every trading day in the window", () => {
    const dataset = generateSyntheticDataset({ symbols: ["AAA"], bars: 60, seed: 4 });
    const cal = dataset.calendar as string[];
    const r = runBacktest(makeConfig({ start: cal[10] as string, end: cal[39] as string }), dataset, buyAndHold, stubDeps);
    expect(r.equityCurve).toHaveLength(30);
    expect(r.barRegimes).toHaveLength(30);
    expect(r.equityCurve[0]?.time).toBe(cal[10]);
    expect(r.equityCurve[0]?.exposure).toBe(0);
    expect(r.equityCurve[2]?.exposure).toBeGreaterThan(0);
    for (const p of r.equityCurve) {
      expect(p.drawdownPct).toBeGreaterThanOrEqual(0);
      expect(p.exposure).toBeLessThanOrEqual(1);
    }
    expect(new Set(r.barRegimes.map((b) => b.regime)).size).toBeGreaterThanOrEqual(1);
  });

  it("warns about unknown symbols and still runs", () => {
    const dataset = simpleDataset({ AAA: flat });
    const r = runBacktest(makeConfig({ symbols: ["AAA", "ZZZ"] }), dataset, buyAndHold, stubDeps);
    expect(r.warnings).toContain("symbol ZZZ not in dataset");
    expect(r.trades).toHaveLength(1);
  });

  it("passes universe features to strategies that need them", () => {
    const dataset = simpleDataset({ AAA: flat, BBB: flat });
    const rec = recording(makeStrategy(() => ({ signals: [], view: null }), { needsUniverse: true }));
    runBacktest(makeConfig(), dataset, rec.strategy, stubDeps);
    expect(rec.contexts[0]?.universe?.map((u) => u.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("stableStringify sorts keys", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});
