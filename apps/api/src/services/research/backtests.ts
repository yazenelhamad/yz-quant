import type { BacktestConfig, BacktestResult, Bar, CostModel, MonteCarloResult, Strategy, StrategyDescriptor, WalkForwardResult } from "@yz/core";
import { assessRegime, computeFeatures, fingerprint, getStrategy, monteCarlo, outOfSample, runBacktest, walkForward, type BacktestDependencies, type BacktestRunResult, type ParameterGrid, type BacktestDataset } from "@yz/core";
import type { BacktestRow } from "@yz/db";
import type { LearningRepos } from "../learning/repos.js";
import type { Repos } from "../../http/app.js";

export type BacktestKind = "in_sample" | "out_of_sample" | "walk_forward" | "monte_carlo";
export type BacktestStatus = "queued" | "running" | "completed" | "failed";

export interface BacktestRequest {
  strategyKey: string;
  versionId: string | null;
  symbols: string[];
  start: string;
  end: string;
  kind: BacktestKind;
  requestedBy: string;
}

/** Persisted inside `backtests.config` alongside the engine config. */
export interface StoredBacktestConfig {
  request: BacktestRequest;
  status: BacktestStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  engine: BacktestConfig | null;
  walkForward: WalkForwardResult | null;
  monteCarlo: MonteCarloResult | null;
  outOfSample: { inSample: Omit<BacktestResult, "trades" | "equityCurve">; outOfSample: Omit<BacktestResult, "trades" | "equityCurve"> } | null;
}

export const BACKTEST_COST_MODEL: CostModel = Object.freeze({ commissionPerShare: 0, commissionMin: 0, defaultHalfSpreadBps: 5, impactCoefficient: 10, executionDelayBars: 1, maxParticipation: 0.1 });
export const MIN_EXTRA_BARS = 60;
export const MAX_GRID_COMBOS = 27;
export const MONTE_CARLO_RUNS = 1000;
export const BENCHMARK_SYMBOL = "SPY";

export class BacktestDataError extends Error { override readonly name = "BacktestDataError"; }

export interface BacktestRunnerOptions {
  clock?: () => Date;
  /** Strategy lookup (tests inject small strategies). Defaults to the shared library. */
  resolveStrategy?: (key: string) => Strategy | undefined;
  log?: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

function barRowToBar(r: { symbol: string; interval: string; time: string; open: number; high: number; low: number; close: number; volume: number; interpolated: boolean; adjusted: string; source: string; receivedAt: string }): Bar {
  return { symbol: r.symbol, interval: r.interval as Bar["interval"], time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, interpolated: r.interpolated, adjusted: r.adjusted as Bar["adjusted"], provenance: { source: r.source, observedAt: r.time, receivedAt: r.receivedAt, reliability: 1 } };
}

/** Production dependencies: the real feature and regime engines over the dataset's own bars. */
export const backtestDeps: BacktestDependencies = {
  computeFeatures(bars, intradayBars, quote, benchmarkBars) {
    const asOf = bars.length ? bars[bars.length - 1]!.time : new Date(0).toISOString();
    const f = computeFeatures({ asOf, bars, intradayBars: intradayBars ?? null, quote: quote ?? null, benchmarkBars: benchmarkBars ?? null });
    return { values: f.values, freshness: f.freshness, featureVersion: f.featureVersion, warnings: f.warnings };
  },
  assessRegime(benchmarkBars, asOf, vixBars) {
    return assessRegime({ asOf, spy: benchmarkBars, qqq: [], vix: vixBars ?? null });
  },
};

/** Up to three numeric parameters with ranges, three points each (min, default, max) => at most 27 combinations. */
export function parameterGridFor(descriptor: StrategyDescriptor, base: Record<string, number | string | boolean>): ParameterGrid {
  const grid: ParameterGrid = {};
  let combos = 1;
  for (const [key, spec] of Object.entries(descriptor.parameters)) {
    if (typeof spec.default !== "number" || spec.min === undefined || spec.max === undefined) continue;
    const def = typeof base[key] === "number" ? (base[key] as number) : spec.default;
    const values = Array.from(new Set([spec.min, def, spec.max])).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (values.length < 2) continue;
    if (combos * values.length > MAX_GRID_COMBOS) break;
    grid[key] = values;
    combos *= values.length;
  }
  return grid;
}

function stripHeavy(r: BacktestResult): Omit<BacktestResult, "trades" | "equityCurve"> {
  const { trades: _t, equityCurve: _e, ...rest } = r;
  return rest;
}

/**
 * In-process backtest queue: one run at a time, status kept in memory and mirrored into the
 * persisted row so a restart never shows a phantom "running" job. Datasets come only from stored
 * market bars; insufficient history fails the run with a clear error (never synthetic data).
 */
export class BacktestRunner {
  private readonly status = new Map<string, BacktestStatus>();
  private readonly queue: string[] = [];
  private running: Promise<void> | null = null;
  private readonly clock: () => Date;
  private readonly resolve: (key: string) => Strategy | undefined;
  private readonly log: NonNullable<BacktestRunnerOptions["log"]>;

  constructor(private readonly repos: Repos, private readonly lr: LearningRepos, options: BacktestRunnerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.resolve = options.resolveStrategy ?? ((key) => getStrategy(key));
    this.log = options.log ?? { warn() {}, error() {} };
  }

  strategyFor(key: string): Strategy | undefined { return this.resolve(key); }

  /** Creates the persisted row (status queued) and schedules the run. Returns immediately. */
  async enqueue(request: BacktestRequest): Promise<{ id: string; status: BacktestStatus }> {
    const now = this.clock().toISOString();
    const stored: StoredBacktestConfig = { request, status: "queued", requestedAt: now, startedAt: null, completedAt: null, error: null, engine: null, walkForward: null, monteCarlo: null, outOfSample: null };
    const row = await this.lr.backtests.create({ strategyKey: request.strategyKey, strategyVersionId: request.versionId, kind: request.kind, config: stored, metrics: {}, equityCurve: [], trades: [], warnings: [], dataFingerprint: "", requestedBy: request.requestedBy, durationMs: 0, ranAt: now });
    this.status.set(row.id, "queued");
    this.queue.push(row.id);
    this.pump();
    return { id: row.id, status: "queued" };
  }

  statusOf(id: string): BacktestStatus | undefined { return this.status.get(id); }

  /** Resolves when every queued run has finished (tests / shutdown). */
  async drain(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      if (this.running) await this.running; else this.pump();
    }
  }

  private pump(): void {
    if (this.running || this.queue.length === 0) return;
    const id = this.queue.shift()!;
    this.running = this.runBacktestJob(id).then(() => undefined, (err) => this.log.error({ err, id }, "backtest job crashed")).finally(() => { this.running = null; this.pump(); });
  }

  async runBacktestJob(id: string): Promise<BacktestRow | undefined> {
    const row = await this.lr.backtests.byId(id);
    if (!row) return undefined;
    const stored = row.config as StoredBacktestConfig;
    const startedAt = this.clock().toISOString();
    this.status.set(id, "running");
    await this.lr.backtests.update(id, { config: { ...stored, status: "running", startedAt } });
    const t0 = Date.now();
    try {
      const out = await this.execute(stored.request);
      const completedAt = this.clock().toISOString();
      const config: StoredBacktestConfig = { ...stored, status: "completed", startedAt, completedAt, error: null, engine: out.result.config, walkForward: out.walkForward, monteCarlo: out.monteCarlo, outOfSample: out.outOfSample };
      await this.lr.backtests.update(id, { config, metrics: out.result.metrics, equityCurve: out.result.equityCurve, trades: out.result.trades, warnings: out.warnings, dataFingerprint: out.result.dataFingerprint, durationMs: Date.now() - t0, ranAt: completedAt });
      this.status.set(id, "completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.lr.backtests.update(id, { config: { ...stored, status: "failed", startedAt, completedAt: this.clock().toISOString(), error: message }, warnings: [message], durationMs: Date.now() - t0 });
      this.status.set(id, "failed");
      this.log.warn({ err, id }, "backtest failed");
    }
    return this.lr.backtests.byId(id);
  }

  async buildDataset(symbols: string[], start: string, end: string, warmupBars: number): Promise<{ dataset: BacktestDataset; warnings: string[] }> {
    const warnings: string[] = ["corporate actions are not available from the broker feed; bars are split-adjusted as delivered, dividends are not modelled"];
    const lookbackStart = new Date(Date.parse(start) - Math.ceil(warmupBars * 1.6 + 10) * 86_400_000).toISOString();
    const bars: Record<string, Bar[]> = {};
    const delistings: Record<string, string> = {};
    const minBars = warmupBars + MIN_EXTRA_BARS;
    for (const symbol of symbols) {
      const rows = await this.repos.market.bars(symbol, "day", { start: lookbackStart, end, limit: 20_000 });
      const list = rows.map(barRowToBar).filter((b) => !b.interpolated);
      if (list.length < minBars) throw new BacktestDataError(`insufficient stored daily bars for ${symbol}: ${list.length} < ${minBars} (warm-up ${warmupBars} + ${MIN_EXTRA_BARS}); backtests never use synthetic data`);
      bars[symbol] = list;
      const inst = await this.repos.market.instrument(symbol);
      if (inst?.delistedAt) delistings[symbol] = inst.delistedAt;
    }
    const benchRows = await this.repos.market.bars(BENCHMARK_SYMBOL, "day", { start: lookbackStart, end, limit: 20_000 });
    const benchmark = benchRows.map(barRowToBar).filter((b) => !b.interpolated);
    if (benchmark.length < minBars) throw new BacktestDataError(`insufficient stored ${BENCHMARK_SYMBOL} benchmark bars: ${benchmark.length} < ${minBars}`);
    return { dataset: { symbols, bars, benchmark, corporateActions: [], delistings }, warnings };
  }

  async execute(request: BacktestRequest): Promise<{ result: BacktestRunResult; walkForward: WalkForwardResult | null; monteCarlo: MonteCarloResult | null; outOfSample: StoredBacktestConfig["outOfSample"]; warnings: string[] }> {
    const strategy = this.resolve(request.strategyKey);
    if (!strategy) throw new BacktestDataError(`unknown strategy ${request.strategyKey}`);
    const d = strategy.descriptor;
    if (d.interval !== "day") throw new BacktestDataError(`strategy ${d.key} needs ${d.interval} bars; only daily bars are stored for backtesting`);
    const version = request.versionId ? await this.lr.catalog.versionById(request.versionId) : undefined;
    const parameters: Record<string, number | string | boolean> = version?.parameters ?? Object.fromEntries(Object.entries(d.parameters).map(([k, v]) => [k, v.default]));
    const symbols = request.symbols.map((s) => s.toUpperCase());
    const { dataset, warnings } = await this.buildDataset(symbols, request.start, request.end, d.warmupBars);
    const config: BacktestConfig = { strategyKey: d.key, strategyVersion: version?.version ?? "1.0", parameters, symbols, start: request.start, end: request.end, interval: "day", initialCapital: 100_000, costModel: BACKTEST_COST_MODEL, includeDelisted: true, seed: 42 };
    const ranAt = this.clock().toISOString();
    const opts = { ranAt, maxOpenPositions: 10 };
    const factory = (params: BacktestConfig["parameters"]): Strategy => ({ descriptor: d, evaluate: (ctx) => strategy.evaluate({ ...ctx, parameters: { ...ctx.parameters, ...params } }) });

    let result: BacktestRunResult;
    let wf: WalkForwardResult | null = null;
    let mc: MonteCarloResult | null = null;
    let oos: StoredBacktestConfig["outOfSample"] = null;
    switch (request.kind) {
      case "out_of_sample": {
        const split = new Date(Date.parse(request.start) + 0.7 * (Date.parse(request.end) - Date.parse(request.start))).toISOString();
        const r = outOfSample(config, dataset, strategy, backtestDeps, split, opts);
        result = r.outOfSample;
        oos = { inSample: stripHeavy(r.inSample), outOfSample: stripHeavy(r.outOfSample) };
        break;
      }
      case "walk_forward": {
        const grid = parameterGridFor(d, parameters);
        const r = walkForward(config, dataset, factory, backtestDeps, { folds: 4, trainFraction: 0.7, purgeBars: 5, embargoBars: 2, parameterGrid: grid, engineOptions: opts });
        wf = { folds: r.folds, aggregate: r.aggregate, parameterStability: r.parameterStability, overfittingScore: r.overfittingScore };
        result = { ...runBacktest(config, dataset, strategy, backtestDeps, { ...opts, kind: "walk_forward" }), metrics: r.aggregate, equityCurve: r.aggregateEquityCurve, trades: r.aggregateTrades };
        if (r.folds.length === 0) warnings.push("walk-forward produced no folds (window too short for the requested fold count)");
        break;
      }
      case "monte_carlo": {
        result = runBacktest(config, dataset, strategy, backtestDeps, { ...opts, kind: "monte_carlo" });
        mc = monteCarlo(result, MONTE_CARLO_RUNS, config.seed);
        break;
      }
      default:
        result = runBacktest(config, dataset, strategy, backtestDeps, { ...opts, kind: "in_sample" });
    }
    warnings.push(...result.warnings);
    return { result: { ...result, dataFingerprint: result.dataFingerprint || fingerprint(dataset) }, walkForward: wf, monteCarlo: mc, outOfSample: oos, warnings: Array.from(new Set(warnings)) };
  }
}

/** BacktestRun view of docs/API.md addendum item 5 (percent points kept; the route converts). */
export function backtestRunView(row: BacktestRow, liveStatus?: BacktestStatus) {
  const c = row.config as StoredBacktestConfig;
  const metrics = row.metrics as Partial<BacktestResult["metrics"]>;
  const status = liveStatus ?? c.status;
  return {
    id: row.id, strategyKey: row.strategyKey, versionId: row.strategyVersionId, kind: row.kind, symbols: c.request?.symbols ?? [], start: c.request?.start ?? null, end: c.request?.end ?? null,
    status, requestedBy: row.requestedBy, requestedAt: c.requestedAt ?? row.ranAt, completedAt: c.completedAt ?? null, error: c.error ?? null,
    summary: status === "completed" && typeof metrics.totalReturnPct === "number" ? { totalReturnPct: metrics.totalReturnPct, sharpe: metrics.sharpe ?? null, maxDrawdownPct: metrics.maxDrawdownPct ?? 0, tradeCount: metrics.tradeCount ?? 0 } : null,
    warnings: row.warnings,
  };
}

export function backtestResultView(row: BacktestRow): { result: BacktestResult | null; walkForward: WalkForwardResult | null; monteCarlo: MonteCarloResult | null; outOfSample: StoredBacktestConfig["outOfSample"] } {
  const c = row.config as StoredBacktestConfig;
  if (c.status !== "completed" || !c.engine) return { result: null, walkForward: null, monteCarlo: null, outOfSample: null };
  return {
    result: { id: row.id, config: c.engine, kind: row.kind as BacktestResult["kind"], metrics: row.metrics as BacktestResult["metrics"], trades: row.trades as BacktestResult["trades"], equityCurve: row.equityCurve as BacktestResult["equityCurve"], warnings: row.warnings, dataFingerprint: row.dataFingerprint, ranAt: row.ranAt, durationMs: row.durationMs },
    walkForward: c.walkForward, monteCarlo: c.monteCarlo, outOfSample: c.outOfSample,
  };
}
