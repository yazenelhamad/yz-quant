import type { AgentIntelligenceProfile, ModelIntelligenceProfile, RegimeUsefulness, SignalIntelligenceProfile, StrategyIntelligenceProfile, TenantScope } from "@yz/core";
import { describeRegimeFit, detectRepeatedMistakes, strategyRegimeFit } from "@yz/core";
import { MODELS_NOT_CONFIGURED_MESSAGE } from "@yz/intelligence";
import { executionStatsForScope } from "./adaptation.js";
import { type LearningContext } from "./context.js";
import type { LearningHealthView } from "./health.js";
import { calibrationRowToProfile, lessonRowToLesson, reviewRowToReview } from "./mapping.js";
import { pctFieldsToFractions } from "./units.js";

export interface DigestView { period: string; generatedAt: string; summary: string; highlights: string[]; tradesReviewed?: number; since?: string; detail?: unknown }

export interface LearningViewInput {
  /** Null = shared view; a scope = that account's view. */
  scope: TenantScope | null;
  /** Scopes whose account-level rows (rejections, proposals, execution) the caller may see. */
  visibleScopes: TenantScope[];
  health: LearningHealthView;
  modelsConfigured: boolean;
  regimeUsefulness: RegimeUsefulness | null;
}

const IC_CHANGE = 0.03;

/** Builds the LearningView of docs/API.md (addendum item 6). Every *Pct is converted to a fraction. */
export async function buildLearningView(ctx: LearningContext, input: LearningViewInput) {
  const { lr, repos } = ctx;
  const { scope } = input;
  const strategies = new Map((await lr.catalog.list()).map((s) => [s.key, s]));

  const digest = (row: { digest: unknown } | undefined): DigestView | null => {
    if (!row) return null;
    const d = row.digest as { period: string; generatedAt: string; whatWeLearned: string[]; tradesReviewed: number; since: string };
    return { period: d.period, generatedAt: d.generatedAt, summary: d.whatWeLearned.join(" "), highlights: d.whatWeLearned, tradesReviewed: d.tradesReviewed, since: d.since, detail: d };
  };
  const today = digest(await lr.digests.latest("daily", scope));
  const week = digest(await lr.digests.latest("weekly", scope));

  const profileRows = (scope ? await lr.strategyProfiles.forScope(scope) : await lr.strategyProfiles.shared()).filter((r) => r.mode === "all");
  const strategiesImproving: unknown[] = [];
  const strategiesDeteriorating: unknown[] = [];
  for (const r of profileRows) {
    const p = r.profile as StrategyIntelligenceProfile;
    const trend = p.degradation.trend;
    if (trend !== "improving" && trend !== "deteriorating") continue;
    const item = { strategyKey: p.strategyKey, name: strategies.get(p.strategyKey)?.name ?? null, trend, recentExpectancyPct: p.recent.expectancyPct, longTermExpectancyPct: p.overall.expectancyPct, note: p.assessment.plainEnglish };
    (trend === "improving" ? strategiesImproving : strategiesDeteriorating).push(item);
  }

  const signalsImproving: unknown[] = [];
  const signalsDeteriorating: unknown[] = [];
  for (const r of await lr.signalProfiles.all()) {
    const p = r.profile as SignalIntelligenceProfile;
    if (p.recentPredictiveValue === null || p.historicalPredictiveValue === null) continue;
    const diff = p.recentPredictiveValue - p.historicalPredictiveValue;
    if (Math.abs(diff) < IC_CHANGE) continue;
    const item = { signalKey: p.signalKey, recentPredictiveValue: p.recentPredictiveValue, historicalPredictiveValue: p.historicalPredictiveValue, currentWeight: p.currentWeight, note: `recent IC ${p.recentPredictiveValue.toFixed(3)} vs historical ${p.historicalPredictiveValue.toFixed(3)} over ${p.sampleSize} observations` };
    (diff > 0 ? signalsImproving : signalsDeteriorating).push(item);
  }

  const calibration = (await lr.calibration.all()).map((r) => ({ ...calibrationRowToProfile(r), adjustment: r.adjustment }));
  const models = (await lr.modelProfiles.all()).map((r) => r.profile as ModelIntelligenceProfile);
  const agents = (await lr.agentProfiles.all()).map((r) => r.profile as AgentIntelligenceProfile);

  const inVisible = (r: { userId: string | null; brokerAccountId: string | null }) => input.visibleScopes.some((s) => s.userId === r.userId && s.brokerAccountId === r.brokerAccountId);
  const inScope = (r: { userId: string | null; brokerAccountId: string | null }) => (scope ? r.userId === scope.userId && r.brokerAccountId === scope.brokerAccountId : r.userId === null || inVisible(r));

  const lessonRows = (await lr.lessons.recentAll(500)).filter(inScope);
  const recentLessons = lessonRows.slice(0, 20).map(lessonRowToLesson).map(({ scope: _s, ...l }) => l);
  const reviewRows = (await lr.reviews.recentAll(500)).filter(inScope);
  const reviews = reviewRows.map(reviewRowToReview);
  const lessons = lessonRows.map(lessonRowToLesson);
  const reviewedAt = new Map(reviewRows.map((r) => [r.tradeId, r.reviewedAt]));
  const lessonAction = new Map(lessons.filter((l) => l.tradeId).map((l) => [l.tradeId as string, l.action]));
  const repeatedMistakes = detectRepeatedMistakes(reviews, lessons).map((m) => ({
    pattern: m.description, occurrences: m.count, strategyKey: m.strategyKey, classification: m.classification, regime: m.regime,
    lastSeenAt: m.tradeIds.map((t) => reviewedAt.get(t) ?? "").sort().pop() || null,
    suggestedAction: m.tradeIds.map((t) => lessonAction.get(t)).find((a) => !!a) ?? "Review the setup before taking it again.",
  }));

  const scopesForRows = scope ? [scope] : input.visibleScopes;
  const missedOpportunities: unknown[] = [];
  const executionStats = [];
  const proposals: unknown[] = [];
  for (const s of scopesForRows) {
    for (const r of await repos.rejected.recent(s, 200)) {
      if (r.reviewVerdict !== "missed_opportunity") continue;
      const { userId: _u, brokerAccountId: _b, ...rest } = r;
      missedOpportunities.push({ ...rest, accountId: r.brokerAccountId });
    }
    executionStats.push(...(await executionStatsForScope(ctx, s)));
    for (const p of await lr.proposals.recent(s, 100)) proposals.push({ ...p, accountId: p.brokerAccountId });
  }
  if (!scope) for (const p of await lr.proposals.recent(null, 100)) proposals.push({ ...p, accountId: null });

  const executionInsights = executionStats.map((x) => {
    const ratio = x.avgSlippageBps !== null && x.expectedSlippageBps !== null && x.expectedSlippageBps > 0 ? x.avgSlippageBps / x.expectedSlippageBps : null;
    const insight = x.samples === 0 ? "no fills yet" : ratio === null ? "no slippage model comparison" : ratio > 1.5 ? "slippage well above model, prefer patient limit orders" : ratio < 0.75 ? "slippage below model" : "slippage in line with model";
    return { bucket: x.key.replace(/^patience:/, ""), insight: `${insight} (${x.samples} fills)`, avgSlippageBps: x.avgSlippageBps, expectedSlippageBps: x.expectedSlippageBps, fillRate: x.fillRate, samples: x.samples };
  });

  const shared: Record<string, StrategyIntelligenceProfile> = {};
  for (const r of (await lr.strategyProfiles.shared()).filter((r) => r.mode === "all")) shared[r.strategyKey] = r.profile as StrategyIntelligenceProfile;
  const fit = strategyRegimeFit(shared);
  const regimeInsights: { regime: string; insight: string; evidence: string[] }[] = [];
  for (const key of Object.keys(fit).sort()) {
    const line = describeRegimeFit({ [key]: fit[key] ?? {} })[0];
    if (!line) continue;
    const cells = Object.entries(fit[key] ?? {}).sort((a, b) => b[1].score - a[1].score);
    regimeInsights.push({ regime: cells[0]?.[0] ?? "unknown", insight: line, evidence: cells.map(([regime, c]) => `${regime}: fit ${c.score.toFixed(2)} over ${c.trades} trades`) });
  }
  if (input.regimeUsefulness) {
    regimeInsights.unshift({ regime: "engine", insight: `Regime engine usefulness score ${input.regimeUsefulness.score.toFixed(2)} (hit rate ${input.regimeUsefulness.hitRate === null ? "n/a" : (input.regimeUsefulness.hitRate * 100).toFixed(0) + "%"}, ${input.regimeUsefulness.samples} samples).`, evidence: input.regimeUsefulness.notes });
  }

  const view = {
    today, week,
    strategiesImproving: pctFieldsToFractions(strategiesImproving), strategiesDeteriorating: pctFieldsToFractions(strategiesDeteriorating),
    signalsImproving, signalsDeteriorating,
    calibration,
    models, modelsConfigured: input.modelsConfigured, modelsNote: input.modelsConfigured ? null : MODELS_NOT_CONFIGURED_MESSAGE,
    agents,
    recentLessons,
    repeatedMistakes,
    missedOpportunities: pctFieldsToFractions(missedOpportunities),
    regimeInsights,
    executionInsights,
    adaptationProposals: proposals,
    learningHealth: { status: input.health.status, lastRunAt: input.health.lastRunAt, frozen: input.health.frozen, reason: input.health.reason, failedJobs: input.health.failedJobs },
  };
  return view;
}
