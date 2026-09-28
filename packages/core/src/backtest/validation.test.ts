import { describe, expect, it } from "vitest";
import type { Bar } from "../types/index.js";
import type { Strategy } from "../strategies/contract.js";
import { runBacktest } from "./engine.js";
import { generateSyntheticDataset } from "./synthetic.js";
import { buyAndHold, makeConfig, makeStrategy, REALISTIC_COSTS, stubDeps, view } from "./test-helpers.js";
import {
  chainEquityCurves,
  expandGrid,
  monteCarlo,
  outOfSample,
  parameterSensitivity,
  parameterStability,
  purgedKFold,
  regimeTest,
  shockBars,
  stressTest,
  walkForward,
} from "./validation.js";

/** Enters every `everyN` bars and exits `hold` bars later; parameterised for grid search. */
const factory = (params: Record<string, number | string | boolean>): Strategy => {
  const everyN = Number(params.everyN ?? 5);
  const hold = Number(params.hold ?? 3);
  return makeStrategy((ctx) => {
    const n = ctx.bars.length;
    if (!ctx.position && n % everyN === 0) return { signals: [], view: view({ direction: "long", confidence: 0.9 }) };
    if (ctx.position && n % everyN === hold) return { signals: [], view: view({ direction: "exit" }) };
    return { signals: [], view: null };
  });
};

const dataset = generateSyntheticDataset({
  symbols: ["AAA", "BBB", "CCC"],
  bars: 200,
  seed: 77,
  regimes: [
    { bars: 60, drift: 0.2, vol: 0.15 },
    { bars: 40, drift: -0.3, vol: 0.35 },
    { bars: 100, drift: 0.1, vol: 0.2 },
  ],
});
const cal = dataset.calendar as string[];
const idx = (t: string): number => cal.indexOf(t);

describe("purgedKFold", () => {
  it("produces disjoint, exhaustive test folds and purges/embargoes around them", () => {
    const indices = Array.from({ length: 100 }, (_, i) => i);
    const folds = purgedKFold(indices, 5, 2, 3);
    expect(folds).toHaveLength(5);
    const allTest = folds.flatMap((f) => f.test);
    expect(new Set(allTest).size).toBe(100);
    expect(allTest.length).toBe(100);
    const f1 = folds[1] as (typeof folds)[number];
    expect(f1.test[0]).toBe(20);
    expect(f1.test[f1.test.length - 1]).toBe(39);
    for (const i of [18, 19, 40, 41, 42, 25]) expect(f1.train).not.toContain(i);
    for (const i of [17, 43, 0, 99]) expect(f1.train).toContain(i);
    for (const f of folds) for (const i of f.test) expect(f.train).not.toContain(i);
  });

  it("handles degenerate inputs", () => {
    expect(purgedKFold([], 3)).toEqual([]);
    expect(purgedKFold([1, 2], 5)).toHaveLength(2);
  });
});

describe("expandGrid / parameterStability", () => {
  it("expands a cartesian product deterministically", () => {
    const combos = expandGrid({ b: [1, 2], a: ["x"] });
    expect(combos).toEqual([
      { a: "x", b: 1 },
      { a: "x", b: 2 },
    ]);
    expect(expandGrid({})).toEqual([{}]);
  });

  it("scores stable choices as 1 and dispersed choices lower", () => {
    const grid = { everyN: [5, 10, 15], mode: ["a", "b"] };
    expect(parameterStability([{ everyN: 5, mode: "a" }, { everyN: 5, mode: "a" }, { everyN: 5, mode: "a" }], grid)).toBe(1);
    const dispersed = parameterStability([{ everyN: 5, mode: "a" }, { everyN: 15, mode: "b" }, { everyN: 5, mode: "a" }], grid) as number;
    expect(dispersed).toBeGreaterThan(0);
    expect(dispersed).toBeLessThan(1);
    expect(parameterStability([{ everyN: 5 }], grid)).toBeNull();
  });
});

describe("walkForward", () => {
  const wf = walkForward(makeConfig({ parameters: { everyN: 5, hold: 3 } }), dataset, factory, stubDeps, {
    folds: 3,
    trainFraction: 0.7,
    purgeBars: 2,
    embargoBars: 3,
    parameterGrid: { everyN: [4, 6, 8] },
  });

  it("produces non-overlapping test windows that respect purge and embargo", () => {
    expect(wf.folds).toHaveLength(3);
    for (let i = 0; i < wf.folds.length; i++) {
      const fold = wf.folds[i] as (typeof wf.folds)[number];
      const trainEnd = idx(fold.train[1]);
      const testStart = idx(fold.test[0]);
      const testEnd = idx(fold.test[1]);
      expect(idx(fold.train[0])).toBeLessThan(trainEnd);
      // Gap between last training bar and first test bar covers purge + embargo.
      expect(testStart - trainEnd).toBeGreaterThanOrEqual(2 + 3 + 1);
      expect(testEnd).toBeGreaterThanOrEqual(testStart);
      if (i > 0) {
        const prev = wf.folds[i - 1] as (typeof wf.folds)[number];
        expect(testStart).toBeGreaterThan(idx(prev.test[1]));
      }
      expect([4, 6, 8]).toContain(fold.parameters.everyN);
      expect(fold.parameters.hold).toBe(3);
    }
    const last = wf.folds[wf.folds.length - 1] as (typeof wf.folds)[number];
    expect(last.test[1]).toBe(cal[cal.length - 1]);
  });

  it("aggregates test folds and scores stability and overfitting in range", () => {
    expect(wf.aggregateEquityCurve.length).toBeGreaterThan(0);
    expect(wf.aggregateEquityCurve[0]?.equity).toBeCloseTo(100_000);
    expect(wf.aggregate.tradeCount).toBe(wf.aggregateTrades.filter((t) => t.exitTime !== null).length);
    expect(wf.foldDetails).toHaveLength(3);
    if (wf.parameterStability !== null) {
      expect(wf.parameterStability).toBeGreaterThanOrEqual(0);
      expect(wf.parameterStability).toBeLessThanOrEqual(1);
    }
    expect(wf.overfittingScore).not.toBeNull();
    expect(wf.overfittingScore as number).toBeGreaterThanOrEqual(0);
    expect(wf.overfittingScore as number).toBeLessThanOrEqual(1);
  });

  it("picks the best training Sharpe over the grid", () => {
    // Re-run the first fold's training window for every grid value and confirm the pick is the max.
    const fold = wf.folds[0] as (typeof wf.folds)[number];
    const sharpes = [4, 6, 8].map((everyN) => {
      const r = runBacktest(makeConfig({ parameters: { everyN, hold: 3 }, start: fold.train[0], end: fold.train[1] }), dataset, factory({ everyN, hold: 3 }), stubDeps);
      return { everyN, sharpe: r.metrics.sharpe ?? 0 };
    });
    const best = sharpes.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
    expect(fold.parameters.everyN).toBe(best.everyN);
    expect(wf.foldDetails[0]?.trainSharpe).toBeCloseTo(best.sharpe);
  });

  it("is deterministic", () => {
    const again = walkForward(makeConfig({ parameters: { everyN: 5, hold: 3 } }), dataset, factory, stubDeps, {
      folds: 3,
      trainFraction: 0.7,
      purgeBars: 2,
      embargoBars: 3,
      parameterGrid: { everyN: [4, 6, 8] },
    });
    expect(again).toEqual(wf);
  });

  it("returns an empty result when the window is too short", () => {
    const short = walkForward(makeConfig({ start: cal[0] as string, end: cal[2] as string }), dataset, factory, stubDeps, {
      folds: 3,
      trainFraction: 0.7,
      purgeBars: 0,
      embargoBars: 0,
      parameterGrid: {},
    });
    expect(short.folds).toEqual([]);
    expect(short.overfittingScore).toBeNull();
  });
});

describe("chainEquityCurves", () => {
  it("chains returns continuously across segments", () => {
    const a = [
      { time: "t1", equity: 100, drawdownPct: 0, exposure: 1 },
      { time: "t2", equity: 110, drawdownPct: 0, exposure: 1 },
    ];
    const b = [
      { time: "t3", equity: 200, drawdownPct: 0, exposure: 1 },
      { time: "t4", equity: 180, drawdownPct: 10, exposure: 1 },
    ];
    const chained = chainEquityCurves([a, b], 1000);
    expect(chained.map((p) => p.equity)).toEqual([1000, 1100, 1100, 990]);
    expect(chained[3]?.drawdownPct).toBeCloseTo(10);
  });
});

describe("monteCarlo", () => {
  const result = runBacktest(makeConfig({ parameters: { everyN: 5, hold: 3 }, costModel: REALISTIC_COSTS }), dataset, factory({ everyN: 5, hold: 3 }), stubDeps);

  it("is deterministic for a seed and varies across seeds", () => {
    const a = monteCarlo(result, 300, 123);
    const b = monteCarlo(result, 300, 123);
    const c = monteCarlo(result, 300, 456);
    expect(a).toEqual(b);
    expect(a.runs).toBe(300);
    expect(a.p05ReturnPct).toBeLessThanOrEqual(a.medianReturnPct);
    expect(a.medianReturnPct).toBeLessThanOrEqual(a.p95ReturnPct);
    expect(a.medianMaxDrawdownPct).toBeLessThanOrEqual(a.p95MaxDrawdownPct);
    expect(a.probabilityOfLoss).toBeGreaterThanOrEqual(0);
    expect(a.probabilityOfLoss).toBeLessThanOrEqual(1);
    expect(a).not.toEqual(c);
  });

  it("handles zero runs and empty results without NaN", () => {
    const zero = monteCarlo(result, 0, 1);
    expect(zero.runs).toBe(0);
    expect(zero.medianReturnPct).toBe(0);
    const empty = monteCarlo({ ...result, trades: [], equityCurve: [] }, 10, 1);
    expect(empty.runs).toBe(10);
    expect(Number.isNaN(empty.medianMaxDrawdownPct)).toBe(false);
    expect(empty.probabilityOfLoss).toBe(0);
  });
});

describe("parameterSensitivity", () => {
  it("sweeps each parameter one at a time", () => {
    const surfaces = parameterSensitivity(makeConfig({ parameters: { everyN: 5, hold: 3 } }), dataset, factory, stubDeps, { everyN: [4, 8], hold: [1, 2, 3] });
    expect(surfaces.map((s) => s.parameter)).toEqual(["everyN", "hold"]);
    expect(surfaces[0]?.points.map((p) => p.value)).toEqual([4, 8]);
    expect(surfaces[1]?.points).toHaveLength(3);
    for (const s of surfaces) for (const p of s.points) expect(p.metrics.tradeCount).toBeGreaterThan(0);
    expect(surfaces[0]?.sharpeRange).not.toBeNull();
  });
});

describe("stressTest", () => {
  it("shockBars applies drift shocks and vol scaling while keeping OHLC consistent", () => {
    const bars = dataset.bars.AAA as Bar[];
    const flat = shockBars(bars, { name: "flat", returnShock: 0, volMultiplier: 0, spreadMultiplier: 1, liquidityMultiplier: 0.5 });
    const rets = flat.slice(1).map((b, i) => b.close / (flat[i] as Bar).close - 1);
    // Zero vol multiplier => every return equals the series mean.
    for (const r of rets) expect(r).toBeCloseTo(rets[0] as number, 10);
    expect(flat[5]?.volume).toBe(Math.round((bars[5] as Bar).volume * 0.5));
    for (const b of flat) {
      expect(b.high).toBeGreaterThanOrEqual(b.low);
      expect(b.low).toBeGreaterThan(0);
    }
    const crash = shockBars(bars, { name: "crash", returnShock: -0.01, volMultiplier: 1, spreadMultiplier: 1, liquidityMultiplier: 1 });
    expect((crash[crash.length - 1] as Bar).close).toBeLessThan((bars[bars.length - 1] as Bar).close);
  });

  it("worse scenarios hurt a long-only strategy", () => {
    const base = runBacktest(makeConfig({ costModel: REALISTIC_COSTS }), dataset, buyAndHold, stubDeps);
    const results = stressTest(makeConfig({ costModel: REALISTIC_COSTS }), dataset, buyAndHold, stubDeps, [
      { name: "crash", returnShock: -0.005, volMultiplier: 1, spreadMultiplier: 1, liquidityMultiplier: 1 },
      { name: "illiquid", returnShock: 0, volMultiplier: 1, spreadMultiplier: 5, liquidityMultiplier: 0.001 },
    ]);
    expect(results.map((r) => r.name)).toEqual(["crash", "illiquid"]);
    const crash = results[0] as (typeof results)[number];
    const illiquid = results[1] as (typeof results)[number];
    expect(crash.result.kind).toBe("stress");
    expect(crash.result.metrics.netReturnPct).toBeLessThan(base.metrics.netReturnPct);
    expect(illiquid.result.metrics.totalCosts).toBeGreaterThan(0);
    // Tiny liquidity caps fills to a fraction of the intended size.
    const baseQty = base.trades.reduce((s, t) => s + t.quantity, 0);
    const illiquidQty = illiquid.result.trades.reduce((s, t) => s + t.quantity, 0);
    expect(illiquidQty).toBeLessThan(baseQty);
    expect(illiquid.result.config.costModel.defaultHalfSpreadBps).toBe(REALISTIC_COSTS.defaultHalfSpreadBps * 5);
  });
});

describe("regimeTest and outOfSample", () => {
  it("summarises bars and trades per regime", () => {
    const result = runBacktest(makeConfig({ parameters: { everyN: 5, hold: 3 } }), dataset, factory({ everyN: 5, hold: 3 }), stubDeps);
    const summary = regimeTest(result);
    expect(summary.length).toBeGreaterThanOrEqual(1);
    expect(summary.reduce((s, r) => s + r.bars, 0)).toBe(result.equityCurve.length);
    expect(summary.reduce((s, r) => s + (r.barShare ?? 0), 0)).toBeCloseTo(1);
    expect(summary.reduce((s, r) => s + r.trades, 0)).toBe(result.metrics.tradeCount);
    for (const r of summary) expect(["bull_trend", "bear_trend"]).toContain(r.regime);
  });

  it("splits the window at the split date with no overlap", () => {
    const split = cal[120] as string;
    const { inSample, outOfSample: oos } = outOfSample(makeConfig(), dataset, buyAndHold, stubDeps, split);
    expect(inSample.kind).toBe("in_sample");
    expect(oos.kind).toBe("out_of_sample");
    expect(inSample.equityCurve[inSample.equityCurve.length - 1]?.time).toBe(cal[119]);
    expect(oos.equityCurve[0]?.time).toBe(split);
    expect(inSample.equityCurve.length + oos.equityCurve.length).toBe(cal.length);
  });
});
