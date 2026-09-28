/**
 * Shared fixtures for backtest tests: stub feature/regime dependencies and tiny strategies.
 * Not exported from the package index.
 */
import type { BacktestConfig, Bar, CostModel, IsoTimestamp, RegimeAssessment } from "../types/index.js";
import type { Strategy, StrategyContext, StrategyOutput } from "../strategies/contract.js";
import type { BacktestDependencies } from "./engine.js";

export const ZERO_COSTS: CostModel = {
  commissionPerShare: 0,
  commissionMin: 0,
  defaultHalfSpreadBps: 0,
  impactCoefficient: 0,
  executionDelayBars: 1,
  maxParticipation: 1,
};

export const REALISTIC_COSTS: CostModel = {
  commissionPerShare: 0.005,
  commissionMin: 1,
  defaultHalfSpreadBps: 5,
  impactCoefficient: 10,
  executionDelayBars: 1,
  maxParticipation: 0.1,
};

export function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    strategyKey: "test",
    strategyVersion: "1.0",
    parameters: {},
    symbols: [],
    start: "2000-01-01T00:00:00.000Z",
    end: "2100-01-01T00:00:00.000Z",
    interval: "day",
    initialCapital: 100_000,
    costModel: ZERO_COSTS,
    includeDelisted: true,
    seed: 42,
    ...overrides,
  };
}

/** Stub feature engine: last close, 5-bar SMA and bar count. Pure. */
export const stubDeps: BacktestDependencies = {
  computeFeatures(bars) {
    const last = bars[bars.length - 1];
    const window = bars.slice(-5);
    const sma5 = window.length > 0 ? window.reduce((s, b) => s + b.close, 0) / window.length : null;
    return {
      values: { close: last ? last.close : null, sma5, barCount: bars.length },
      freshness: "fresh",
      featureVersion: "stub-1",
      warnings: [],
    };
  },
  assessRegime(benchmarkBars, asOf) {
    return stubRegime(benchmarkBars, asOf);
  },
};

export function stubRegime(benchmarkBars: Bar[], asOf: IsoTimestamp): RegimeAssessment {
  const n = benchmarkBars.length;
  const last = benchmarkBars[n - 1];
  const back = benchmarkBars[Math.max(0, n - 21)];
  const trend = last && back ? last.close / back.close - 1 : 0;
  const primary = trend >= 0 ? "bull_trend" : "bear_trend";
  return {
    asOf,
    primary,
    probabilities: { [primary]: 1 },
    confidence: 1,
    abnormality: 0,
    metrics: {
      spyTrend20: trend,
      spyTrend100: null,
      realizedVol20: null,
      vix: null,
      breadthPctAbove50: null,
      avgPairwiseCorrelation: null,
      sectorDispersion: null,
      momentumPersistence: null,
      meanReversionScore: null,
      volumeRatio: null,
    },
    familyBias: {},
    explanation: ["stub"],
    dataQuality: "fresh",
  };
}

export function view(partial: Partial<NonNullable<StrategyOutput["view"]>> & { direction: NonNullable<StrategyOutput["view"]>["direction"] }): StrategyOutput["view"] {
  return {
    strength: 1,
    confidence: 1,
    horizonDays: 10,
    expectedUpsidePct: 5,
    expectedDownsidePct: 2,
    invalidationPrice: null,
    targetPrice: null,
    explanation: "test",
    ...partial,
  };
}

export function makeStrategy(evaluate: (ctx: StrategyContext) => StrategyOutput, overrides: Partial<Strategy["descriptor"]> = {}): Strategy {
  return {
    descriptor: {
      key: "test",
      name: "Test",
      family: "trend_momentum",
      description: "test strategy",
      supportedRegimes: [],
      parameters: {},
      warmupBars: 1,
      interval: "day",
      needsUniverse: false,
      ...overrides,
    },
    evaluate,
  };
}

/** Buys once and holds forever (confidence 1). */
export const buyAndHold: Strategy = makeStrategy((ctx) => ({
  signals: [],
  view: ctx.position ? null : view({ direction: "long" }),
}));

/**
 * Scripted strategy keyed by the ISO time of the decision bar: returns the mapped view on
 * that bar and null otherwise.
 */
export function scripted(script: Record<IsoTimestamp, StrategyOutput["view"]>, overrides: Partial<Strategy["descriptor"]> = {}): Strategy {
  return makeStrategy((ctx) => ({ signals: [], view: script[ctx.asOf] ?? null }), overrides);
}

/** Wraps a strategy and records every context it was evaluated with. */
export function recording(inner: Strategy): { strategy: Strategy; contexts: StrategyContext[] } {
  const contexts: StrategyContext[] = [];
  return {
    contexts,
    strategy: makeStrategy((ctx) => {
      contexts.push(ctx);
      return inner.evaluate(ctx);
    }, inner.descriptor),
  };
}

/** Deterministic, hand-built bars with a specified close path; open = previous close. */
export function barsFromCloses(symbol: string, times: IsoTimestamp[], closes: number[], volume = 1_000_000, spreadPct = 0.01): Bar[] {
  return times.map((time, i) => {
    const close = closes[i] as number;
    const open = i === 0 ? close : (closes[i - 1] as number);
    const hi = Math.max(open, close) * (1 + spreadPct);
    const lo = Math.min(open, close) * (1 - spreadPct);
    return { symbol, interval: "day", time, open, high: hi, low: lo, close, volume, interpolated: false, adjusted: "none" };
  });
}
