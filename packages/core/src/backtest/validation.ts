/**
 * Validation procedures on top of the engine: walk-forward optimisation, purged K-fold
 * splits, Monte Carlo resampling, parameter sensitivity, stress scenarios, regime
 * attribution and a simple in-sample / out-of-sample split.
 *
 * All functions are pure and deterministic given their inputs and seeds.
 */
import type {
  BacktestConfig,
  BacktestMetrics,
  BacktestResult,
  BacktestTrade,
  Bar,
  EquityPoint,
  IsoTimestamp,
  MonteCarloResult,
  WalkForwardResult,
} from "../types/index.js";
import type { Strategy } from "../strategies/contract.js";
import { type BacktestDataset, compareTime, tradingDays } from "./data.js";
import { type BacktestDependencies, type BacktestOptions, type BacktestRunResult, PERIODS_PER_YEAR, runBacktest } from "./engine.js";
import { computeMetrics, equityMaxDrawdown, meanOf, percentile, periodReturns, stdev } from "./metrics.js";
import { bootstrapSample, mulberry32, shuffle } from "./random.js";

export type Parameters = BacktestConfig["parameters"];
export type ParameterValue = number | string | boolean;
export type ParameterGrid = Record<string, ParameterValue[]>;
export type StrategyFactory = (parameters: Parameters) => Strategy;

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Cartesian product of a parameter grid. Empty grid => one empty combination. */
export function expandGrid(grid: ParameterGrid): Parameters[] {
  const keys = Object.keys(grid).sort();
  let combos: Parameters[] = [{}];
  for (const key of keys) {
    const values = grid[key] ?? [];
    if (values.length === 0) continue;
    const next: Parameters[] = [];
    for (const combo of combos) for (const v of values) next.push({ ...combo, [key]: v });
    combos = next;
  }
  return combos;
}

function runRange(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategy: Strategy,
  deps: BacktestDependencies,
  start: IsoTimestamp,
  end: IsoTimestamp,
  kind: BacktestResult["kind"],
  parameters: Parameters,
  opts?: BacktestOptions,
): BacktestRunResult {
  return runBacktest({ ...config, start, end, parameters }, dataset, strategy, deps, { ...opts, kind });
}

function sharpeOrZero(m: BacktestMetrics): number {
  return m.sharpe ?? 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Chains several equity curves into one continuous curve starting at `initial`. */
export function chainEquityCurves(curves: readonly (readonly EquityPoint[])[], initial: number): EquityPoint[] {
  const out: EquityPoint[] = [];
  let level = initial;
  let peak = initial;
  for (const curve of curves) {
    if (curve.length === 0) continue;
    const base = (curve[0] as EquityPoint).equity;
    const prevLevel = level;
    for (const p of curve) {
      const equity = base > 0 ? prevLevel * (p.equity / base) : prevLevel;
      if (equity > peak) peak = equity;
      out.push({ time: p.time, equity, drawdownPct: peak > 0 ? ((peak - equity) / peak) * 100 : 0, exposure: p.exposure });
      level = equity;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Purged K-fold
// ---------------------------------------------------------------------------------------

export interface KFoldSplit {
  fold: number;
  train: number[];
  test: number[];
}

/**
 * Purged K-fold with embargo (Lopez de Prado). The test set of each fold is a contiguous
 * block; training excludes the block itself, `purge` observations immediately before it and
 * `embargo` observations immediately after it, so overlapping labels never leak.
 */
export function purgedKFold(indices: readonly number[], k: number, purge = 0, embargo = 0): KFoldSplit[] {
  const n = indices.length;
  if (k <= 0 || n === 0) return [];
  const folds = Math.min(k, n);
  const out: KFoldSplit[] = [];
  const size = n / folds;
  for (let f = 0; f < folds; f++) {
    const testStart = Math.floor(f * size);
    const testEnd = f === folds - 1 ? n - 1 : Math.floor((f + 1) * size) - 1;
    const purgeStart = testStart - purge;
    const embargoEnd = testEnd + embargo;
    const train: number[] = [];
    const test: number[] = [];
    for (let i = 0; i < n; i++) {
      const value = indices[i] as number;
      if (i >= testStart && i <= testEnd) test.push(value);
      else if (i >= purgeStart && i <= embargoEnd) continue;
      else train.push(value);
    }
    out.push({ fold: f, train, test });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Walk-forward
// ---------------------------------------------------------------------------------------

export interface WalkForwardOptions {
  folds: number;
  /** Fraction of each rolling window used for training (0 < f < 1). */
  trainFraction: number;
  /** Bars removed from the end of the training window. */
  purgeBars: number;
  /** Bars skipped between the (purged) training window and the test window. */
  embargoBars: number;
  parameterGrid: ParameterGrid;
  engineOptions?: BacktestOptions;
}

export interface WalkForwardRunResult extends WalkForwardResult {
  foldDetails: { trainSharpe: number | null; testSharpe: number | null; trainTrades: number; testTrades: number }[];
  aggregateEquityCurve: EquityPoint[];
  aggregateTrades: BacktestTrade[];
}

/**
 * Rolling walk-forward: the window slides forward by one test length per fold so test
 * windows never overlap. Parameters are chosen on the training window by best Sharpe over
 * the grid, then evaluated once on the test window.
 */
export function walkForward(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategyFactory: StrategyFactory,
  deps: BacktestDependencies,
  options: WalkForwardOptions,
): WalkForwardRunResult {
  const days = tradingDays(dataset, config.start, config.end);
  const D = days.length;
  const folds = Math.max(1, Math.floor(options.folds));
  const tf = clamp(options.trainFraction, 0.05, 0.95);
  const testLen = Math.max(1, Math.floor(D / (folds + tf / (1 - tf))));
  const trainLen = D - folds * testLen;
  const combos = expandGrid(options.parameterGrid);
  const grid = combos.length > 0 ? combos : [{}];

  const result: WalkForwardRunResult = {
    folds: [],
    aggregate: computeMetrics([], [], PERIODS_PER_YEAR[config.interval]),
    parameterStability: null,
    overfittingScore: null,
    foldDetails: [],
    aggregateEquityCurve: [],
    aggregateTrades: [],
  };
  if (trainLen <= options.purgeBars + 1 || D < 4) return result;

  const testCurves: EquityPoint[][] = [];
  const testTrades: BacktestTrade[] = [];
  const chosen: Parameters[] = [];
  const overfit: number[] = [];

  for (let f = 0; f < folds; f++) {
    const trainStart = f * testLen;
    const trainEnd = trainStart + trainLen - 1 - options.purgeBars;
    const testStart = trainStart + trainLen + options.embargoBars;
    const testEnd = Math.min(D - 1, trainStart + trainLen + testLen - 1);
    if (trainEnd <= trainStart || testEnd < testStart) continue;
    const trainRange: [IsoTimestamp, IsoTimestamp] = [days[trainStart] as IsoTimestamp, days[trainEnd] as IsoTimestamp];
    const testRange: [IsoTimestamp, IsoTimestamp] = [days[testStart] as IsoTimestamp, days[testEnd] as IsoTimestamp];

    let best: { params: Parameters; sharpe: number; trades: number } | null = null;
    for (const combo of grid) {
      const params = { ...config.parameters, ...combo };
      const r = runRange(config, dataset, strategyFactory(params), deps, trainRange[0], trainRange[1], "walk_forward", params, options.engineOptions);
      const s = sharpeOrZero(r.metrics);
      if (best === null || s > best.sharpe) best = { params, sharpe: s, trades: r.metrics.tradeCount };
    }
    const pick = best as { params: Parameters; sharpe: number; trades: number };
    const test = runRange(config, dataset, strategyFactory(pick.params), deps, testRange[0], testRange[1], "walk_forward", pick.params, options.engineOptions);
    const testSharpe = sharpeOrZero(test.metrics);
    chosen.push(pick.params);
    overfit.push((pick.sharpe - testSharpe) / Math.max(1, Math.abs(pick.sharpe)));
    testCurves.push(test.equityCurve);
    testTrades.push(...test.trades);
    result.folds.push({ train: trainRange, test: testRange, metrics: test.metrics, parameters: pick.params });
    result.foldDetails.push({ trainSharpe: pick.sharpe, testSharpe: test.metrics.sharpe, trainTrades: pick.trades, testTrades: test.metrics.tradeCount });
  }

  result.aggregateEquityCurve = chainEquityCurves(testCurves, config.initialCapital);
  result.aggregateTrades = testTrades;
  result.aggregate = computeMetrics(result.aggregateEquityCurve, testTrades, PERIODS_PER_YEAR[config.interval], {
    initialCapital: config.initialCapital,
  });
  result.parameterStability = parameterStability(chosen, options.parameterGrid);
  result.overfittingScore = overfit.length > 0 ? clamp(meanOf(overfit) as number, 0, 1) : null;
  return result;
}

/**
 * 1 - normalised dispersion of the chosen parameters across folds. Numeric parameters use
 * stdev / grid range; categorical ones use 1 - modal frequency. Null when nothing varied.
 */
export function parameterStability(chosen: readonly Parameters[], grid: ParameterGrid): number | null {
  if (chosen.length < 2) return null;
  const dispersions: number[] = [];
  for (const key of Object.keys(grid)) {
    const values = grid[key] ?? [];
    if (values.length < 2) continue;
    const picks = chosen.map((p) => p[key]).filter((v): v is ParameterValue => v !== undefined);
    if (picks.length < 2) continue;
    if (values.every((v) => typeof v === "number")) {
      const nums = picks.map((v) => Number(v));
      const range = Math.max(...(values as number[])) - Math.min(...(values as number[]));
      const sd = stdev(nums) ?? 0;
      dispersions.push(range > 0 ? clamp(sd / range, 0, 1) : 0);
    } else {
      const counts = new Map<string, number>();
      for (const v of picks) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const mode = Math.max(...counts.values());
      dispersions.push(1 - mode / picks.length);
    }
  }
  if (dispersions.length === 0) return null;
  return clamp(1 - (meanOf(dispersions) as number), 0, 1);
}

// ---------------------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------------------

/**
 * Resamples the realised outcome. Half of the runs bootstrap the closed-trade P&L sequence
 * (with replacement); the other half shuffle the per-period equity returns. Both preserve
 * the marginal distribution while destroying the realised ordering, which is what drawdown
 * risk depends on. Deterministic for a given seed.
 */
export function monteCarlo(result: BacktestResult, runs: number, seed: number): MonteCarloResult {
  const rng = mulberry32(seed);
  const initial = result.config.initialCapital;
  const pnls = result.trades.filter((t) => t.exitTime !== null).map((t) => t.netPnl);
  const returns = periodReturns(result.equityCurve.map((p) => p.equity));
  const totalRuns = Math.max(0, Math.floor(runs));
  const totalReturns: number[] = [];
  const drawdowns: number[] = [];

  const hasTrades = pnls.length > 0;
  const hasReturns = returns.length > 0;
  const tradeRuns = hasTrades && hasReturns ? Math.ceil(totalRuns / 2) : hasTrades ? totalRuns : 0;

  for (let run = 0; run < totalRuns; run++) {
    let path: number[];
    if (run < tradeRuns) {
      const sample = bootstrapSample(pnls, rng);
      path = [initial];
      let e = initial;
      for (const p of sample) {
        e += p;
        path.push(e);
      }
    } else if (hasReturns) {
      const sample = shuffle(returns, rng);
      path = [initial];
      let e = initial;
      for (const r of sample) {
        e *= 1 + r;
        path.push(e);
      }
    } else {
      path = [initial, initial];
    }
    const last = path[path.length - 1] as number;
    totalReturns.push(initial > 0 ? (last / initial - 1) * 100 : 0);
    drawdowns.push(equityMaxDrawdown(path).maxDrawdown * 100);
  }

  const losses = totalReturns.filter((r) => r < 0).length;
  return {
    runs: totalRuns,
    medianReturnPct: percentile(totalReturns, 0.5) ?? 0,
    p05ReturnPct: percentile(totalReturns, 0.05) ?? 0,
    p95ReturnPct: percentile(totalReturns, 0.95) ?? 0,
    medianMaxDrawdownPct: percentile(drawdowns, 0.5) ?? 0,
    p95MaxDrawdownPct: percentile(drawdowns, 0.95) ?? 0,
    probabilityOfLoss: totalRuns > 0 ? losses / totalRuns : 0,
  };
}

// ---------------------------------------------------------------------------------------
// Parameter sensitivity
// ---------------------------------------------------------------------------------------

export interface SensitivitySurface {
  parameter: string;
  points: { value: ParameterValue; metrics: BacktestMetrics }[];
  /** Sharpe range across the surface: large ranges signal fragile parameters. */
  sharpeRange: number | null;
}

/** One-at-a-time sweep: each parameter is varied over its grid while the others stay at config defaults. */
export function parameterSensitivity(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategyFactory: StrategyFactory,
  deps: BacktestDependencies,
  grid: ParameterGrid,
  opts?: BacktestOptions,
): SensitivitySurface[] {
  const out: SensitivitySurface[] = [];
  for (const parameter of Object.keys(grid).sort()) {
    const values = grid[parameter] ?? [];
    const points: SensitivitySurface["points"] = [];
    for (const value of values) {
      const params = { ...config.parameters, [parameter]: value };
      const r = runRange(config, dataset, strategyFactory(params), deps, config.start, config.end, "sensitivity", params, opts);
      points.push({ value, metrics: r.metrics });
    }
    const sharpes = points.map((p) => p.metrics.sharpe).filter((s): s is number => s !== null);
    out.push({ parameter, points, sharpeRange: sharpes.length > 0 ? Math.max(...sharpes) - Math.min(...sharpes) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Stress testing
// ---------------------------------------------------------------------------------------

export interface StressScenario {
  name: string;
  /** Additive shift applied to every bar's close-to-close return (e.g. -0.002 = -20 bps per bar). */
  returnShock: number;
  /** Multiplies the deviation of each bar's return from the series mean. */
  volMultiplier: number;
  /** Multiplies the cost model's half spread. */
  spreadMultiplier: number;
  /** Multiplies bar volume (lower = worse liquidity = more impact, smaller fills). */
  liquidityMultiplier: number;
}

export interface StressResult {
  name: string;
  scenario: StressScenario;
  result: BacktestRunResult;
}

/** Rebuilds a bar series with shocked returns; OHLC are scaled by the same factor as the close. */
export function shockBars(bars: readonly Bar[], scenario: StressScenario): Bar[] {
  if (bars.length === 0) return [];
  const rets = periodReturns(bars.map((b) => b.close));
  const m = meanOf(rets) ?? 0;
  const out: Bar[] = [];
  let prevClose = (bars[0] as Bar).close;
  let prevOriginal = prevClose;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] as Bar;
    let close = b.close;
    if (i > 0) {
      const r = prevOriginal > 0 ? b.close / prevOriginal - 1 : 0;
      const shocked = m + (r - m) * scenario.volMultiplier + scenario.returnShock;
      close = Math.max(0.01, prevClose * (1 + shocked));
    }
    const factor = b.close > 0 ? close / b.close : 1;
    out.push({
      ...b,
      open: Math.max(0.01, b.open * factor),
      high: Math.max(0.01, b.high * factor),
      low: Math.max(0.01, b.low * factor),
      close,
      volume: Math.max(0, Math.round(b.volume * scenario.liquidityMultiplier)),
    });
    prevOriginal = b.close;
    prevClose = close;
  }
  return out;
}

export function applyStressScenario(dataset: BacktestDataset, scenario: StressScenario): BacktestDataset {
  const bars: Record<string, Bar[]> = {};
  for (const s of dataset.symbols) bars[s] = shockBars(dataset.bars[s] ?? [], scenario);
  return { ...dataset, bars, benchmark: shockBars(dataset.benchmark, scenario) };
}

export function stressTest(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategy: Strategy,
  deps: BacktestDependencies,
  scenarios: readonly StressScenario[],
  opts?: BacktestOptions,
): StressResult[] {
  return scenarios.map((scenario) => {
    const stressed = applyStressScenario(dataset, scenario);
    const cfg: BacktestConfig = {
      ...config,
      costModel: { ...config.costModel, defaultHalfSpreadBps: config.costModel.defaultHalfSpreadBps * scenario.spreadMultiplier },
    };
    return { name: scenario.name, scenario, result: runBacktest(cfg, stressed, strategy, deps, { ...opts, kind: "stress" }) };
  });
}

// ---------------------------------------------------------------------------------------
// Regime attribution
// ---------------------------------------------------------------------------------------

export interface RegimeSummary {
  regime: string;
  /** Bars spent in the regime (0 when the result carries no per-bar labels). */
  bars: number;
  barShare: number | null;
  trades: number;
  returnPct: number;
  avgReturnPct: number | null;
  winRate: number | null;
}

/** Performance broken down by the regime prevailing at trade entry. */
export function regimeTest(result: BacktestResult | BacktestRunResult): RegimeSummary[] {
  const barCounts = new Map<string, number>();
  const barRegimes = (result as Partial<BacktestRunResult>).barRegimes ?? [];
  for (const b of barRegimes) barCounts.set(b.regime, (barCounts.get(b.regime) ?? 0) + 1);
  const labels = new Set<string>([...barCounts.keys(), ...Object.keys(result.metrics.byRegime)]);
  const out: RegimeSummary[] = [];
  for (const regime of [...labels].sort()) {
    const trades = result.trades.filter((t) => t.exitTime !== null && t.regime === regime);
    const attribution = result.metrics.byRegime[regime];
    const bars = barCounts.get(regime) ?? 0;
    out.push({
      regime,
      bars,
      barShare: barRegimes.length > 0 ? bars / barRegimes.length : null,
      trades: attribution?.trades ?? trades.length,
      returnPct: attribution?.returnPct ?? trades.reduce((s, t) => s + t.returnPct, 0),
      avgReturnPct: meanOf(trades.map((t) => t.returnPct)),
      winRate: attribution?.winRate ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// In-sample / out-of-sample split
// ---------------------------------------------------------------------------------------

export interface OutOfSampleResult {
  inSample: BacktestRunResult;
  outOfSample: BacktestRunResult;
}

/** Runs the strategy before and from `splitDate` (the split day belongs to the out-of-sample window). */
export function outOfSample(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategy: Strategy,
  deps: BacktestDependencies,
  splitDate: IsoTimestamp,
  opts?: BacktestOptions,
): OutOfSampleResult {
  const days = tradingDays(dataset, config.start, config.end);
  const before = days.filter((d) => compareTime(d, splitDate) < 0);
  const inSampleEnd = before.length > 0 ? (before[before.length - 1] as IsoTimestamp) : config.start;
  const inSample = runRange(config, dataset, strategy, deps, config.start, inSampleEnd, "in_sample", config.parameters, opts);
  const outOfSampleResult = runRange(config, dataset, strategy, deps, splitDate, config.end, "out_of_sample", config.parameters, opts);
  return { inSample, outOfSample: outOfSampleResult };
}
