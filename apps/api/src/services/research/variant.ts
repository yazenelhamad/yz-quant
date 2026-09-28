import type { Catalyst, CompanyIntelligenceProfile, DataEnvelope, Evidence, ExpectationsInputs, ExpectationsRecord } from "@yz/core";
import { buildConsensusModel, updateCompanyProfile } from "@yz/core";
import { MODELS_NOT_CONFIGURED_MESSAGE, makeEnvelope, runVariantPerception, type StructuredModelClient, type VariantPerceptionResult } from "@yz/intelligence";
import type { Repos } from "../../http/app.js";
import type { AuditService } from "../audit.js";
import type { LearningRepos } from "../learning/repos.js";

export type VariantRunResult =
  | { ok: true; viewId: string; view: unknown; notes: string[] }
  | { ok: false; error: VariantPerceptionResult extends infer R ? (R extends { ok: false; error: infer E } ? E : never) : never; message: string; stage: string };

export interface VariantRunnerDeps {
  repos: Repos;
  lr: LearningRepos;
  audit: AuditService;
  modelClient: StructuredModelClient;
  clock?: () => Date;
}

function reliabilityFromTier(tier: number): number {
  return Math.max(0.1, Math.min(0.95, 1 - tier / 10));
}

/**
 * Gathers the stored inputs for one ticker (consensus, revisions, earnings, news envelopes, company
 * profile, expectations history; missing pieces become nulls, never guesses) and runs the variant
 * perception orchestrator. Persists the view, consensus snapshot, catalysts and profile history.
 */
export async function runVariant(deps: VariantRunnerDeps, ticker: string, requestedBy: string): Promise<VariantRunResult> {
  const { repos, lr, modelClient } = deps;
  const now = (deps.clock ?? (() => new Date()))();
  const asOf = now.toISOString();
  const symbol = ticker.toUpperCase();
  if (!modelClient.configured) {
    return { ok: false, error: "not_configured", message: MODELS_NOT_CONFIGURED_MESSAGE, stage: "precheck" };
  }
  const instrument = await repos.market.instrument(symbol);
  const revisions = (await lr.variant.latestRevisions(symbol, 1))[0];
  const bars = await repos.market.bars(symbol, "day", { start: new Date(now.getTime() - 90 * 86_400_000).toISOString(), limit: 120 });
  const quote = (await repos.market.latestQuotes([symbol]))[0];
  const last = quote?.last ?? bars[bars.length - 1]?.close ?? null;
  const ret = (n: number): number | null => (bars.length > n && last !== null ? (last / bars[bars.length - 1 - n]!.close - 1) * 100 : null);

  const expectations: ExpectationsInputs = {
    ticker: symbol,
    asOf,
    epsEstimates: revisions ? [revisions.epsLow, revisions.epsMean, revisions.epsHigh].filter((x): x is number => typeof x === "number") : null,
    priceTargets: revisions?.priceTargetMean != null ? [revisions.priceTargetMean] : null,
    price: last,
    revisions: revisions ? { epsUp: revisions.epsUp, epsDown: revisions.epsDown, revenueUp: revisions.revenueUp, revenueDown: revisions.revenueDown, priceTargetChangePct: revisions.priceTargetChangePct, windowDays: 30 } : null,
    priceAction: { return5dPct: ret(5), return20dPct: ret(20) },
    sources: [...(revisions ? [revisions.source] : []), ...(quote ? [quote.source] : [])],
    dataQuality: revisions ? "aging" : "unknown",
  };

  const news = await repos.market.newsFor(symbol, new Date(now.getTime() - 30 * 86_400_000).toISOString(), 30);
  const envelopes: DataEnvelope[] = news.map((n) => makeEnvelope("news", n.source, [n.headline, n.summary ?? ""].filter(Boolean).join("\n"), n.publishedAt, reliabilityFromTier(n.sourceTier)));
  const evidence: Evidence[] = [
    ...news.slice(0, 10).map((n): Evidence => ({ source: n.source, kind: "journalism", observedAt: n.publishedAt, reliability: reliabilityFromTier(n.sourceTier), summary: n.headline.slice(0, 600) })),
    ...(revisions ? [{ source: revisions.source, kind: "analyst" as const, observedAt: revisions.asOf, reliability: 0.55, summary: `Analyst revisions: EPS up ${revisions.epsUp} / down ${revisions.epsDown}, PT change ${revisions.priceTargetChangePct ?? "n/a"}%` }] : []),
  ];
  const earnings = await repos.market.upcomingEarnings([symbol], asOf, new Date(now.getTime() + 120 * 86_400_000).toISOString());
  const knownCatalysts: Catalyst[] = earnings.map((e) => ({ kind: "earnings", description: `Earnings report ${e.reportAt.slice(0, 10)}${e.timing ? ` (${e.timing})` : ""}`, expectedDate: e.reportAt, probability: 1, potentialImpactPct: 0, consensusExpectsIt: true, pricedInScore: 0.5, reactionSpeed: "immediate" }));

  const profileRow = await lr.variant.companyProfile(symbol);
  const profile = (profileRow?.profile as CompanyIntelligenceProfile | undefined) ?? null;
  const records = (await lr.variant.allExpectations()).map((r): ExpectationsRecord => ({
    id: r.id, ticker: r.ticker, catalyst: r.catalyst, eventAt: r.eventAt, consensus: r.consensus as Record<string, number | null>, narrative: r.narrative, optionsImpliedMovePct: r.optionsImpliedMovePct,
    priceBefore: r.priceBefore, systemForecast: r.systemForecast as Record<string, number | null>, systemConfidence: r.systemConfidence, actualResult: r.actualResult as Record<string, number | null> | null, priceAfter: r.priceAfter, reactionPct: r.reactionPct, recordedAt: r.recordedAt, resolvedAt: r.resolvedAt,
  }));

  const result = await runVariantPerception({
    ticker: symbol, asOf, sector: instrument?.sector ?? profile?.sector ?? null, industry: instrument?.industry ?? profile?.industry ?? null,
    expectations, envelopes, holdingPeriodDays: 20, evidence, knownCatalysts,
  }, modelClient, { expectationsRecords: records, profile });

  if (!result.ok) {
    await deps.audit.record({ category: "model", action: "variant_run_failed", result: "error", actorUserId: requestedBy, error: result.message, detail: { ticker: symbol, stage: result.stage, error: result.error } });
    return { ok: false, error: result.error, message: result.message, stage: result.stage };
  }
  const view = result.view;
  const consensus = buildConsensusModel(expectations).model;
  await lr.variant.recordConsensus(symbol, asOf, consensus);
  const viewId = await lr.variant.recordView({ ticker: symbol, asOf, score: view.score.total, recommendedAction: view.recommendedAction, view });
  await lr.variant.replaceUpcomingCatalysts(symbol, view.catalysts.map((c) => ({ kind: c.kind, description: c.description, expectedDate: c.expectedDate, probability: c.probability, potentialImpactPct: c.potentialImpactPct, consensusExpectsIt: c.consensusExpectsIt ? "yes" : "no", pricedInScore: c.pricedInScore, reactionSpeed: c.reactionSpeed, status: "upcoming", outcome: null })));
  const updated = updateCompanyProfile(profile, {
    ticker: symbol, name: instrument?.name ?? profile?.name ?? symbol, sector: instrument?.sector ?? profile?.sector ?? null, industry: instrument?.industry ?? profile?.industry ?? null,
    marketNarrative: view.narrative.dominant, majorCatalysts: view.catalysts.map((c) => c.description), majorRisks: view.redTeam?.legitimateFlaws ?? profile?.majorRisks ?? [],
    consensusExpectations: { eps: consensus.consensusEps, revenue: consensus.consensusRevenue, growthPct: consensus.consensusGrowthPct },
    internalExpectations: Object.fromEntries(view.differences.map((d) => [d.metric, d.internal])),
  }, asOf);
  await lr.variant.saveCompanyProfile(symbol, updated.profile, updated.profile.version);
  await deps.audit.record({ category: "model", action: "variant_run", result: "ok", actorUserId: requestedBy, modelName: view.versions.modelName, modelVersion: view.versions.modelVersion, promptVersion: view.versions.promptVersion, detail: { ticker: symbol, score: view.score.total, action: view.recommendedAction, usage: result.usage } });
  return { ok: true, viewId, view, notes: result.notes };
}

export async function variantSnapshot(lr: LearningRepos, ticker: string) {
  const symbol = ticker.toUpperCase();
  const [view, consensus, cats, expectations, profile] = await Promise.all([
    lr.variant.latestView(symbol), lr.variant.latestConsensus(symbol), lr.variant.catalystsFor(symbol), lr.variant.expectationsFor(symbol, 20), lr.variant.companyProfile(symbol),
  ]);
  return {
    ticker: symbol,
    variantView: view ? { id: view.id, asOf: view.asOf, score: view.score, recommendedAction: view.recommendedAction, view: view.view, outcomeReturnPct: view.outcomeReturnPct, resolvedAt: view.resolvedAt } : null,
    consensusSnapshot: consensus ? { asOf: consensus.asOf, model: consensus.model } : null,
    catalysts: cats,
    expectationsRecords: expectations,
    companyProfile: profile ? { version: profile.version, updatedAt: profile.updatedAt, profile: profile.profile } : null,
  };
}
