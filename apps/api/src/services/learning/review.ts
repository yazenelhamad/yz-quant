import type { EnsembleResult, PostTradeReview, TenantScope, TradeLesson, TradeMemoryEntry, TradeThesis } from "@yz/core";
import {
  MEMORY_FEATURE_KEYS, buildMemoryEntry, buildNormalizer, generateLesson, mergeLessons, reviewTrade, updateCalibration, vectorize, type ThesisSummary,
} from "@yz/core";
import type { LearningContext } from "./context.js";
import { calibrationRowToProfile, entryToMemoryRow, executionOutcomeRowToOutcome, lessonRowToLesson, lessonToRow, numericRecord, tradeRowToRecord } from "./mapping.js";

export const REVIEWER_VERSION = "review-1.0.0";

export type TradeClosedResult =
  | { ok: true; review: PostTradeReview; lesson: TradeLesson; memory: TradeMemoryEntry }
  | { ok: false; error: string };

/**
 * Post-trade learning for one closed trade, entirely inside the trade's scope: review, lesson,
 * memory entry (with a standardised feature vector) and calibration observations. Nothing here
 * writes another user's rows and nothing changes live logic.
 */
export async function reviewClosedTrade(ctx: LearningContext, scope: TenantScope, tradeId: string): Promise<TradeClosedResult> {
  const { repos, lr } = ctx;
  const now = ctx.clock().toISOString();
  const tradeRow = await repos.trades.byId(scope, tradeId);
  if (!tradeRow) return { ok: false, error: `trade ${tradeId} not found in scope` };
  if (tradeRow.state !== "closed" && tradeRow.closedAt === null) return { ok: false, error: `trade ${tradeId} is not closed (${tradeRow.state})` };
  const trade = tradeRowToRecord(tradeRow);

  const strategyRow = await lr.catalog.byId(trade.strategyId);
  const thesisRows = await repos.theses.forTrade(scope, tradeId);
  const thesisRow = thesisRows[0] ?? (trade.thesisId ? await repos.theses.byId(scope, trade.thesisId) : undefined);
  const thesis = (thesisRow?.thesis ?? {}) as Partial<TradeThesis>;
  const strategyKey = strategyRow?.key ?? thesis.strategyKey ?? trade.strategyId;

  const candidate = tradeRow.candidateId ? await lr.inputs.candidateById(tradeRow.candidateId) : undefined;
  const ensemble = (candidate?.ensemble ?? null) as EnsembleResult | null;
  const signals: Record<string, number> = {};
  const contributions: Record<string, number> = {};
  for (const c of ensemble?.components ?? []) {
    if (Number.isFinite(c.value)) signals[c.key] = c.value;
    if (Number.isFinite(c.contribution)) contributions[c.key] = c.contribution;
  }

  const openedAt = trade.openedAt ?? trade.createdAt;
  const closedAt = trade.closedAt ?? now;
  const featureRow = await lr.inputs.featuresAt(trade.symbol, openedAt);
  const features = numericRecord(featureRow?.values);
  // Ensemble-level inputs are part of the memory vector (see MEMORY_FEATURE_KEYS).
  if (ensemble) {
    features["expected_edge"] = ensemble.expectedEdge;
    features["confidence"] = ensemble.confidence;
  }
  if (candidate) features["regime_fit"] = candidate.regimeFit;

  const exitRegime = await lr.inputs.regimeAt(closedAt);
  const orderRows = await lr.inputs.ordersForTrade(scope, tradeId);
  const outcomeRows = await lr.inputs.executionOutcomesForOrders(scope, orderRows.map((o) => o.id));
  const executionOutcomes = outcomeRows.map(executionOutcomeRowToOutcome);

  let benchmarkReturnPct: number | null = null;
  try {
    const spy = await repos.market.bars("SPY", "day", { start: openedAt, end: closedAt, limit: 400 });
    if (spy.length >= 2) benchmarkReturnPct = ((spy[spy.length - 1]!.close / spy[0]!.close) - 1) * 100;
  } catch { benchmarkReturnPct = null; }

  let eventsDuringTrade: string[] = [];
  try {
    const earnings = await repos.market.upcomingEarnings([trade.symbol], openedAt, closedAt);
    eventsDuringTrade = earnings.map((e) => `earnings ${e.reportAt.slice(0, 10)}`);
  } catch { eventsDuringTrade = []; }

  let positionPct = 0;
  const snap = (await repos.snapshots.firstSince(scope, openedAt)) ?? (await repos.snapshots.latest(scope));
  if (snap && snap.totalValue > 0 && trade.averageEntryPrice) positionPct = (trade.entryQuantity * trade.averageEntryPrice) / snap.totalValue;

  const instrument = await repos.market.instrument(trade.symbol);
  const sector = thesis.portfolioImpact?.sector ?? instrument?.sector ?? null;

  const memory = buildMemoryEntry({
    trade,
    thesis: { strategyKey, confidence: trade.initialConfidence, expectedEdge: trade.expectedEdge, expectedDownsidePct: trade.expectedDownsidePct, sector },
    signals,
    features,
    regime: trade.regimeAtEntry,
    executionOutcomes,
    positionPct,
  });

  const summary: ThesisSummary = {
    expectedEdge: trade.expectedEdge,
    confidence: trade.initialConfidence,
    expectedHoldingDays: thesis.expectedHoldingPeriodDays ?? tradeRow.expectedHoldingDays ?? candidate?.holdingPeriodDays ?? 10,
    expectedUpsidePct: thesis.expectedUpsidePct ?? candidate?.expectedUpsidePct ?? Math.max(Math.abs(trade.expectedEdge) * 100, trade.expectedDownsidePct),
    expectedDownsidePct: trade.expectedDownsidePct,
    invalidationPrice: tradeRow.invalidationPrice ?? thesis.invalidationPrice ?? null,
    targetPrice: tradeRow.targetPrice ?? thesis.targetPrice ?? null,
    exitConditions: thesis.exitConditions ?? [],
  };

  const review = reviewTrade({
    trade, memory, thesis: summary, executionOutcomes,
    regimeAtExit: exitRegime?.primary ?? null,
    eventsDuringTrade,
    signalContributions: contributions,
    benchmarkReturnPct,
  }, now, REVIEWER_VERSION);
  memory.reviewClassification = review.classification;

  const lesson = generateLesson(review, memory, trade.regimeAtEntry, features, now);
  memory.lessons = [lesson.lesson];

  // Persist review.
  await lr.reviews.upsert(scope, { tradeId, classification: review.classification, review, reviewerVersion: REVIEWER_VERSION, reviewedAt: now });

  // Lessons: merge with this scope's existing lessons for the same strategy so repeated setups confirm/contradict.
  const existingRows = await lr.lessons.forScope(scope, { strategyKey });
  const existing = existingRows.map(lessonRowToLesson);
  const merged = mergeLessons(existing, [lesson]);
  const byId = new Map(existing.map((l) => [l.id, l]));
  for (const l of merged) {
    const prev = byId.get(l.id);
    if (!prev || prev.timesConfirmed !== l.timesConfirmed || prev.timesContradicted !== l.timesContradicted || prev.confidenceImpact !== l.confidenceImpact) {
      await lr.lessons.upsert(lessonToRow(l));
    }
  }
  const persistedLesson = merged.find((l) => l.id === lesson.id) ?? merged.find((l) => l.tradeId === tradeId) ?? lesson;

  // Memory with a standardised vector (normaliser from the whole memory, statistics only).
  const memoryRows = await lr.memory.all(5000);
  const normalizer = buildNormalizer([...memoryRows.map((r) => ({ features: r.features ?? {} })), { features }]);
  const vector = vectorize(features, MEMORY_FEATURE_KEYS, normalizer);
  await lr.memory.upsert(scope, entryToMemoryRow(memory, vector));

  // Calibration observations: system-wide and per strategy. Data errors carry no information.
  if (review.classification !== "data_error") {
    for (const key of ["system", strategyKey]) {
      const row = await lr.calibration.get(key);
      const profile = updateCalibration(row ? calibrationRowToProfile(row) : null, [{ predicted: trade.initialConfidence, success: review.returnPct > 0 }], now, key);
      await lr.calibration.upsertProfile(key, profile);
    }
  }

  await ctx.audit.record({
    category: "learning", action: "trade_reviewed", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: null,
    tradeId, strategyId: trade.strategyId, strategyVersionId: trade.strategyVersionId,
    detail: { classification: review.classification, returnPct: review.returnPct, lessonId: persistedLesson.id, mode: trade.mode, strategyKey },
  });
  return { ok: true, review, lesson: persistedLesson, memory };
}
