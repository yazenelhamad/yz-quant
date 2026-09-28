/**
 * Strategy validation pipeline: decides how far along the lifecycle
 * research -> backtest -> out_of_sample -> walk_forward -> live_shadow -> limited_live -> live
 * a strategy may be promoted given its validation evidence.
 *
 * The pipeline never grants "live". "limited_live" additionally requires a human review flag
 * on top of shadow evidence, and the step from limited_live to live is always a human
 * decision recorded outside this module.
 */
import type { BacktestResult, StrategyStage, WalkForwardResult } from "../types/index.js";
import { STRATEGY_STAGE_ORDER } from "../types/index.js";

export interface PromotionThresholds {
  /** Minimum closed trades in each backtest-based evidence set. */
  minTrades: number;
  /** Minimum Sharpe out of sample (also applied to the walk-forward aggregate). */
  minSharpeOos: number;
  /** Maximum tolerated drawdown, in percent. */
  maxDrawdownPct: number;
  /** Maximum walk-forward overfitting score (0..1). */
  maxOverfittingScore: number;
  minProfitFactor: number;
  /** Optional in-sample Sharpe floor (defaults to 0). */
  minSharpeInSample?: number;
  /** Shadow-trading requirements for live_shadow -> limited_live. */
  minShadowTrades?: number;
  minShadowSharpe?: number;
  /** Minimum walk-forward folds (defaults to 2). */
  minWalkForwardFolds?: number;
}

export interface ShadowEvidence {
  trades: number;
  sharpe: number | null;
}

export interface PipelineInput {
  currentStage: StrategyStage;
  inSample?: BacktestResult | null;
  outOfSample?: BacktestResult | null;
  walkForward?: WalkForwardResult | null;
  shadow?: ShadowEvidence | null;
  /** Set only by an authenticated human reviewer; required for limited_live. */
  humanReviewApproved?: boolean;
}

export interface PromotionVerdict {
  canPromoteTo: StrategyStage;
  blockers: string[];
  evidence: Record<string, number>;
}

/** Promotable stages in order; "live" is intentionally absent. */
const PROMOTABLE: readonly StrategyStage[] = ["research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live"];


export class StrategyValidationPipeline {
  constructor(readonly thresholds: PromotionThresholds) {}

  /** Blockers preventing promotion INTO `stage`, given the evidence. Empty = gate passes. */
  gate(stage: StrategyStage, input: PipelineInput): string[] {
    const t = this.thresholds;
    const blockers: string[] = [];
    const checkResult = (label: string, r: BacktestResult | null | undefined, minSharpe: number | null): void => {
      if (!r) {
        blockers.push(`${label}: no result`);
        return;
      }
      const m = r.metrics;
      if (m.tradeCount < t.minTrades) blockers.push(`${label}: trades ${m.tradeCount} < ${t.minTrades}`);
      if (minSharpe !== null && (m.sharpe === null || m.sharpe < minSharpe)) blockers.push(`${label}: sharpe ${fmt(m.sharpe)} < ${minSharpe}`);
      if (m.maxDrawdownPct > t.maxDrawdownPct) blockers.push(`${label}: max drawdown ${m.maxDrawdownPct.toFixed(2)}% > ${t.maxDrawdownPct}%`);
      if (m.profitFactor === null || m.profitFactor < t.minProfitFactor) blockers.push(`${label}: profit factor ${fmt(m.profitFactor)} < ${t.minProfitFactor}`);
    };
    switch (stage) {
      case "research":
        return [];
      case "backtest":
        checkResult("in_sample", input.inSample, t.minSharpeInSample ?? 0);
        return blockers;
      case "out_of_sample":
        checkResult("out_of_sample", input.outOfSample, t.minSharpeOos);
        return blockers;
      case "walk_forward": {
        const wf = input.walkForward;
        if (!wf) return ["walk_forward: no result"];
        const minFolds = t.minWalkForwardFolds ?? 2;
        if (wf.folds.length < minFolds) blockers.push(`walk_forward: folds ${wf.folds.length} < ${minFolds}`);
        const agg = wf.aggregate;
        if (agg.tradeCount < t.minTrades) blockers.push(`walk_forward: trades ${agg.tradeCount} < ${t.minTrades}`);
        if (agg.sharpe === null || agg.sharpe < t.minSharpeOos) blockers.push(`walk_forward: aggregate sharpe ${fmt(agg.sharpe)} < ${t.minSharpeOos}`);
        if (agg.maxDrawdownPct > t.maxDrawdownPct) blockers.push(`walk_forward: max drawdown ${agg.maxDrawdownPct.toFixed(2)}% > ${t.maxDrawdownPct}%`);
        if (agg.profitFactor === null || agg.profitFactor < t.minProfitFactor) blockers.push(`walk_forward: profit factor ${fmt(agg.profitFactor)} < ${t.minProfitFactor}`);
        if (wf.overfittingScore === null || wf.overfittingScore > t.maxOverfittingScore) {
          blockers.push(`walk_forward: overfitting score ${fmt(wf.overfittingScore)} > ${t.maxOverfittingScore}`);
        }
        return blockers;
      }
      case "live_shadow":
        // Shadow requires the complete backtest evidence chain to hold simultaneously.
        return [...this.gate("backtest", input), ...this.gate("out_of_sample", input), ...this.gate("walk_forward", input)];
      case "limited_live": {
        const s = input.shadow;
        const minShadowTrades = t.minShadowTrades ?? t.minTrades;
        const minShadowSharpe = t.minShadowSharpe ?? t.minSharpeOos;
        if (!s) blockers.push("shadow: no shadow evidence");
        else {
          if (s.trades < minShadowTrades) blockers.push(`shadow: trades ${s.trades} < ${minShadowTrades}`);
          if (s.sharpe === null || s.sharpe < minShadowSharpe) blockers.push(`shadow: sharpe ${fmt(s.sharpe)} < ${minShadowSharpe}`);
        }
        if (input.humanReviewApproved !== true) blockers.push("limited_live requires human review approval");
        return blockers;
      }
      case "live":
        return ["promotion to live is never granted by the pipeline; it requires human review"];
      case "paused":
      case "retired":
        return [`${stage} is not a promotion target`];
      default:
        return ["unknown stage"];
    }
  }

  evaluate(input: PipelineInput): PromotionVerdict {
    const evidence = collectEvidence(input);
    const current = input.currentStage;
    if (current === "paused" || current === "retired") {
      return { canPromoteTo: current, blockers: [`strategy is ${current}; reactivation requires human review`], evidence };
    }
    if (current === "live") {
      return { canPromoteTo: "live", blockers: ["already live; no further promotion exists"], evidence };
    }
    const currentIdx = STRATEGY_STAGE_ORDER.indexOf(current);
    let reached: StrategyStage = current;
    let blockers: string[] = [];
    for (let i = 0; i < PROMOTABLE.length; i++) {
      const stage = PROMOTABLE[i] as StrategyStage;
      const idx = STRATEGY_STAGE_ORDER.indexOf(stage);
      if (idx <= currentIdx) continue;
      const failures = this.gate(stage, input);
      if (failures.length > 0) {
        blockers = failures;
        break;
      }
      reached = stage;
    }
    if (reached === "limited_live" && blockers.length === 0) {
      blockers = ["promotion to live is never granted by the pipeline; it requires human review"];
    }
    return { canPromoteTo: reached, blockers, evidence };
  }
}

function fmt(x: number | null | undefined): string {
  return x === null || x === undefined ? "n/a" : x.toFixed(3);
}

function collectEvidence(input: PipelineInput): Record<string, number> {
  const e: Record<string, number> = {};
  // Null metrics are omitted rather than encoded as NaN so the evidence stays serialisable.
  const set = (key: string, value: number | null | undefined): void => {
    if (value !== null && value !== undefined && Number.isFinite(value)) e[key] = value;
  };
  const put = (prefix: string, r: BacktestResult | null | undefined): void => {
    if (!r) return;
    set(`${prefix}.trades`, r.metrics.tradeCount);
    set(`${prefix}.sharpe`, r.metrics.sharpe);
    set(`${prefix}.maxDrawdownPct`, r.metrics.maxDrawdownPct);
    set(`${prefix}.profitFactor`, r.metrics.profitFactor);
    set(`${prefix}.netReturnPct`, r.metrics.netReturnPct);
  };
  put("inSample", input.inSample);
  put("outOfSample", input.outOfSample);
  if (input.walkForward) {
    set("walkForward.folds", input.walkForward.folds.length);
    set("walkForward.sharpe", input.walkForward.aggregate.sharpe);
    set("walkForward.maxDrawdownPct", input.walkForward.aggregate.maxDrawdownPct);
    set("walkForward.profitFactor", input.walkForward.aggregate.profitFactor);
    set("walkForward.trades", input.walkForward.aggregate.tradeCount);
    set("walkForward.overfittingScore", input.walkForward.overfittingScore);
    set("walkForward.parameterStability", input.walkForward.parameterStability);
  }
  if (input.shadow) {
    set("shadow.trades", input.shadow.trades);
    set("shadow.sharpe", input.shadow.sharpe);
  }
  e["humanReviewApproved"] = input.humanReviewApproved === true ? 1 : 0;
  return e;
}

/** Functional convenience wrapper around the class. */
export function evaluatePromotion(thresholds: PromotionThresholds, input: PipelineInput): PromotionVerdict {
  return new StrategyValidationPipeline(thresholds).evaluate(input);
}
