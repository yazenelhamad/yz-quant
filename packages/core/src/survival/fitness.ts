import type { PerformanceStats, StrategyIntelligenceProfile, StrategyStage } from "../types/index.js";
import { clamp, isFiniteNumber } from "../learning/math.js";
import { STRATEGY_FITNESS_DEFAULTS, type DarwinianAllocation, type FitnessVerdict, type StrategyFitness, type StrategyFitnessInput, type StrategyFitnessOptions } from "./types.js";

export const STRATEGY_FITNESS_VERSION = "fitness-1.0.0";

const LIVE: ReadonlySet<StrategyStage> = new Set<StrategyStage>(["limited_live", "live"]);
const SHADOW: ReadonlySet<StrategyStage> = new Set<StrategyStage>(["live_shadow", "walk_forward", "out_of_sample"]);

function piece(x: number | null, pts: [number, number][], fallback: number): number {
  if (!isFiniteNumber(x)) return fallback;
  if (x <= (pts[0] as [number, number])[0]) return (pts[0] as [number, number])[1];
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1] as [number, number];
    const [x1, y1] = pts[i] as [number, number];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return (pts[pts.length - 1] as [number, number])[1];
}

/** 0..100 from realised expectancy, recent expectancy, profit factor, drawdown and calibration. */
export function strategyFitnessScore(overall: PerformanceStats, recent: PerformanceStats, overconfident: boolean | null, deteriorating: boolean): number {
  const e = piece(overall.expectancyPct, [[-1, 0], [0, 40], [1.5, 100]], 30);
  const r = piece(recent.trades > 0 ? recent.expectancyPct : null, [[-1, 0], [0, 40], [1.5, 100]], e);
  const pf = piece(overall.profitFactor, [[0.6, 0], [1, 40], [1.5, 80], [2, 100]], 30);
  const dd = piece(overall.maxDrawdownPct, [[0, 100], [15, 0]], 60);
  let s = 0.3 * e + 0.3 * r + 0.25 * pf + 0.15 * dd;
  if (overconfident === true) s -= 8;
  if (deteriorating) s -= 10;
  return Math.round(clamp(s, 0, 100));
}

/**
 * Judge one strategy on ITS record for this account. Live evidence wins when it exists; a
 * shadow record can argue for revival but never for live scale. Verdicts:
 *  - cull: a live strategy that loses money with enough evidence dies (recommended stage live_shadow, allocation 0);
 *  - probation: positive overall but failing recently or decaying: allocation halved;
 *  - scale: earning on both windows with a healthy profit factor: allocation up one step;
 *  - keep: earning but not convincingly; hold;
 *  - revive: a shadow strategy whose record clears the bar (recommended stage limited_live, for the validation pipeline);
 *  - incubating: not enough evidence either way.
 */
export function assessStrategyFitness(input: StrategyFitnessInput): StrategyFitness {
  const o: StrategyFitnessOptions = { ...STRATEGY_FITNESS_DEFAULTS, ...(input.options ?? {}) };
  const reasons: string[] = [];
  const liveStage = LIVE.has(input.stage);
  const live = input.live;
  const shadow = input.shadow;
  const useLive = !!live && live.overall.trades >= o.minTrades;
  const useShadow = !useLive && !!shadow && shadow.overall.trades >= o.minTrades;
  const p = useLive ? live! : useShadow ? shadow! : null;
  const evidence: StrategyFitness["evidence"] = useLive ? "live" : useShadow ? "shadow" : "none";
  const overall = p?.overall ?? { trades: live?.overall.trades ?? shadow?.overall.trades ?? 0 } as PerformanceStats;
  const recent = p?.recent ?? overall;
  const deteriorating = p?.degradation.trend === "deteriorating";
  const score = p ? strategyFitnessScore(p.overall, p.recent, p.assessment.overconfident, deteriorating) : 0;
  const cur = clamp(isFiniteNumber(input.capitalAllocation) ? input.capitalAllocation : 0, 0, 1);

  let verdict: FitnessVerdict;
  let target = cur;
  let recommendedStage: StrategyStage | null = null;

  if (!p) {
    verdict = "incubating";
    reasons.push(`${overall.trades} trade(s): fewer than the ${o.minTrades} needed to judge`);
  } else {
    const exp = p.overall.expectancyPct;
    const rexp = p.recent.expectancyPct;
    const pf = p.overall.profitFactor;
    const recentEnough = p.recent.trades >= Math.min(o.minTrades, 10);
    const losing = !isFiniteNumber(exp) || exp <= 0 || (isFiniteNumber(pf) && pf < o.cullProfitFactor);
    const recentLosing = recentEnough && isFiniteNumber(rexp) && rexp <= 0;
    const tooDeep = isFiniteNumber(p.overall.maxDrawdownPct) && p.overall.maxDrawdownPct > o.cullDrawdownPct;
    if (useLive && liveStage && (losing || tooDeep || (deteriorating && recentLosing))) {
      verdict = "cull";
      target = 0;
      recommendedStage = "live_shadow";
      if (losing) reasons.push(`losing money live: expectancy ${fmt(exp)}%/trade, profit factor ${fmt(pf)} over ${p.overall.trades} trades`);
      if (tooDeep) reasons.push(`max drawdown ${fmt(p.overall.maxDrawdownPct)}% exceeds the ${o.cullDrawdownPct}% cull line`);
      if (deteriorating && recentLosing) reasons.push(`edge deteriorating (degradation ${p.degradation.score.toFixed(2)}) and recent expectancy ${fmt(rexp)}%`);
      reasons.push("it is demoted to shadow: it may earn its way back with a positive shadow record");
    } else if (useLive && liveStage && (recentLosing || p.assessment.edgeTrend === "decaying" || p.assessment.executionDestroyingEdge === true)) {
      verdict = "probation";
      target = Math.max(o.minAllocation, cur * 0.5);
      if (recentLosing) reasons.push(`recent expectancy ${fmt(rexp)}%/trade over ${p.recent.trades} trades`);
      if (p.assessment.edgeTrend === "decaying") reasons.push("edge trend decaying");
      if (p.assessment.executionDestroyingEdge === true) reasons.push("execution costs are eating the edge");
    } else if (useLive && liveStage && isFiniteNumber(exp) && exp > 0 && isFiniteNumber(rexp) && rexp > 0 && (pf ?? 0) >= o.scaleProfitFactor && p.assessment.overconfident !== true && !deteriorating) {
      verdict = "scale";
      target = Math.min(1, cur + o.maxStep);
      reasons.push(`earning on both windows: expectancy ${fmt(exp)}% (recent ${fmt(rexp)}%), profit factor ${fmt(pf)}`);
    } else if (useLive && liveStage) {
      verdict = "keep";
      reasons.push(`positive but not yet convincing: expectancy ${fmt(exp)}%, profit factor ${fmt(pf)}`);
    } else if (!liveStage && SHADOW.has(input.stage) && isFiniteNumber(exp) && exp > 0 && isFiniteNumber(rexp) && rexp > 0 && (pf ?? 0) >= o.reviveProfitFactor && !tooDeep) {
      verdict = "revive";
      recommendedStage = "limited_live";
      reasons.push(`${evidence} record clears the bar: expectancy ${fmt(exp)}%/trade, recent ${fmt(rexp)}%, profit factor ${fmt(pf)} over ${p.overall.trades} trades; promotion goes through the validation pipeline`);
    } else if (!liveStage) {
      verdict = "incubating";
      reasons.push(`${evidence} record does not yet earn revival: expectancy ${fmt(exp)}%, profit factor ${fmt(pf)}`);
    } else {
      verdict = "keep";
      reasons.push("live stage judged on a shadow record only: hold until live evidence accrues");
    }
  }

  return {
    strategyId: input.strategyId, strategyKey: input.strategyKey, stage: input.stage, score, verdict, evidence,
    trades: overall.trades, expectancyPct: overall.expectancyPct ?? null, recentExpectancyPct: recent.expectancyPct ?? null, profitFactor: overall.profitFactor ?? null, maxDrawdownPct: overall.maxDrawdownPct ?? null,
    currentAllocation: cur, targetAllocation: clamp(target, 0, 1), recommendedStage, reasons, assessedAt: input.now,
  };
}

/**
 * Tournament allocation: culled strategies go to zero; survivors with a verdict share the budget
 * in proportion to fitness (scale > keep > probation), each moving at most `maxStep` from its
 * current allocation. Incubating and revive strategies keep their current allocation (they are
 * not live). The sum of `next` never exceeds `budget`.
 */
export function darwinianAllocation(fitnesses: readonly StrategyFitness[], opts: { budget?: number; maxStep?: number; minAllocation?: number } = {}): DarwinianAllocation[] {
  const budget = clamp(opts.budget ?? 1, 0, 1);
  const maxStep = opts.maxStep ?? STRATEGY_FITNESS_DEFAULTS.maxStep;
  const floor = opts.minAllocation ?? STRATEGY_FITNESS_DEFAULTS.minAllocation;
  const weightOf = (f: StrategyFitness): number => f.verdict === "scale" ? f.score : f.verdict === "keep" ? f.score * 0.8 : f.verdict === "probation" ? f.score * 0.4 : 0;
  const contenders = fitnesses.filter((f) => weightOf(f) > 0);
  const totalW = contenders.reduce((s, f) => s + weightOf(f), 0);
  const out: DarwinianAllocation[] = [];
  let used = 0;
  for (const f of fitnesses) {
    let target: number;
    if (f.verdict === "cull") target = 0;
    else if (f.verdict === "incubating" || f.verdict === "revive") target = f.currentAllocation;
    else target = totalW > 0 ? budget * (weightOf(f) / totalW) : f.currentAllocation;
    // Blend the tournament share with the verdict's own target so a single strong strategy cannot swallow the book in one step.
    if (f.verdict === "scale" || f.verdict === "keep" || f.verdict === "probation") target = 0.5 * target + 0.5 * f.targetAllocation;
    let next = clamp(f.currentAllocation + clamp(target - f.currentAllocation, -maxStep, maxStep), 0, 1);
    if (f.verdict !== "cull" && f.verdict !== "incubating" && f.verdict !== "revive" && next < floor) next = Math.min(floor, f.currentAllocation + maxStep);
    if (f.verdict === "cull") next = Math.max(0, f.currentAllocation - maxStep);
    if (used + next > budget) next = Math.max(0, budget - used);
    used += next;
    out.push({ strategyId: f.strategyId, strategyKey: f.strategyKey, verdict: f.verdict, current: f.currentAllocation, target: clamp(target, 0, 1), next: round4(next), delta: round4(next - f.currentAllocation) });
  }
  return out;
}

function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }
function fmt(x: number | null | undefined): string { return isFiniteNumber(x) ? x.toFixed(2) : "n/a"; }
