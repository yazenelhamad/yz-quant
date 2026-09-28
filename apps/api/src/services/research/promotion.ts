import type { BacktestResult, StrategyIntelligenceProfile, StrategyStage, WalkForwardResult } from "@yz/core";
import { StrategyValidationPipeline, type PipelineInput, type PromotionThresholds, type PromotionVerdict } from "@yz/core";
import type { LearningRepos } from "../learning/repos.js";
import { backtestResultView, type StoredBacktestConfig } from "./backtests.js";

export const PROMOTION_THRESHOLDS: PromotionThresholds = Object.freeze({
  minTrades: 30,
  minSharpeOos: 0.8,
  maxDrawdownPct: 20,
  maxOverfittingScore: 0.5,
  minProfitFactor: 1.2,
  minShadowTrades: 20,
  minShadowSharpe: 0.5,
  minWalkForwardFolds: 2,
});

export interface PromotionEvaluation {
  strategyKey: string;
  currentStage: StrategyStage;
  verdict: PromotionVerdict;
  evidenceIds: { inSample: string | null; outOfSample: string | null; walkForward: string | null };
  shadow: { trades: number; sharpe: number | null } | null;
  thresholds: PromotionThresholds;
}

/**
 * Promotion evaluation over the latest completed backtest evidence and the shared shadow profile.
 * The pipeline never grants live; limited_live additionally needs `humanReviewApproved`, which is
 * only ever set by the admin stage route.
 */
export async function evaluatePromotion(lr: LearningRepos, strategyKey: string, opts: { humanReviewApproved?: boolean } = {}): Promise<PromotionEvaluation> {
  const strategy = await lr.catalog.byKey(strategyKey);
  if (!strategy) throw new Error(`unknown strategy ${strategyKey}`);
  const rows = await lr.backtests.list({ strategyKey, limit: 200 });
  const completed = rows.filter((r) => (r.config as StoredBacktestConfig).status === "completed");
  const latest = (kind: string) => completed.find((r) => r.kind === kind);
  let inSample: BacktestResult | null = null;
  let outOfSample: BacktestResult | null = null;
  let walkForwardResult: WalkForwardResult | null = null;
  const ids = { inSample: null as string | null, outOfSample: null as string | null, walkForward: null as string | null };

  const isRow = latest("in_sample");
  if (isRow) { inSample = backtestResultView(isRow).result; ids.inSample = isRow.id; }
  const oosRow = latest("out_of_sample");
  if (oosRow) {
    const v = backtestResultView(oosRow);
    outOfSample = v.result;
    ids.outOfSample = oosRow.id;
    if (!inSample && v.outOfSample) { inSample = { ...v.outOfSample.inSample, trades: [], equityCurve: [] } as BacktestResult; ids.inSample = oosRow.id; }
  }
  const wfRow = latest("walk_forward");
  if (wfRow) { walkForwardResult = backtestResultView(wfRow).walkForward; ids.walkForward = wfRow.id; }

  const shadowRow = await lr.strategyProfiles.get(strategy.id, null, "shadow");
  const shadowProfile = shadowRow ? (shadowRow.profile as StrategyIntelligenceProfile) : null;
  const shadow = shadowProfile ? { trades: shadowProfile.overall.trades, sharpe: shadowProfile.overall.sharpe } : null;

  const input: PipelineInput = { currentStage: strategy.stage as StrategyStage, inSample, outOfSample, walkForward: walkForwardResult, shadow, humanReviewApproved: opts.humanReviewApproved === true };
  const verdict = new StrategyValidationPipeline(PROMOTION_THRESHOLDS).evaluate(input);
  return { strategyKey, currentStage: strategy.stage as StrategyStage, verdict, evidenceIds: ids, shadow, thresholds: PROMOTION_THRESHOLDS };
}
