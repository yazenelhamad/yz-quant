import type {
  AgentIntelligenceProfile,
  CalibrationProfile,
  ExecutionOutcome,
  IsoTimestamp,
  ModelIntelligenceProfile,
  PerformanceStats,
  SignalIntelligenceProfile,
  StrategyIntelligenceProfile,
  TenantScope,
  TradeMemoryEntry,
} from "../types/index.js";
import { assertSameScope } from "../types/index.js";
import { calibrationFromObservations, flagOverconfident } from "./calibration.js";
import { confidenceBucket, holdingBucket } from "./lessons.js";
import { clamp, groupBy, isFiniteNumber, linearFit, mean, median, pct, pearson, spearman, stddev } from "./math.js";
import { entryAgeDays } from "./memory.js";
import { computePerformanceStats } from "./stats.js";

// ---------------------------------------------------------------------------------------------
// Strategy Intelligence Profile
// ---------------------------------------------------------------------------------------------

export interface BuildStrategyProfileInput {
  strategyId: string;
  strategyKey: string;
  /** Null = shared profile over both users' shadow + live outcomes; else a per-user profile. */
  scope: TenantScope | null;
  mode: StrategyIntelligenceProfile["mode"];
  entries: TradeMemoryEntry[];
  executionOutcomes: ExecutionOutcome[];
  /** Per-strategy chronological return series (percent) keyed by strategy key. */
  correlations: Record<string, number[]>;
  theoreticalEdgePct: number | null;
  now: IsoTimestamp;
  recentN?: number;
  options?: StrategyProfileOptions;
}

export interface StrategyProfileOptions {
  /** Trades below this count yield `insufficient_data`. */
  minTrades?: number;
  /** Samples needed in each of the recent and prior windows for a degradation verdict. */
  minDegradationSamples?: number;
  /** Max drawdown (percent) above which the recommendation is `pause`. */
  pauseDrawdownPct?: number;
  /** Feature key holding annualised realised volatility. */
  volFeatureKey?: string;
  liquidityFeatureKey?: string;
  /** Minimum trades in a breakdown bucket before it counts as evidence. */
  minBucketTrades?: number;
  rollingWindow?: number;
}

export const STRATEGY_PROFILE_DEFAULTS: Required<StrategyProfileOptions> = Object.freeze({
  minTrades: 20,
  minDegradationSamples: 15,
  pauseDrawdownPct: 15,
  volFeatureKey: "realized_vol_20",
  liquidityFeatureKey: "liquidity_score",
  minBucketTrades: 5,
  rollingWindow: 10,
});

/** Hard cap on any recommended allocation change. */
export const MAX_ALLOCATION_DELTA = 0.05;

export function volRegimeBucket(vol: number | null | undefined): string {
  if (!isFiniteNumber(vol)) return "unknown";
  if (vol < 0.15) return "low_vol";
  if (vol < 0.3) return "normal_vol";
  return "high_vol";
}

export function liquidityScoreBucket(score: number | null | undefined): string {
  if (!isFiniteNumber(score)) return "unknown";
  if (score < 0.33) return "low";
  if (score < 0.66) return "medium";
  return "high";
}

export function signalStrengthBucket(signals: Record<string, number>): string {
  const values = Object.values(signals).filter(isFiniteNumber).map(Math.abs);
  if (values.length === 0) return "unknown";
  const s = mean(values) as number;
  if (s < 0.33) return "weak";
  if (s < 0.66) return "moderate";
  return "strong";
}

const ET_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false });

/** New York wall-clock minute-of-day for an ISO timestamp, or null when unparseable. */
export function newYorkMinuteOfDay(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = ET_HOUR.formatToParts(new Date(t));
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h % 24) * 60 + m;
}

export function timeOfDayBucket(openedAt: string): string {
  const mod = newYorkMinuteOfDay(openedAt);
  if (mod === null) return "unknown";
  if (mod < 9 * 60 + 30 || mod >= 16 * 60) return "extended";
  if (mod < 10 * 60 + 30) return "open";
  if (mod < 12 * 60) return "morning";
  if (mod < 14 * 60) return "midday";
  if (mod < 15 * 60 + 30) return "afternoon";
  return "close";
}

function statsByGroup(entries: TradeMemoryEntry[], keyOf: (e: TradeMemoryEntry) => string | null): Record<string, PerformanceStats> {
  const groups = groupBy(entries, keyOf);
  const out: Record<string, PerformanceStats> = {};
  for (const k of Object.keys(groups).sort()) out[k] = computePerformanceStats(groups[k] as TradeMemoryEntry[]);
  return out;
}

function closedTime(e: TradeMemoryEntry): number {
  return Date.parse(e.closedAt ?? e.openedAt) || 0;
}

/**
 * Exponential-decay fit of edge against trade age. Trades are grouped into age quantile buckets;
 * the log of each bucket's mean return is regressed on its mean age. A positive decay rate gives
 * a half-life in days. Null unless every bucket has positive mean return (a decaying edge).
 */
export function estimateEdgeHalfLifeDays(entries: readonly TradeMemoryEntry[], now: IsoTimestamp, minTrades = 20, buckets = 5): number | null {
  const aged = entries
    .map((e) => ({ age: entryAgeDays(e, now), r: e.actualReturnPct }))
    .filter((x): x is { age: number; r: number } => isFiniteNumber(x.age) && isFiniteNumber(x.r) && x.age >= 0)
    .sort((a, b) => a.age - b.age);
  if (aged.length < minTrades) return null;
  const size = Math.floor(aged.length / buckets);
  if (size < 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = aged.slice(b * size, b === buckets - 1 ? aged.length : (b + 1) * size);
    const m = mean(slice.map((s) => s.r)) as number;
    if (m <= 0) return null;
    xs.push(mean(slice.map((s) => s.age)) as number);
    ys.push(Math.log(m));
  }
  const fit = linearFit(xs, ys);
  if (!fit) return null;
  // Age grows into the past. A decaying edge means older trades did better than recent ones,
  // i.e. log(return) rises with age; that slope is the decay rate.
  const lambda = fit.slope;
  if (lambda <= 1e-9) return null;
  return Math.log(2) / lambda;
}

export interface DegradationResult {
  score: number;
  trend: StrategyIntelligenceProfile["degradation"]["trend"];
  notes: string[];
  recentExpectancy: number | null;
  priorExpectancy: number | null;
}

/** Compares the last `recentN` trades with the trades before them. */
export function assessDegradation(sortedEntries: readonly TradeMemoryEntry[], recentN: number, minSamples: number): DegradationResult {
  const returns = sortedEntries.map((e) => e.actualReturnPct).filter(isFiniteNumber);
  const recent = returns.slice(-recentN);
  const prior = returns.slice(0, Math.max(0, returns.length - recentN));
  if (recent.length < minSamples || prior.length < minSamples) {
    return { score: 0, trend: "insufficient_data", notes: [`Need at least ${minSamples} recent and ${minSamples} prior trades (have ${recent.length} and ${prior.length}).`], recentExpectancy: mean(recent), priorExpectancy: mean(prior) };
  }
  const recentExp = mean(recent) as number;
  const priorExp = mean(prior) as number;
  const sd = stddev(returns) ?? 0;
  const scale = sd > 0 ? sd : Math.max(Math.abs(priorExp), 1e-6);
  const drop = (priorExp - recentExp) / scale;
  const recentWin = recent.filter((r) => r > 0).length / recent.length;
  const priorWin = prior.filter((r) => r > 0).length / prior.length;
  const winDrop = priorWin - recentWin;
  const score = clamp(0.7 * drop + 0.3 * (winDrop / 0.25), 0, 1);
  const trend: DegradationResult["trend"] = drop > 0.25 ? "deteriorating" : drop < -0.25 ? "improving" : "stable";
  return {
    score,
    trend,
    notes: [
      `Recent ${recent.length} trades: expectancy ${pct(recentExp)}, win rate ${(recentWin * 100).toFixed(0)}%.`,
      `Prior ${prior.length} trades: expectancy ${pct(priorExp)}, win rate ${(priorWin * 100).toFixed(0)}%.`,
      `Change of ${drop.toFixed(2)} standard deviations; trend ${trend}.`,
    ],
    recentExpectancy: recentExp,
    priorExpectancy: priorExp,
  };
}

/** 1 - (dispersion of rolling expectancy relative to per-trade dispersion), in [0, 1]. */
export function rollingStability(returns: readonly number[], window: number): number | null {
  if (returns.length < 2 * window) return null;
  const sd = stddev(returns);
  if (sd === null || sd === 0) return null;
  const rolling: number[] = [];
  for (let i = 0; i + window <= returns.length; i += window) rolling.push(mean(returns.slice(i, i + window)) as number);
  const rsd = stddev(rolling);
  if (rsd === null) return null;
  // For i.i.d. returns rsd ~ sd / sqrt(window); scale so that i.i.d. behaviour scores ~1.
  return clamp(1 - (rsd * Math.sqrt(window)) / sd / 2, 0, 1);
}

function describeBuckets(breakdowns: Record<string, Record<string, PerformanceStats>>, minTrades: number, positive: boolean): string[] {
  const out: string[] = [];
  for (const [dimension, byKey] of Object.entries(breakdowns)) {
    for (const [key, stats] of Object.entries(byKey)) {
      if (key === "unknown" || stats.trades < minTrades || stats.expectancyPct === null) continue;
      if (positive ? stats.expectancyPct > 0 : stats.expectancyPct < 0) out.push(`${dimension} ${key} (${stats.trades} trades, ${pct(stats.expectancyPct)})`);
    }
  }
  return out;
}

export function buildStrategyProfile(input: BuildStrategyProfileInput): StrategyIntelligenceProfile {
  const o = { ...STRATEGY_PROFILE_DEFAULTS, ...(input.options ?? {}) };
  const recentN = input.recentN ?? 30;

  // Scoped profiles may only ever see that scope's entries; shared profiles see everyone's.
  if (input.scope) {
    for (const e of input.entries) assertSameScope(input.scope, e.scope, "buildStrategyProfile(entries)");
    for (const x of input.executionOutcomes) assertSameScope(input.scope, x.scope, "buildStrategyProfile(executionOutcomes)");
  }

  const entries = input.entries
    .filter((e) => e.strategyKey === input.strategyKey)
    .filter((e) => input.mode === "all" || e.mode === input.mode)
    .filter((e) => isFiniteNumber(e.actualReturnPct) && e.reviewClassification !== "data_error")
    .sort((a, b) => closedTime(a) - closedTime(b));
  const returns = entries.map((e) => e.actualReturnPct as number);

  const overall = computePerformanceStats(entries);
  const recentEntries = entries.slice(-recentN);
  const recent = computePerformanceStats(recentEntries);

  const byRegime = statsByGroup(entries, (e) => e.regime || "unknown");
  const byVolRegime = statsByGroup(entries, (e) => volRegimeBucket(e.features[o.volFeatureKey]));
  const bySector = statsByGroup(entries, (e) => e.sector ?? "unknown");
  const byHoldingPeriod = statsByGroup(entries, (e) => holdingBucket(e.holdingDays));
  const byConfidenceBucket = statsByGroup(entries, (e) => confidenceBucket(e.confidence));
  const byLiquidity = statsByGroup(entries, (e) => liquidityScoreBucket(e.features[o.liquidityFeatureKey]));
  const bySignalStrength = statsByGroup(entries, (e) => signalStrengthBucket(e.signals));
  const byTimeOfDay = statsByGroup(entries, (e) => (isFiniteNumber(e.holdingDays) && e.holdingDays < 1 ? timeOfDayBucket(e.openedAt) : null));

  const calibration = calibrationFromObservations(input.strategyKey, entries.map((e) => ({ predicted: e.confidence, success: (e.actualReturnPct as number) > 0 })), input.now);

  const halfLife = estimateEdgeHalfLifeDays(entries, input.now, o.minTrades);
  const recentVsLongTermEdge = recent.expectancyPct !== null && overall.expectancyPct !== null && entries.length > recentN ? recent.expectancyPct - overall.expectancyPct : null;

  const ownSeries = input.correlations[input.strategyKey] ?? returns;
  const correlationToOtherStrategies: Record<string, number> = {};
  for (const [key, series] of Object.entries(input.correlations)) {
    if (key === input.strategyKey) continue;
    const c = pearson(ownSeries, series);
    if (c !== null && Math.min(ownSeries.length, series.length) >= 5) correlationToOtherStrategies[key] = c;
  }

  const slips = input.executionOutcomes.filter((x) => !x.missed && isFiniteNumber(x.actualSlippageBps)).map((x) => x.actualSlippageBps as number);
  const avgSlippageBps = mean(slips) ?? overall.avgSlippageBps;
  const realizedEdgePct = overall.expectancyPct;
  const dragPct = input.theoreticalEdgePct !== null && realizedEdgePct !== null
    ? input.theoreticalEdgePct - realizedEdgePct
    : avgSlippageBps !== null
      ? avgSlippageBps / 100
      : null;
  const executionDrag = { theoreticalEdgePct: input.theoreticalEdgePct, realizedEdgePct, dragPct };

  const degradation = assessDegradation(entries, recentN, o.minDegradationSamples);
  const stability = rollingStability(returns, o.rollingWindow);

  // ---- assessment ----------------------------------------------------------------------
  const n = overall.trades;
  const overconfident = flagOverconfident(calibration);
  const executionDestroyingEdge: boolean | null = dragPct === null
    ? null
    : input.theoreticalEdgePct !== null && input.theoreticalEdgePct > 0
      ? dragPct > 0.5 * input.theoreticalEdgePct
      : realizedEdgePct !== null && realizedEdgePct > 0
        ? dragPct > 0.5 * realizedEdgePct
        : dragPct > 0 && realizedEdgePct !== null && realizedEdgePct <= 0;

  const breakdowns = { regime: byRegime, "vol regime": byVolRegime, sector: bySector, "holding period": byHoldingPeriod, confidence: byConfidenceBucket, liquidity: byLiquidity, "signal strength": bySignalStrength, "time of day": byTimeOfDay };
  const workingWhere = describeBuckets(breakdowns, o.minBucketTrades, true);
  const failingWhere = describeBuckets(breakdowns, o.minBucketTrades, false);

  const edgeTrend: StrategyIntelligenceProfile["assessment"]["edgeTrend"] =
    degradation.trend === "deteriorating" ? "decaying" : degradation.trend === "improving" ? "improving" : degradation.trend === "stable" ? "stable" : "unknown";

  let stillWorking: boolean | null = null;
  let recommendedStatus: StrategyIntelligenceProfile["assessment"]["recommendedStatus"];
  let recommendedAllocationDelta = 0;
  const sentences: string[] = [];

  if (n < o.minTrades) {
    recommendedStatus = "insufficient_data";
    sentences.push(`${input.strategyKey} has only ${n} closed ${input.mode === "all" ? "" : input.mode + " "}trades, which is not enough to judge (need ${o.minTrades}).`);
  } else {
    const overallPositive = (overall.expectancyPct ?? 0) > 0;
    const recentPositive = (recent.expectancyPct ?? 0) > 0;
    stillWorking = overallPositive && recentPositive ? true : !recentPositive && recent.trades >= o.minTrades ? false : null;
    sentences.push(`Over ${n} trades ${input.strategyKey} shows an expectancy of ${pct(overall.expectancyPct)} per trade (win rate ${((overall.winRate ?? 0) * 100).toFixed(0)}%, profit factor ${overall.profitFactor === null ? "n/a" : overall.profitFactor.toFixed(2)}), and ${pct(recent.expectancyPct)} over the last ${recent.trades}.`);

    if (overall.maxDrawdownPct !== null && overall.maxDrawdownPct > o.pauseDrawdownPct) {
      recommendedStatus = "pause";
      recommendedAllocationDelta = -MAX_ALLOCATION_DELTA;
      sentences.push(`Its maximum drawdown of ${overall.maxDrawdownPct.toFixed(1)}% exceeds the ${o.pauseDrawdownPct}% pause threshold, so the recommendation is to pause it pending review.`);
    } else if (!recentPositive && recent.trades >= o.minTrades && degradation.trend === "deteriorating") {
      recommendedStatus = "move_to_shadow";
      recommendedAllocationDelta = -MAX_ALLOCATION_DELTA;
      sentences.push("Recent expectancy is negative and deteriorating against the earlier record, so the recommendation is to move it to shadow until the edge returns.");
    } else if (overallPositive && recentPositive && overconfident !== true && executionDestroyingEdge !== true && degradation.trend !== "deteriorating") {
      recommendedStatus = "increase";
      // Scale with evidence so a handful of recent winners cannot produce a large step.
      recommendedAllocationDelta = clamp(MAX_ALLOCATION_DELTA * Math.min(1, n / 100) * Math.min(1, recent.trades / recentN), 0.01, MAX_ALLOCATION_DELTA);
      sentences.push(`Both the long-term and recent records are positive, confidence is ${overconfident === null ? "not yet assessable" : "adequately calibrated"} and execution is not eroding the edge, so a modest allocation increase of ${(recommendedAllocationDelta * 100).toFixed(1)} points is suggested.`);
    } else {
      recommendedStatus = "keep_live";
      recommendedAllocationDelta = !recentPositive ? -0.02 : 0;
      sentences.push(!recentPositive
        ? "The long-term record is positive but the recent stretch is not, so the recommendation is to keep it live at a slightly reduced allocation and watch it."
        : "The recommendation is to keep it live at the current allocation.");
    }
    if (overconfident === true) sentences.push(`Confidence is overstated (overconfidence ratio ${calibration.overconfidenceRatio?.toFixed(2)}), so entry confidence for this strategy should be discounted.`);
    if (executionDestroyingEdge === true) sentences.push(`Execution drag of ${pct(dragPct)} is consuming more than half of the edge.`);
    if (halfLife !== null) sentences.push(`The edge appears to be decaying with an estimated half-life of ${halfLife.toFixed(0)} days.`);
    if (workingWhere.length > 0) sentences.push(`It works best in: ${workingWhere.slice(0, 4).join("; ")}.`);
    if (failingWhere.length > 0) sentences.push(`It struggles in: ${failingWhere.slice(0, 4).join("; ")}.`);
  }
  recommendedAllocationDelta = clamp(recommendedAllocationDelta, -MAX_ALLOCATION_DELTA, MAX_ALLOCATION_DELTA);

  return {
    strategyId: input.strategyId,
    strategyKey: input.strategyKey,
    scope: input.scope,
    mode: input.mode,
    overall,
    recent,
    byRegime,
    byVolRegime,
    bySector,
    byHoldingPeriod,
    byConfidenceBucket,
    byLiquidity,
    bySignalStrength,
    byTimeOfDay,
    calibration,
    signalDecay: { halfLifeDays: halfLife, recentVsLongTermEdge },
    correlationToOtherStrategies,
    executionDrag,
    degradation: { score: degradation.score, trend: degradation.trend, notes: degradation.notes },
    stability,
    assessment: {
      stillWorking,
      workingWhere,
      failingWhere,
      edgeTrend,
      overconfident,
      executionDestroyingEdge,
      recommendedAllocationDelta,
      recommendedStatus,
      plainEnglish: sentences.join(" "),
    },
    updatedAt: input.now,
  };
}

export function emptyStrategyProfile(strategyId: string, strategyKey: string, scope: TenantScope | null, mode: StrategyIntelligenceProfile["mode"], now: IsoTimestamp): StrategyIntelligenceProfile {
  return buildStrategyProfile({ strategyId, strategyKey, scope, mode, entries: [], executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now });
}

// ---------------------------------------------------------------------------------------------
// Signal Intelligence Profile
// ---------------------------------------------------------------------------------------------

export type ReturnHorizon = "1d" | "5d" | "20d";
export const RETURN_HORIZON_DAYS: Readonly<Record<ReturnHorizon, number>> = Object.freeze({ "1d": 1, "5d": 5, "20d": 20 });

export interface SignalObservation {
  value: number;
  /** Realised forward return (percent) at the signal's own horizon. */
  realizedReturnPct?: number | null;
  /** Realised forward returns at several horizons, used for decay estimation. */
  realizedReturns?: Partial<Record<ReturnHorizon, number>>;
  regime: string;
  asOf: IsoTimestamp;
}

export interface SignalProfileOptions {
  recentN?: number;
  currentWeight?: number;
  weightBounds?: { min: number; max: number };
  executionSensitivity?: number | null;
  /** |value| above this counts as a positive (long) call. */
  positiveThreshold?: number;
  clusterThreshold?: number;
  minRegimeSamples?: number;
}

export function primaryReturn(o: SignalObservation): number | null {
  if (isFiniteNumber(o.realizedReturnPct)) return o.realizedReturnPct;
  const r = o.realizedReturns;
  if (!r) return null;
  for (const h of ["5d", "1d", "20d"] as const) if (isFiniteNumber(r[h])) return r[h] as number;
  return null;
}

/** Greedy single-linkage clustering: keys are visited in sorted order; each unassigned key seeds a cluster named after itself. */
export function clusterSignals(corrMatrix: Record<string, Record<string, number>>, threshold = 0.7): Record<string, string> {
  const keys = Object.keys(corrMatrix).sort();
  const assignment: Record<string, string> = {};
  for (const seed of keys) {
    if (assignment[seed]) continue;
    assignment[seed] = seed;
    const queue = [seed];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const other of keys) {
        if (assignment[other]) continue;
        const c = corrMatrix[cur]?.[other] ?? corrMatrix[other]?.[cur];
        if (isFiniteNumber(c) && Math.abs(c) > threshold) {
          assignment[other] = seed;
          queue.push(other);
        }
      }
    }
  }
  return assignment;
}

export function correlationMatrix(series: Record<string, number[]>): Record<string, Record<string, number>> {
  const keys = Object.keys(series).sort();
  const out: Record<string, Record<string, number>> = {};
  for (const a of keys) {
    out[a] = { [a]: 1 };
    for (const b of keys) {
      if (a === b) continue;
      const c = pearson(series[a] as number[], series[b] as number[]);
      if (c !== null) (out[a] as Record<string, number>)[b] = c;
    }
  }
  return out;
}

/** Half-life from IC at increasing horizons: fit log(IC) = a - lambda * h over horizons with positive IC. */
export function icDecayHalfLife(icByHorizon: Partial<Record<ReturnHorizon, number | null>>): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const h of Object.keys(RETURN_HORIZON_DAYS) as ReturnHorizon[]) {
    const ic = icByHorizon[h];
    if (isFiniteNumber(ic) && ic > 0) {
      xs.push(RETURN_HORIZON_DAYS[h]);
      ys.push(Math.log(ic));
    }
  }
  if (xs.length < 2) return null;
  const fit = linearFit(xs, ys);
  if (!fit || fit.slope >= -1e-9) return null;
  return Math.log(2) / -fit.slope;
}

export function buildSignalProfile(signalKey: string, observations: readonly SignalObservation[], otherSignals: Record<string, number[]>, now: IsoTimestamp, options: SignalProfileOptions = {}): SignalIntelligenceProfile {
  const recentN = options.recentN ?? 50;
  const positiveThreshold = options.positiveThreshold ?? 0.2;
  const minRegimeSamples = options.minRegimeSamples ?? 10;
  const sorted = [...observations].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  const paired = sorted.map((o) => ({ o, r: primaryReturn(o) })).filter((x): x is { o: SignalObservation; r: number } => isFiniteNumber(x.r) && isFiniteNumber(x.o.value));
  const values = paired.map((p) => p.o.value);
  const rets = paired.map((p) => p.r);

  const historical = spearman(values, rets);
  const recentPairs = paired.slice(-recentN);
  const recentIc = recentPairs.length >= 10 ? spearman(recentPairs.map((p) => p.o.value), recentPairs.map((p) => p.r)) : null;

  const regimeDependence: Record<string, number> = {};
  const byRegime = groupBy(paired, (p) => p.o.regime || null);
  for (const regime of Object.keys(byRegime).sort()) {
    const g = byRegime[regime] as typeof paired;
    if (g.length < minRegimeSamples) continue;
    const ic = spearman(g.map((p) => p.o.value), g.map((p) => p.r));
    if (ic !== null) regimeDependence[regime] = ic;
  }

  const allSeries: Record<string, number[]> = { ...otherSignals, [signalKey]: sorted.map((o) => o.value) };
  const matrix = correlationMatrix(allSeries);
  const correlationWithOtherSignals: Record<string, number> = {};
  for (const [k, c] of Object.entries(matrix[signalKey] ?? {})) if (k !== signalKey) correlationWithOtherSignals[k] = c;
  const cluster = clusterSignals(matrix, options.clusterThreshold ?? 0.7)[signalKey] ?? signalKey;

  const actualPos = paired.filter((p) => p.r > 0);
  const actualNeg = paired.filter((p) => p.r <= 0);
  const falsePositiveRate = actualNeg.length === 0 ? null : actualNeg.filter((p) => p.o.value > positiveThreshold).length / actualNeg.length;
  const falseNegativeRate = actualPos.length === 0 ? null : actualPos.filter((p) => p.o.value <= positiveThreshold).length / actualPos.length;

  const icByHorizon: Partial<Record<ReturnHorizon, number | null>> = {};
  for (const h of Object.keys(RETURN_HORIZON_DAYS) as ReturnHorizon[]) {
    const withH = sorted.filter((o) => isFiniteNumber(o.realizedReturns?.[h]));
    if (withH.length >= 10) icByHorizon[h] = spearman(withH.map((o) => o.value), withH.map((o) => o.realizedReturns?.[h] as number));
  }
  const decayHalfLifeDays = icDecayHalfLife(icByHorizon);

  return {
    signalKey,
    historicalPredictiveValue: historical,
    recentPredictiveValue: recentIc,
    regimeDependence,
    correlationWithOtherSignals,
    cluster,
    falsePositiveRate,
    falseNegativeRate,
    decayHalfLifeDays,
    executionSensitivity: options.executionSensitivity ?? null,
    sampleSize: paired.length,
    weightBounds: options.weightBounds ?? { min: 0, max: 2 },
    currentWeight: options.currentWeight ?? 1,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------------------------
// Model & agent profiles
// ---------------------------------------------------------------------------------------------

export interface ModelPrediction {
  predicted: number;
  realized?: number | null;
  correct: boolean;
  latencyMs: number | null;
  costUsd: number;
  regime: string;
  symbol: string;
  strategy: string;
  /** True when the call failed, timed out or produced invalid output (counted in failureRate; excluded from accuracy). */
  failed?: boolean;
}

export interface ModelProfileOptions {
  routingWeight?: number;
  /** Accuracy of the cheaper/baseline alternative; valueAdded = accuracy - baseline. */
  baselineAccuracy?: number | null;
}

function accuracyBy(preds: ModelPrediction[], keyOf: (p: ModelPrediction) => string): Record<string, number> {
  const out: Record<string, number> = {};
  const groups = groupBy(preds, keyOf);
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k] as ModelPrediction[];
    out[k] = g.filter((p) => p.correct).length / g.length;
  }
  return out;
}

export function buildModelProfile(modelName: string, modelVersion: string, predictions: readonly ModelPrediction[], agreements: Record<string, number>, now: IsoTimestamp, options: ModelProfileOptions = {}): ModelIntelligenceProfile {
  const ok = predictions.filter((p) => !p.failed);
  const accuracy = ok.length === 0 ? null : ok.filter((p) => p.correct).length / ok.length;
  const baseline = options.baselineAccuracy ?? null;
  return {
    modelName,
    modelVersion,
    accuracy,
    calibration: calibrationFromObservations(`${modelName}@${modelVersion}`, ok.map((p) => ({ predicted: p.predicted, success: p.correct })), now),
    byRegime: accuracyBy(ok, (p) => p.regime),
    byAsset: accuracyBy(ok, (p) => p.symbol),
    byStrategy: accuracyBy(ok, (p) => p.strategy),
    latencyMsP50: median(predictions.map((p) => p.latencyMs).filter(isFiniteNumber)),
    failureRate: predictions.length === 0 ? null : predictions.filter((p) => p.failed).length / predictions.length,
    costUsd: predictions.reduce((a, p) => a + (isFiniteNumber(p.costUsd) ? p.costUsd : 0), 0),
    valueAdded: accuracy !== null && baseline !== null ? accuracy - baseline : null,
    agreementWithOthers: { ...agreements },
    routingWeight: options.routingWeight ?? 1,
    updatedAt: now,
  };
}

export interface AgentDecisionObservation {
  /** "for" endorses the final action, "against" opposes it (a veto or reject), "abstain" no view. */
  agentVote: "for" | "against" | "abstain";
  finalOutcomeSuccess: boolean;
  includedInDecision: boolean;
  confidence: number;
}

export function buildAgentProfile(agentName: string, decisions: readonly AgentDecisionObservation[], now: IsoTimestamp, options: { influenceWeight?: number; minGroup?: number } = {}): AgentIntelligenceProfile {
  const minGroup = options.minGroup ?? 5;
  const agreed = decisions.filter((d) => d.agentVote === "for");
  const disagreed = decisions.filter((d) => d.agentVote === "against");
  const hit = (xs: AgentDecisionObservation[]) => xs.filter((d) => d.finalOutcomeSuccess).length / xs.length;
  const valueAdded = agreed.length >= minGroup && disagreed.length >= minGroup ? hit(agreed) - hit(disagreed) : null;
  // A veto was "right" when the trade it opposed went on to fail.
  const vetoAccuracy = disagreed.length >= minGroup ? disagreed.filter((d) => !d.finalOutcomeSuccess).length / disagreed.length : null;
  const calibrationObs = decisions
    .filter((d) => d.agentVote !== "abstain")
    .map((d) => ({ predicted: d.confidence, success: d.agentVote === "for" ? d.finalOutcomeSuccess : !d.finalOutcomeSuccess }));
  return {
    agentName,
    decisionsInfluenced: decisions.filter((d) => d.includedInDecision).length,
    valueAdded,
    vetoAccuracy,
    calibration: calibrationFromObservations(agentName, calibrationObs, now),
    influenceWeight: options.influenceWeight ?? 1,
    updatedAt: now,
  };
}

