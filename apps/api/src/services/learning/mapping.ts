import type {
  AdaptationProposal, CalibrationProfile, ExecutionOutcome, OutcomeClassification, PostTradeReview, RegimeAssessment, RejectedTrade, RejectionReason,
  StrategyIntelligenceProfile, TenantScope, TradeLesson, TradeMemoryEntry, TradeRecord,
} from "@yz/core";
import type { AdaptationProposalRow, LearningLessonRow, LearningReviewRow, StrategyProfileRow, TradeMemoryRow, TradeRow } from "@yz/db";

/** Row → core conversions. Every scoped object keeps the scope of the row it came from. */

export function scopeOfRow(row: { userId: string; brokerAccountId: string }): TenantScope {
  return { userId: row.userId, brokerAccountId: row.brokerAccountId };
}

export function tradeRowToRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    scope: scopeOfRow(row),
    mode: row.mode,
    symbol: row.symbol,
    strategyId: row.strategyId,
    strategyVersionId: row.strategyVersionId,
    thesisId: row.thesisId,
    state: row.state as TradeRecord["state"],
    direction: "long",
    entryQuantity: row.entryQuantity,
    openQuantity: row.openQuantity,
    averageEntryPrice: row.averageEntryPrice,
    averageExitPrice: row.averageExitPrice,
    realizedPnl: row.realizedPnl,
    fees: row.fees,
    maxAdverseExcursionPct: row.maxAdverseExcursionPct,
    maxFavorableExcursionPct: row.maxFavorableExcursionPct,
    initialConfidence: row.initialConfidence,
    expectedEdge: row.expectedEdge,
    expectedDownsidePct: row.expectedDownsidePct,
    regimeAtEntry: row.regimeAtEntry,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    exitReason: row.exitReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function memoryRowToEntry(row: TradeMemoryRow): TradeMemoryEntry {
  return {
    tradeId: row.tradeId,
    scope: scopeOfRow(row),
    mode: row.mode,
    symbol: row.symbol,
    sector: row.sector,
    strategyKey: row.strategyKey,
    regime: row.regime,
    signals: row.signals ?? {},
    features: row.features ?? {},
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    holdingDays: row.holdingDays,
    positionPct: row.positionPct,
    confidence: row.confidence,
    expectedEdge: row.expectedEdge,
    predictedDownsidePct: row.predictedDownsidePct,
    actualReturnPct: row.actualReturnPct,
    maePct: row.maePct,
    mfePct: row.mfePct,
    slippageBps: row.slippageBps,
    executionQuality: row.executionQuality,
    exitReason: row.exitReason,
    reviewClassification: (row.reviewClassification as OutcomeClassification | null) ?? null,
    lessons: row.lessons ?? [],
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

export function entryToMemoryRow(entry: TradeMemoryEntry, vector: number[]): Omit<TradeMemoryRow, "userId" | "brokerAccountId" | "updatedAt"> {
  return {
    tradeId: entry.tradeId,
    mode: entry.mode,
    symbol: entry.symbol,
    sector: entry.sector,
    strategyKey: entry.strategyKey,
    regime: entry.regime,
    signals: entry.signals,
    features: entry.features,
    vector,
    entryPrice: entry.entryPrice,
    exitPrice: entry.exitPrice,
    holdingDays: entry.holdingDays,
    positionPct: entry.positionPct,
    confidence: entry.confidence,
    expectedEdge: entry.expectedEdge,
    predictedDownsidePct: entry.predictedDownsidePct,
    actualReturnPct: entry.actualReturnPct,
    maePct: entry.maePct,
    mfePct: entry.mfePct,
    slippageBps: entry.slippageBps,
    executionQuality: entry.executionQuality,
    exitReason: entry.exitReason,
    reviewClassification: entry.reviewClassification,
    lessons: entry.lessons,
    openedAt: entry.openedAt,
    closedAt: entry.closedAt,
  };
}

export function reviewRowToReview(row: LearningReviewRow): PostTradeReview {
  const r = row.review as Partial<PostTradeReview>;
  return {
    id: r.id ?? row.id,
    scope: scopeOfRow(row),
    tradeId: row.tradeId,
    thesisCorrect: r.thesisCorrect ?? null,
    timingCorrect: r.timingCorrect ?? null,
    sizingCorrect: r.sizingCorrect ?? null,
    executionEfficient: r.executionEfficient ?? null,
    strategyBehavedAsIntended: r.strategyBehavedAsIntended ?? null,
    confidenceCalibrated: r.confidenceCalibrated ?? null,
    signalsHelped: r.signalsHelped ?? [],
    signalsHurt: r.signalsHurt ?? [],
    wouldTakeAgain: r.wouldTakeAgain ?? null,
    classification: (r.classification ?? row.classification) as OutcomeClassification,
    returnPct: r.returnPct ?? 0,
    expectedEdge: r.expectedEdge ?? 0,
    initialConfidence: r.initialConfidence ?? 0,
    maePct: r.maePct ?? null,
    mfePct: r.mfePct ?? null,
    slippageBps: r.slippageBps ?? null,
    regimeAtEntry: r.regimeAtEntry ?? "unknown",
    regimeAtExit: r.regimeAtExit ?? null,
    narrative: r.narrative ?? "",
    reviewedAt: row.reviewedAt,
    reviewerVersion: row.reviewerVersion,
  };
}

export function lessonRowToLesson(row: LearningLessonRow): TradeLesson {
  return {
    id: row.id,
    scope: row.userId && row.brokerAccountId ? { userId: row.userId, brokerAccountId: row.brokerAccountId } : null,
    tradeId: row.tradeId,
    strategyKey: row.strategyKey,
    regime: row.regime,
    setup: row.setup,
    expected: row.expected,
    actual: row.actual,
    lesson: row.lesson,
    action: row.action,
    tags: row.tags ?? {},
    confidenceImpact: row.confidenceImpact,
    createdAt: row.createdAt,
    timesConfirmed: row.timesConfirmed,
    timesContradicted: row.timesContradicted,
  };
}

export function lessonToRow(l: TradeLesson): Omit<LearningLessonRow, "createdAt"> & { createdAt?: string } {
  return {
    id: l.id,
    userId: l.scope?.userId ?? null,
    brokerAccountId: l.scope?.brokerAccountId ?? null,
    tradeId: l.tradeId,
    strategyKey: l.strategyKey,
    regime: l.regime,
    setup: l.setup,
    expected: l.expected,
    actual: l.actual,
    lesson: l.lesson,
    action: l.action,
    tags: l.tags,
    confidenceImpact: l.confidenceImpact,
    timesConfirmed: l.timesConfirmed,
    timesContradicted: l.timesContradicted,
    createdAt: l.createdAt,
  };
}

export interface ExecutionOutcomeRowLike {
  userId: string; brokerAccountId: string; brokerOrderId: string | null; orderId: string; symbol: string; side: string; expectedPrice: number; arrivalPrice: number;
  fillPrice: number | null; expectedSlippageBps: number; actualSlippageBps: number | null; timeToFillSeconds: number | null; partial: boolean; missed: boolean;
  reprices: number; cancelled: boolean; liquidityBucket: string; session: string; at: string;
}

export function executionOutcomeRowToOutcome(row: ExecutionOutcomeRowLike): ExecutionOutcome {
  return {
    scope: scopeOfRow(row),
    brokerOrderId: row.brokerOrderId ?? row.orderId,
    symbol: row.symbol,
    side: row.side as "buy" | "sell",
    expectedPrice: row.expectedPrice,
    arrivalPrice: row.arrivalPrice,
    fillPrice: row.fillPrice,
    expectedSlippageBps: row.expectedSlippageBps,
    actualSlippageBps: row.actualSlippageBps,
    timeToFillSeconds: row.timeToFillSeconds,
    partial: row.partial,
    missed: row.missed,
    reprices: row.reprices,
    cancelled: row.cancelled,
    liquidityBucket: (["low", "medium", "high"].includes(row.liquidityBucket) ? row.liquidityBucket : "medium") as ExecutionOutcome["liquidityBucket"],
    session: row.session,
    at: row.at,
  };
}

export interface RejectedRowLike {
  id: string; userId: string; brokerAccountId: string; candidateId: string | null; symbol: string; strategyId: string; reasons: string[]; detail: string;
  expectedEdge: number; confidence: number; regime: string; priceAtRejection: number | null; rejectedAt: string; subsequentReturnPct: Record<string, number> | null; reviewVerdict: string | null;
}

export function rejectedRowToRejected(row: RejectedRowLike): RejectedTrade {
  return {
    id: row.id,
    scope: scopeOfRow(row),
    candidateId: row.candidateId,
    symbol: row.symbol,
    strategyId: row.strategyId,
    reasons: row.reasons as RejectionReason[],
    detail: row.detail,
    expectedEdge: row.expectedEdge,
    confidence: row.confidence,
    regime: row.regime,
    priceAtRejection: row.priceAtRejection,
    rejectedAt: row.rejectedAt,
    subsequentReturnPct: row.subsequentReturnPct,
    reviewVerdict: (row.reviewVerdict as RejectedTrade["reviewVerdict"]) ?? null,
  };
}

export function profileRowToProfile(row: StrategyProfileRow): StrategyIntelligenceProfile {
  return row.profile as StrategyIntelligenceProfile;
}

export function proposalRowToProposal(row: AdaptationProposalRow): AdaptationProposal {
  return {
    id: row.id,
    scope: row.userId && row.brokerAccountId ? { userId: row.userId, brokerAccountId: row.brokerAccountId } : null,
    target: row.target as AdaptationProposal["target"],
    key: row.key,
    currentValue: row.currentValue,
    proposedValue: row.proposedValue,
    bounds: row.bounds as AdaptationProposal["bounds"],
    evidence: row.evidence,
    autoApplicable: row.autoApplicable,
    requiresValidationPipeline: row.requiresValidationPipeline,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

export function regimeRowToAssessment(row: { asOf: string; primary: string; probabilities: Record<string, number>; confidence: number; abnormality: number; metrics: unknown; familyBias: Record<string, number>; explanation: string[]; dataQuality: string }): RegimeAssessment {
  const m = (row.metrics ?? {}) as Partial<RegimeAssessment["metrics"]>;
  return {
    asOf: row.asOf,
    primary: row.primary as RegimeAssessment["primary"],
    probabilities: row.probabilities as RegimeAssessment["probabilities"],
    confidence: row.confidence,
    abnormality: row.abnormality,
    metrics: {
      spyTrend20: m.spyTrend20 ?? null, spyTrend100: m.spyTrend100 ?? null, realizedVol20: m.realizedVol20 ?? null, vix: m.vix ?? null, breadthPctAbove50: m.breadthPctAbove50 ?? null,
      avgPairwiseCorrelation: m.avgPairwiseCorrelation ?? null, sectorDispersion: m.sectorDispersion ?? null, momentumPersistence: m.momentumPersistence ?? null, meanReversionScore: m.meanReversionScore ?? null, volumeRatio: m.volumeRatio ?? null,
    },
    familyBias: row.familyBias ?? {},
    explanation: row.explanation ?? [],
    dataQuality: row.dataQuality as RegimeAssessment["dataQuality"],
  };
}

export function calibrationRowToProfile(row: { key: string; profile: unknown; updatedAt: string }): CalibrationProfile {
  return row.profile as CalibrationProfile;
}

export function numericRecord(values: Record<string, number | null | undefined> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values ?? {})) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

/** Regime lookup over a history sorted ascending by asOf: the latest assessment at or before `at`. */
export function regimeLookup(history: readonly { asOf: string; primary: string }[]): (at: string) => string {
  const sorted = [...history].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return (at: string): string => {
    const t = Date.parse(at);
    let lo = 0;
    let hi = sorted.length - 1;
    let found: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = sorted[mid]!;
      if (Date.parse(row.asOf) <= t) { found = row.primary; lo = mid + 1; } else hi = mid - 1;
    }
    return found ?? "unknown";
  };
}
