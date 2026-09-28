import type { ExpectationsRecord, VariantView } from "../types/index.js";
import { clamp, clamp01, isNum, mean, round, sign } from "./math.js";

/**
 * Analyst quality control for the variant engine itself. If the engine is not adding value over
 * consensus, its influence on the thesis is reduced (never below 0.25, never above 1).
 */

export interface ScoredView {
  view: VariantView;
  /** Realised return over the view's horizon, in percent. Null when unresolved. */
  outcomeReturnPct: number | null;
  /** Whether the variant view turned out correct. Null when unresolved. */
  outcomeCorrect: boolean | null;
}

export interface ScenarioCalibration {
  /** Realised frequency of each scenario (by nearest priceImpactPct) vs the average probability assigned. */
  bull: { assigned: number | null; realised: number | null };
  base: { assigned: number | null; realised: number | null };
  bear: { assigned: number | null; realised: number | null };
  /** 1 − mean Brier score across resolved views; null when none. */
  score: number | null;
}

export interface VariantEngineScorecard {
  sampleSize: { views: number; resolvedViews: number; expectations: number; resolvedExpectations: number };
  forecastAccuracy: number | null;
  consensusBeatingAccuracy: number | null;
  catalystPredictionAccuracy: number | null;
  scenarioCalibration: ScenarioCalibration;
  reactionErrorPct: number | null;
  falseVariantRate: number | null;
  missedVariantRate: number | null;
  influenceWeight: number;
  notes: string[];
}

function nearestScenario(scenarios: VariantView["scenarios"], ret: number): VariantView["scenarios"][number] | null {
  let best: VariantView["scenarios"][number] | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of scenarios) {
    const d = Math.abs(s.priceImpactPct - ret);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

export function variantEngineScorecard(views: readonly ScoredView[], expectations: readonly ExpectationsRecord[], metric = "eps", materialMovePct = 10): VariantEngineScorecard {
  const notes: string[] = [];
  const resolvedViews = views.filter((v) => v.outcomeCorrect !== null || isNum(v.outcomeReturnPct));

  // Forecast accuracy: share of views with a known outcome that were correct.
  const judged = views.filter((v) => v.outcomeCorrect !== null);
  const forecastAccuracy = judged.length > 0 ? round(judged.filter((v) => v.outcomeCorrect === true).length / judged.length) : null;

  // Consensus-beating accuracy and catalyst direction accuracy from resolved expectations records.
  let beat = 0;
  let compared = 0;
  let dirRight = 0;
  let dirCompared = 0;
  let resolvedExpectations = 0;
  for (const r of expectations) {
    if (!r.actualResult) continue;
    resolvedExpectations++;
    const actual = r.actualResult[metric];
    const cons = r.consensus[metric];
    const ours = r.systemForecast[metric];
    if (isNum(actual) && isNum(cons) && isNum(ours)) {
      compared++;
      if (Math.abs(ours - actual) < Math.abs(cons - actual)) beat++;
      if (isNum(r.reactionPct) && ours !== cons) {
        dirCompared++;
        if (sign(ours - cons) === sign(r.reactionPct)) dirRight++;
      }
    }
  }
  const consensusBeatingAccuracy = compared > 0 ? round(beat / compared) : null;
  const catalystPredictionAccuracy = dirCompared > 0 ? round(dirRight / dirCompared) : null;

  // Scenario calibration.
  const assigned: Record<string, number[]> = { bull: [], base: [], bear: [] };
  const realised: Record<string, number> = { bull: 0, base: 0, bear: 0 };
  const briers: number[] = [];
  for (const v of views) {
    if (!isNum(v.outcomeReturnPct) || v.view.scenarios.length === 0) continue;
    for (const s of v.view.scenarios) assigned[s.name]!.push(s.probability);
    const hit = nearestScenario(v.view.scenarios, v.outcomeReturnPct);
    if (!hit) continue;
    realised[hit.name] = (realised[hit.name] ?? 0) + 1;
    let brier = 0;
    for (const s of v.view.scenarios) brier += Math.pow(s.probability - (s.name === hit.name ? 1 : 0), 2);
    briers.push(brier / v.view.scenarios.length);
  }
  const calibrated = briers.length;
  const cal = (name: "bull" | "base" | "bear") => ({ assigned: assigned[name]!.length > 0 ? round(mean(assigned[name]!)!) : null, realised: calibrated > 0 ? round((realised[name] ?? 0) / calibrated) : null });
  const brierMean = mean(briers);
  const scenarioCalibration: ScenarioCalibration = { bull: cal("bull"), base: cal("base"), bear: cal("bear"), score: brierMean === null ? null : round(clamp01(1 - brierMean)) };

  // Expected vs actual reaction error.
  const errors: number[] = [];
  for (const v of views) {
    if (isNum(v.view.expectedReactionPct) && isNum(v.outcomeReturnPct)) errors.push(Math.abs(v.view.expectedReactionPct - v.outcomeReturnPct));
  }
  const reactionErrorPct = errors.length > 0 ? round(mean(errors)!, 2) : null;

  // False variant: meaningful view that turned out wrong. Missed variant: not meaningful but a material move followed.
  const meaningful = views.filter((v) => v.view.meaningful && v.outcomeCorrect !== null);
  const falseVariantRate = meaningful.length > 0 ? round(meaningful.filter((v) => v.outcomeCorrect === false).length / meaningful.length) : null;
  const notMeaningful = views.filter((v) => !v.view.meaningful && isNum(v.outcomeReturnPct));
  const missedVariantRate = notMeaningful.length > 0 ? round(notMeaningful.filter((v) => Math.abs(v.outcomeReturnPct!) >= materialMovePct).length / notMeaningful.length) : null;

  // Influence weight.
  let influenceWeight: number;
  const n = judged.length + compared;
  if (n < 5) {
    influenceWeight = 0.75;
    notes.push(`insufficient sample (${n} judged outcomes): influence held at 0.75 until the engine proves itself`);
  } else {
    const parts: number[] = [];
    if (forecastAccuracy !== null) parts.push(forecastAccuracy - 0.5);
    if (consensusBeatingAccuracy !== null) parts.push(consensusBeatingAccuracy - 0.5);
    if (scenarioCalibration.score !== null) parts.push(scenarioCalibration.score - 0.6);
    if (falseVariantRate !== null) parts.push(0.4 - falseVariantRate);
    const edge = parts.length > 0 ? mean(parts)! : 0;
    // edge ≈ 0 → 0.6; edge +0.25 → 1.0; edge −0.25 → 0.25
    influenceWeight = round(clamp(0.6 + edge * 1.6, 0.25, 1), 3);
    if (influenceWeight < 0.6) notes.push("engine is not adding value over consensus: influence reduced");
    if (forecastAccuracy !== null && forecastAccuracy < 0.5) notes.push(`forecast accuracy ${forecastAccuracy} below coin-flip`);
    if (consensusBeatingAccuracy !== null && consensusBeatingAccuracy < 0.5) notes.push(`internal forecasts beat consensus only ${Math.round(consensusBeatingAccuracy * 100)}% of the time`);
  }
  return {
    sampleSize: { views: views.length, resolvedViews: resolvedViews.length, expectations: expectations.length, resolvedExpectations },
    forecastAccuracy,
    consensusBeatingAccuracy,
    catalystPredictionAccuracy,
    scenarioCalibration,
    reactionErrorPct,
    falseVariantRate,
    missedVariantRate,
    influenceWeight,
    notes,
  };
}
