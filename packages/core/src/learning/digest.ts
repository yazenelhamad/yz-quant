import type {
  AgentIntelligenceProfile,
  CalibrationProfile,
  IsoTimestamp,
  ModelIntelligenceProfile,
  PostTradeReview,
  SignalIntelligenceProfile,
  StrategyIntelligenceProfile,
  TradeLesson,
} from "../types/index.js";
import type { ExecutionStat } from "./adaptation.js";
import type { MissedOpportunityReview } from "./missed.js";
import { BAD_PROCESS_CLASSIFICATIONS } from "./postTradeReview.js";
import { isFiniteNumber, pct } from "./math.js";

export interface RepeatedMistake {
  classification: PostTradeReview["classification"];
  strategyKey: string | null;
  regime: string | null;
  tags: Record<string, string>;
  count: number;
  tradeIds: string[];
  description: string;
}

/** Groups bad-process reviews by classification plus the setup tags of their lessons; >= minCount is "repeated". */
export function detectRepeatedMistakes(reviews: readonly PostTradeReview[], lessons: readonly TradeLesson[], minCount = 3): RepeatedMistake[] {
  const lessonByTrade = new Map<string, TradeLesson>();
  for (const l of lessons) if (l.tradeId) lessonByTrade.set(l.tradeId, l);
  const groups = new Map<string, RepeatedMistake>();
  for (const r of reviews) {
    if (!BAD_PROCESS_CLASSIFICATIONS.has(r.classification)) continue;
    const lesson = lessonByTrade.get(r.tradeId);
    const tags: Record<string, string> = {};
    if (lesson) {
      for (const k of ["setup", "regime", "confidence", "holding", "vol", "breadth", "liquidity"]) {
        const v = lesson.tags[k];
        if (v !== undefined) tags[k] = v;
      }
    } else {
      tags.regime = r.regimeAtEntry;
    }
    const key = `${r.classification}|${Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",")}`;
    const g = groups.get(key) ?? { classification: r.classification, strategyKey: lesson?.strategyKey ?? null, regime: tags.regime ?? null, tags, count: 0, tradeIds: [], description: "" };
    g.count += 1;
    g.tradeIds.push(r.tradeId);
    groups.set(key, g);
  }
  const out: RepeatedMistake[] = [];
  for (const g of groups.values()) {
    if (g.count < minCount) continue;
    const ctx = Object.entries(g.tags).filter(([k]) => k !== "setup").map(([k, v]) => `${k} ${v}`).join(", ");
    g.description = `${g.classification.replace(/_/g, " ")} repeated ${g.count} times${g.strategyKey ? ` for ${g.strategyKey}` : ""}${ctx ? ` (${ctx})` : ""}.`;
    out.push(g);
  }
  return out.sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification));
}

export interface ProfileDelta<T> {
  before: T | null;
  after: T;
}

export interface LearningDigestInput {
  period: "daily" | "weekly" | "monthly";
  since: IsoTimestamp;
  now: IsoTimestamp;
  reviews: PostTradeReview[];
  lessons: TradeLesson[];
  strategyProfiles: ProfileDelta<StrategyIntelligenceProfile>[];
  signalProfiles: ProfileDelta<SignalIntelligenceProfile>[];
  calibrations: CalibrationProfile[];
  modelProfiles: ModelIntelligenceProfile[];
  agentProfiles: AgentIntelligenceProfile[];
  missedReviews: MissedOpportunityReview[];
  regimeInsights: string[];
  executionStats: ExecutionStat[];
  repeatedMistakes?: RepeatedMistake[];
}

export interface LearningDigest {
  period: LearningDigestInput["period"];
  since: IsoTimestamp;
  generatedAt: IsoTimestamp;
  tradesReviewed: number;
  whatWeLearned: string[];
  strategiesImproving: string[];
  strategiesDeteriorating: string[];
  signalsImproving: string[];
  signalsDeteriorating: string[];
  calibrationSummary: string;
  modelSummary: string;
  agentSummary: string;
  recentLessons: string[];
  repeatedMistakes: string[];
  missedOpportunities: string[];
  regimeInsights: string[];
  executionInsights: string[];
}

const IC_CHANGE = 0.03;

function describeStrategyDelta(d: ProfileDelta<StrategyIntelligenceProfile>): { line: string; direction: "improving" | "deteriorating" | "flat" } {
  const a = d.after;
  const b = d.before;
  const recentAfter = a.recent.expectancyPct;
  const recentBefore = b?.recent.expectancyPct ?? null;
  const change = recentAfter !== null && recentBefore !== null ? recentAfter - recentBefore : null;
  let direction: "improving" | "deteriorating" | "flat";
  if (a.assessment.recommendedStatus === "insufficient_data") direction = "flat";
  else if (a.assessment.edgeTrend === "improving" || (change !== null && change > 0.1 && (recentAfter ?? 0) > 0)) direction = "improving";
  else if (a.assessment.edgeTrend === "decaying" || a.assessment.recommendedStatus === "move_to_shadow" || a.assessment.recommendedStatus === "pause" || (change !== null && change < -0.1)) direction = "deteriorating";
  else direction = "flat";
  const line = `${a.strategyKey}: recent expectancy ${pct(recentAfter)}${recentBefore !== null ? ` (was ${pct(recentBefore)})` : ""}, ${a.overall.trades} trades overall, recommendation ${a.assessment.recommendedStatus.replace(/_/g, " ")}.`;
  return { line, direction };
}

function describeSignalDelta(d: ProfileDelta<SignalIntelligenceProfile>): { line: string; direction: "improving" | "deteriorating" | "flat" } {
  const a = d.after;
  const recent = a.recentPredictiveValue;
  const hist = a.historicalPredictiveValue;
  const before = d.before?.recentPredictiveValue ?? null;
  let direction: "improving" | "deteriorating" | "flat" = "flat";
  if (recent !== null && hist !== null) {
    if (recent - hist > IC_CHANGE) direction = "improving";
    else if (hist - recent > IC_CHANGE) direction = "deteriorating";
  }
  if (direction === "flat" && recent !== null && before !== null) {
    if (recent - before > IC_CHANGE) direction = "improving";
    else if (before - recent > IC_CHANGE) direction = "deteriorating";
  }
  const line = `${a.signalKey}: recent IC ${recent === null ? "n/a" : recent.toFixed(3)} vs historical ${hist === null ? "n/a" : hist.toFixed(3)}${before !== null ? ` (recent was ${before.toFixed(3)})` : ""} over ${a.sampleSize} observations.`;
  return { line, direction };
}

export function buildLearningDigest(input: LearningDigestInput): LearningDigest {
  const reviews = input.reviews;
  const n = reviews.length;
  const wins = reviews.filter((r) => r.returnPct > 0).length;
  const byClass = new Map<string, number>();
  for (const r of reviews) byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);
  const goodProcess = reviews.filter((r) => r.classification === "good_win" || r.classification === "good_loss").length;

  const strategiesImproving: string[] = [];
  const strategiesDeteriorating: string[] = [];
  for (const d of input.strategyProfiles) {
    const { line, direction } = describeStrategyDelta(d);
    if (direction === "improving") strategiesImproving.push(line);
    else if (direction === "deteriorating") strategiesDeteriorating.push(line);
  }
  const signalsImproving: string[] = [];
  const signalsDeteriorating: string[] = [];
  for (const d of input.signalProfiles) {
    const { line, direction } = describeSignalDelta(d);
    if (direction === "improving") signalsImproving.push(line);
    else if (direction === "deteriorating") signalsDeteriorating.push(line);
  }

  const calibrationLines = input.calibrations.map((c) => {
    if (c.sampleSize === 0) return `${c.key}: no predictions yet.`;
    const ratio = c.overconfidenceRatio;
    const verdict = ratio === null ? "no successes recorded" : ratio > 1.15 ? "overconfident" : ratio < 0.85 ? "underconfident" : "well calibrated";
    return `${c.key}: ${verdict} (ratio ${ratio === null ? "n/a" : ratio.toFixed(2)}, Brier ${c.brierScore === null ? "n/a" : c.brierScore.toFixed(3)}, ECE ${c.expectedCalibrationError === null ? "n/a" : c.expectedCalibrationError.toFixed(3)}, n=${c.sampleSize})`;
  });
  const calibrationSummary = calibrationLines.length === 0 ? "No calibration data for this period." : calibrationLines.join(" ");

  const modelSummary = input.modelProfiles.length === 0
    ? "No model evaluations this period."
    : input.modelProfiles.map((m) => `${m.modelName}@${m.modelVersion}: accuracy ${m.accuracy === null ? "n/a" : (m.accuracy * 100).toFixed(0) + "%"}, p50 latency ${m.latencyMsP50 === null ? "n/a" : Math.round(m.latencyMsP50) + " ms"}, failure rate ${m.failureRate === null ? "n/a" : (m.failureRate * 100).toFixed(1) + "%"}, cost $${m.costUsd.toFixed(2)}${m.valueAdded !== null ? `, value added ${(m.valueAdded * 100).toFixed(1)} points` : ""}.`).join(" ");

  const agentSummary = input.agentProfiles.length === 0
    ? "No agent evaluations this period."
    : input.agentProfiles.map((a) => `${a.agentName}: influenced ${a.decisionsInfluenced} decisions, value added ${a.valueAdded === null ? "not measurable yet" : (a.valueAdded * 100).toFixed(1) + " points"}, veto accuracy ${a.vetoAccuracy === null ? "n/a" : (a.vetoAccuracy * 100).toFixed(0) + "%"}.`).join(" ");

  const since = Date.parse(input.since);
  const recentLessons = [...input.lessons]
    .filter((l) => !Number.isFinite(since) || Date.parse(l.createdAt) >= since)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10)
    .map((l) => `${l.strategyKey} / ${l.regime}: ${l.lesson} Action: ${l.action}`);

  const repeated = input.repeatedMistakes ?? detectRepeatedMistakes(reviews, input.lessons);
  const repeatedMistakes = repeated.map((m) => m.description);

  const missed = input.missedReviews.filter((m) => m.verdict === "missed_opportunity");
  const policyCorrect = input.missedReviews.filter((m) => m.policyRejection).length;
  const missedOpportunities = missed.map((m) => `${m.rejected.symbol}: rejected for ${m.reasons.join(", ")}, returned ${pct(m.forwardReturnPct)} over ${m.horizon}. Research evidence only.`);
  if (policyCorrect > 0) missedOpportunities.push(`${policyCorrect} rejections were policy controls (data, limits, kill switch) and are correct regardless of what the price did afterwards.`);

  const executionInsights = input.executionStats
    .filter((x) => x.samples > 0)
    .map((x) => {
      const ratio = isFiniteNumber(x.avgSlippageBps) && isFiniteNumber(x.expectedSlippageBps) && x.expectedSlippageBps > 0 ? x.avgSlippageBps / x.expectedSlippageBps : null;
      const judgement = ratio === null ? "no slippage model comparison" : ratio > 1.5 ? "slippage well above model, prefer patience" : ratio < 0.75 ? "slippage below model" : "slippage in line with model";
      return `${x.key}: ${x.avgSlippageBps === null ? "n/a" : x.avgSlippageBps.toFixed(1) + " bps"} realised vs ${x.expectedSlippageBps === null ? "n/a" : x.expectedSlippageBps.toFixed(1) + " bps"} expected over ${x.samples} fills${x.fillRate !== null ? `, fill rate ${(x.fillRate * 100).toFixed(0)}%` : ""}: ${judgement}.`;
    });

  const whatWeLearned: string[] = [];
  whatWeLearned.push(n === 0
    ? `No trades closed in this ${input.period} period.`
    : `${n} trades were reviewed: ${wins} winners and ${n - wins} non-winners; ${goodProcess} (${((goodProcess / n) * 100).toFixed(0)}%) were good decisions regardless of outcome.`);
  const topClasses = [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topClasses.length > 0) whatWeLearned.push(`Most common outcomes: ${topClasses.map(([c, k]) => `${c.replace(/_/g, " ")} (${k})`).join(", ")}.`);
  if (strategiesImproving.length > 0) whatWeLearned.push(`${strategiesImproving.length} strateg${strategiesImproving.length === 1 ? "y is" : "ies are"} improving.`);
  if (strategiesDeteriorating.length > 0) whatWeLearned.push(`${strategiesDeteriorating.length} strateg${strategiesDeteriorating.length === 1 ? "y is" : "ies are"} deteriorating and flagged for review.`);
  if (repeatedMistakes.length > 0) whatWeLearned.push(`${repeatedMistakes.length} repeated mistake pattern${repeatedMistakes.length === 1 ? "" : "s"} detected.`);
  if (missed.length > 0) whatWeLearned.push(`${missed.length} rejection${missed.length === 1 ? "" : "s"} look like missed opportunities; this is research input and does not change any threshold.`);
  const overconfident = input.calibrations.filter((c) => c.sampleSize >= 30 && c.overconfidenceRatio !== null && c.overconfidenceRatio > 1.15);
  if (overconfident.length > 0) whatWeLearned.push(`Confidence is overstated for ${overconfident.map((c) => c.key).join(", ")}; calibration adjustments shrink it accordingly.`);
  whatWeLearned.push("Nothing in this digest changes live logic: outputs are statistics, calibration and bounded parameter proposals.");

  return {
    period: input.period,
    since: input.since,
    generatedAt: input.now,
    tradesReviewed: n,
    whatWeLearned,
    strategiesImproving,
    strategiesDeteriorating,
    signalsImproving,
    signalsDeteriorating,
    calibrationSummary,
    modelSummary,
    agentSummary,
    recentLessons,
    repeatedMistakes,
    missedOpportunities,
    regimeInsights: [...input.regimeInsights],
    executionInsights,
  };
}
