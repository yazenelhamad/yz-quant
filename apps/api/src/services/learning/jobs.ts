import type { AgentIntelligenceProfile, ModelIntelligenceProfile, RegimeUsefulness, SignalIntelligenceProfile, StrategyIntelligenceProfile, TenantScope } from "@yz/core";
import {
  buildLearningDigest, describeRegimeFit, detectRepeatedMistakes, regimeUsefulnessScore, reviewRejectedTrade, strategyRegimeFit, weekdaysBetween,
  type LearningDigest, type MissedOpportunityReview, type ProfileDelta,
} from "@yz/core";
import { executionStatsForScope } from "./adaptation.js";
import { daysAgo, listScopes, scopeKey, type LearningContext } from "./context.js";
import { calibrationRowToProfile, lessonRowToLesson, regimeRowToAssessment, rejectedRowToRejected, reviewRowToReview } from "./mapping.js";

// -------------------------------------------------------------------------------------------
// signals_resolve: realised forward returns for signals whose horizon has elapsed
// -------------------------------------------------------------------------------------------

export async function resolveSignals(ctx: LearningContext): Promise<{ resolved: number; pending: number }> {
  const { repos } = ctx;
  const rows = await repos.market.unresolvedSignals(daysAgo(ctx.clock, 1), 500);
  let resolved = 0;
  const barCache = new Map<string, Awaited<ReturnType<typeof repos.market.bars>>>();
  for (const s of rows) {
    const horizon = Math.min(20, Math.max(1, Math.round(s.horizonDays)));
    let bars = barCache.get(s.symbol);
    if (!bars) { bars = await repos.market.bars(s.symbol, "day", { start: daysAgo(ctx.clock, 120), limit: 400 }); barCache.set(s.symbol, bars); }
    const at = Date.parse(s.asOf);
    const before = bars.filter((b) => Date.parse(b.time) <= at);
    const after = bars.filter((b) => Date.parse(b.time) > at);
    const base = before[before.length - 1];
    const target = after[horizon - 1];
    if (!base || !target || base.close <= 0) continue;
    await repos.market.resolveSignal(s.id, (target.close / base.close - 1) * 100);
    resolved += 1;
  }
  return { resolved, pending: rows.length - resolved };
}

// -------------------------------------------------------------------------------------------
// missed_review: rejected trades older than five trading days (research evidence only)
// -------------------------------------------------------------------------------------------

export const MISSED_REVIEW_TRADING_DAYS = 5;

export async function reviewMissedOpportunities(ctx: LearningContext): Promise<{ reviewed: number; byScope: Record<string, number> }> {
  const { repos, lr } = ctx;
  const now = ctx.clock().toISOString();
  const byScope: Record<string, number> = {};
  let reviewed = 0;
  for (const scope of await listScopes(ctx)) {
    const rows = await repos.rejected.unreviewedOlderThan(scope, daysAgo(ctx.clock, 6), 200);
    let n = 0;
    for (const row of rows) {
      if ((weekdaysBetween(row.rejectedAt, now) ?? 0) < MISSED_REVIEW_TRADING_DAYS) continue;
      const bars = await repos.market.bars(row.symbol, "day", { start: row.rejectedAt, limit: 40 });
      const at = Date.parse(row.rejectedAt);
      const after = bars.filter((b) => Date.parse(b.time) > at);
      const candidate = row.candidateId ? await lr.inputs.candidateById(row.candidateId) : undefined;
      const prices = { "1d": after[0]?.close ?? null, "5d": after[4]?.close ?? null, "20d": after[19]?.close ?? null };
      const veryOld = (weekdaysBetween(row.rejectedAt, now) ?? 0) > 30;
      if (prices["1d"] === null && !veryOld) continue; // no forward data yet: leave it unreviewed rather than guess
      const review = reviewRejectedTrade(rejectedRowToRejected(row), prices, { expectedHoldingDays: candidate?.holdingPeriodDays ?? 5, ...(candidate ? { expectedDownsidePct: candidate.expectedDownsidePct } : {}) });
      await repos.rejected.review(scope, row.id, { subsequentReturnPct: review.subsequentReturnPct, reviewVerdict: review.verdict });
      n += 1;
    }
    byScope[scopeKey(scope)] = n;
    reviewed += n;
  }
  return { reviewed, byScope };
}

// -------------------------------------------------------------------------------------------
// regime_usefulness
// -------------------------------------------------------------------------------------------

export async function scoreRegimeUsefulness(ctx: LearningContext): Promise<RegimeUsefulness> {
  const rows = await ctx.lr.inputs.resolvedRegimes(1000);
  const history = rows.map((r) => ({ assessment: regimeRowToAssessment(r), forwardReturn5d: r.forwardReturn5d, forwardVol5d: r.forwardVol5d }));
  const score = regimeUsefulnessScore(history);
  await ctx.repos.health.set({
    name: "regime_engine",
    status: score.samples < 20 ? "unknown" : score.score >= 0 ? "healthy" : "warning",
    detail: score.notes.join(" ") || "no resolved regime classifications yet",
    checkedAt: ctx.clock().toISOString(),
    metrics: { score: score.score, hitRate: score.hitRate, samples: score.samples },
  });
  return score;
}

// -------------------------------------------------------------------------------------------
// learning_digest
// -------------------------------------------------------------------------------------------

export interface DigestDeps {
  previousStrategyProfiles: Map<string, StrategyIntelligenceProfile>;
  previousSignalProfiles: Map<string, SignalIntelligenceProfile>;
}

function missedReviewFromRow(row: Parameters<typeof rejectedRowToRejected>[0]): MissedOpportunityReview | null {
  if (!row.reviewVerdict) return null;
  const rejected = rejectedRowToRejected(row);
  const sub = row.subsequentReturnPct ?? {};
  const horizon = (["20d", "5d", "1d"] as const).find((h) => typeof sub[h] === "number") ?? null;
  return {
    kind: "missed_opportunity_review", rejectedTradeId: row.id, scope: rejected.scope, verdict: rejected.reviewVerdict as NonNullable<typeof rejected.reviewVerdict>,
    horizon, forwardReturnPct: horizon ? (sub[horizon] as number) : null, subsequentReturnPct: sub, policyRejection: false, reasons: rejected.reasons, note: "", rejected,
  };
}

export async function buildDigestFor(ctx: LearningContext, scope: TenantScope | null, period: "daily" | "weekly", deps: DigestDeps): Promise<LearningDigest> {
  const { lr, repos } = ctx;
  const now = ctx.clock().toISOString();
  const since = daysAgo(ctx.clock, period === "daily" ? 1 : 7);
  const inScope = (r: { userId: string | null; brokerAccountId: string | null }) => scope === null || (r.userId === scope.userId && r.brokerAccountId === scope.brokerAccountId);
  const reviews = (await lr.reviews.recentAll(1000, since)).filter(inScope).map(reviewRowToReview);
  const lessons = (await lr.lessons.recentAll(1000, since)).filter((l) => scope === null || l.userId === null || inScope(l)).map(lessonRowToLesson);
  const profileRows = (scope ? await lr.strategyProfiles.forScope(scope) : await lr.strategyProfiles.shared()).filter((r) => r.mode === "all");
  const strategyProfiles: ProfileDelta<StrategyIntelligenceProfile>[] = profileRows.map((r) => {
    const after = r.profile as StrategyIntelligenceProfile;
    return { before: deps.previousStrategyProfiles.get(`${scopeKey(scope)}|${r.strategyKey}`) ?? null, after };
  });
  const signalProfiles: ProfileDelta<SignalIntelligenceProfile>[] = (await lr.signalProfiles.all()).map((r) => ({ before: deps.previousSignalProfiles.get(r.signalKey) ?? null, after: r.profile as SignalIntelligenceProfile }));
  const calibrations = (await lr.calibration.all()).map(calibrationRowToProfile);
  const modelProfiles = (await lr.modelProfiles.all()).map((r) => r.profile as ModelIntelligenceProfile);
  const agentProfiles = (await lr.agentProfiles.all()).map((r) => r.profile as AgentIntelligenceProfile);
  const scopes = scope ? [scope] : await listScopes(ctx);
  const missedReviews: MissedOpportunityReview[] = [];
  const executionStats = [];
  for (const s of scopes) {
    for (const row of await repos.rejected.recent(s, 200)) {
      if (!row.reviewedAt || Date.parse(row.reviewedAt) < Date.parse(since)) continue;
      const m = missedReviewFromRow(row);
      if (m) missedReviews.push(m);
    }
    executionStats.push(...(await executionStatsForScope(ctx, s)));
  }
  const sharedProfiles: Record<string, StrategyIntelligenceProfile> = {};
  for (const r of (await lr.strategyProfiles.shared()).filter((r) => r.mode === "all")) sharedProfiles[r.strategyKey] = r.profile as StrategyIntelligenceProfile;
  const regimeInsights = describeRegimeFit(strategyRegimeFit(sharedProfiles));
  const repeatedMistakes = detectRepeatedMistakes(reviews, lessons);
  return buildLearningDigest({ period, since, now, reviews, lessons, strategyProfiles, signalProfiles, calibrations, modelProfiles, agentProfiles, missedReviews, regimeInsights, executionStats, repeatedMistakes });
}

export async function runDigests(ctx: LearningContext, deps: DigestDeps): Promise<{ daily: number; weekly: number }> {
  const { lr } = ctx;
  const now = ctx.clock();
  const scopes: (TenantScope | null)[] = [null, ...(await listScopes(ctx))];
  let daily = 0;
  let weekly = 0;
  for (const scope of scopes) {
    const d = await buildDigestFor(ctx, scope, "daily", deps);
    await lr.digests.create("daily", d.since, scope, d);
    daily += 1;
    const lastWeekly = await lr.digests.latest("weekly", scope);
    if (!lastWeekly || now.getTime() - Date.parse(lastWeekly.createdAt) >= 7 * 86_400_000) {
      const w = await buildDigestFor(ctx, scope, "weekly", deps);
      await lr.digests.create("weekly", w.since, scope, w);
      weekly += 1;
    }
  }
  return { daily, weekly };
}

// -------------------------------------------------------------------------------------------
// strategy_status_review
// -------------------------------------------------------------------------------------------

export const STATUS_REVIEW_MIN_TRADES = 20;
/** Drawdown (percent points) above which a `pause` recommendation may auto-demote limited_live/live -> live_shadow. */
export const AUTO_DEMOTE_DRAWDOWN_PCT = 15;
const PROPOSAL_COOLDOWN_DAYS = 7;

export interface StatusReviewResult { proposals: number; demotions: number }

/**
 * Per-user strategy status review. The learning engine never promotes and never silently demotes:
 * a `move_to_shadow` / `pause` recommendation with enough evidence is recorded as a stage-transition
 * proposal plus an alert. The single automatic action is the documented safety demotion from
 * limited_live/live to live_shadow when the recommendation is `pause` AND the realised drawdown
 * exceeds AUTO_DEMOTE_DRAWDOWN_PCT; it is recorded as a transition and audited.
 */
export async function reviewStrategyStatus(ctx: LearningContext): Promise<StatusReviewResult> {
  const { lr, repos } = ctx;
  const now = ctx.clock().toISOString();
  const result: StatusReviewResult = { proposals: 0, demotions: 0 };
  const strategies = new Map((await lr.catalog.list()).map((s) => [s.id, s]));
  const recent = await lr.catalog.recentTransitions(500);
  for (const scope of await listScopes(ctx)) {
    const profiles = (await lr.strategyProfiles.forScope(scope)).filter((r) => r.mode === "all");
    for (const row of profiles) {
      const p = row.profile as StrategyIntelligenceProfile;
      const rec = p.assessment.recommendedStatus;
      if (p.overall.trades < STATUS_REVIEW_MIN_TRADES || (rec !== "move_to_shadow" && rec !== "pause")) continue;
      const strategy = strategies.get(row.strategyId);
      const settings = await lr.settings.get(scope, row.strategyId);
      if (!strategy || !settings) continue;
      const evidence = { recommendedStatus: rec, trades: p.overall.trades, expectancyPct: p.overall.expectancyPct, recentExpectancyPct: p.recent.expectancyPct, maxDrawdownPct: p.overall.maxDrawdownPct, plainEnglish: p.assessment.plainEnglish };
      const liveStage = settings.stage === "limited_live" || settings.stage === "live";
      const drawdown = p.overall.maxDrawdownPct ?? 0;
      if (liveStage && rec === "pause" && drawdown > AUTO_DEMOTE_DRAWDOWN_PCT) {
        await lr.settings.upsert(scope, row.strategyId, { stage: "live_shadow" });
        await lr.catalog.recordTransition({ strategyId: row.strategyId, userId: scope.userId, brokerAccountId: scope.brokerAccountId, fromStage: settings.stage, toStage: "live_shadow", reason: `Automatic safety demotion: recommendation pause with drawdown ${drawdown.toFixed(1)}% > ${AUTO_DEMOTE_DRAWDOWN_PCT}%`, evidence: { kind: "auto_demotion", applied: true, ...evidence }, decidedBy: "learning_engine", at: now });
        await repos.alerts.raise({ userId: scope.userId, brokerAccountId: scope.brokerAccountId, severity: "critical", kind: "learning", title: `${strategy.name} demoted to shadow`, message: `Drawdown ${drawdown.toFixed(1)}% exceeded ${AUTO_DEMOTE_DRAWDOWN_PCT}% with a pause recommendation; the strategy now runs in shadow for this account until a human re-enables it.` });
        await ctx.audit.record({ category: "strategy", action: "stage_auto_demoted", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: null, strategyId: row.strategyId, detail: { from: settings.stage, to: "live_shadow", ...evidence } });
        result.demotions += 1;
        continue;
      }
      const cooldown = recent.find((t) => t.strategyId === row.strategyId && t.userId === scope.userId && t.brokerAccountId === scope.brokerAccountId && (t.evidence as { kind?: string } | null)?.kind === "proposal" && Date.parse(t.at) > Date.parse(now) - PROPOSAL_COOLDOWN_DAYS * 86_400_000);
      if (cooldown) continue;
      const target = rec === "pause" ? "paused" : "live_shadow";
      if (settings.stage === target) continue;
      await lr.catalog.recordTransition({ strategyId: row.strategyId, userId: scope.userId, brokerAccountId: scope.brokerAccountId, fromStage: settings.stage, toStage: target, reason: `PROPOSAL (not applied): learning recommends ${rec.replace(/_/g, " ")}`, evidence: { kind: "proposal", applied: false, ...evidence }, decidedBy: "learning_engine", at: now });
      await repos.alerts.raise({ userId: scope.userId, brokerAccountId: scope.brokerAccountId, severity: "warning", kind: "learning", title: `${strategy.name}: recommendation ${rec.replace(/_/g, " ")}`, message: p.assessment.plainEnglish });
      await ctx.audit.record({ category: "strategy", action: "stage_change_proposed", result: "info", userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: null, strategyId: row.strategyId, detail: { from: settings.stage, to: target, ...evidence } });
      result.proposals += 1;
    }
  }
  return result;
}
