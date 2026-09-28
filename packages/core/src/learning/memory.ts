import type { ExecutionOutcome, HistoricalAnalog, IsoTimestamp, PostTradeReview, TradeMemoryEntry, TradeRecord } from "../types/index.js";
import { assertSameScope } from "../types/index.js";
import { clamp, cosine, daysBetween, isFiniteNumber, mean, stddev } from "./math.js";
import { realizedReturnPct } from "./postTradeReview.js";

/** Fixed feature order used for memory vectors. Missing features are neutral (0 after standardisation). */
export const MEMORY_FEATURE_KEYS: readonly string[] = Object.freeze([
  "momentum_20",
  "momentum_60",
  "momentum_120",
  "rsi_14",
  "realized_vol_20",
  "vol_ratio",
  "breadth",
  "spread_bps",
  "liquidity_score",
  "volume_ratio",
  "distance_to_52w_high",
  "sector_relative_strength",
  "correlation_to_market",
  "regime_fit",
  "expected_edge",
  "confidence",
]);

export type FeatureNormalizer = Record<string, { mean: number; std: number }>;

export interface MemoryThesisSummary {
  strategyKey: string;
  confidence: number;
  expectedEdge: number;
  expectedDownsidePct: number;
  sector: string | null;
}

export interface BuildMemoryInput {
  trade: TradeRecord;
  thesis: MemoryThesisSummary;
  signals: Record<string, number>;
  features: Record<string, number>;
  regime: string;
  executionOutcomes?: ExecutionOutcome[];
  review?: PostTradeReview | null;
  lessons?: string[];
  /** Fraction of account equity the position represented at entry. */
  positionPct?: number;
}

/** Execution quality in [0, 1]: 1 when fills were at or better than expected, 0 at 3x the expected slippage. */
export function executionQualityFromOutcomes(outcomes: readonly ExecutionOutcome[]): number | null {
  const pairs = outcomes.filter((o) => isFiniteNumber(o.actualSlippageBps) && !o.missed);
  if (pairs.length === 0) return null;
  const scores = pairs.map((o) => {
    const expected = Math.max(o.expectedSlippageBps, 1);
    const actual = o.actualSlippageBps as number;
    if (actual <= expected) return 1;
    return clamp(1 - (actual - expected) / (2 * expected), 0, 1);
  });
  return mean(scores);
}

export function buildMemoryEntry(input: BuildMemoryInput): TradeMemoryEntry {
  const { trade, thesis } = input;
  const outcomes = input.executionOutcomes ?? [];
  for (const o of outcomes) assertSameScope(trade.scope, o.scope, "buildMemoryEntry(executionOutcome)");
  if (input.review) assertSameScope(trade.scope, input.review.scope, "buildMemoryEntry(review)");

  const entryPrice = trade.averageEntryPrice ?? 0;
  const exitPrice = trade.averageExitPrice;
  const holdingDays = daysBetween(trade.openedAt, trade.closedAt);
  const buySlips = outcomes.filter((o) => o.side === "buy" && isFiniteNumber(o.actualSlippageBps)).map((o) => o.actualSlippageBps as number);
  const allSlips = outcomes.filter((o) => isFiniteNumber(o.actualSlippageBps)).map((o) => o.actualSlippageBps as number);
  const partial: TradeMemoryEntry = {
    tradeId: trade.id,
    scope: trade.scope,
    mode: trade.mode,
    symbol: trade.symbol,
    sector: thesis.sector,
    strategyKey: thesis.strategyKey,
    regime: trade.regimeAtEntry,
    signals: { ...input.signals },
    features: { ...input.features },
    entryPrice,
    exitPrice,
    holdingDays: holdingDays === null ? null : Math.round(holdingDays * 100) / 100,
    positionPct: input.positionPct ?? 0,
    confidence: thesis.confidence,
    expectedEdge: thesis.expectedEdge,
    predictedDownsidePct: thesis.expectedDownsidePct,
    actualReturnPct: null,
    maePct: trade.maxAdverseExcursionPct,
    mfePct: trade.maxFavorableExcursionPct,
    slippageBps: buySlips.length > 0 ? mean(buySlips) : mean(allSlips),
    executionQuality: executionQualityFromOutcomes(outcomes),
    exitReason: trade.exitReason,
    reviewClassification: input.review?.classification ?? null,
    lessons: [...(input.lessons ?? [])],
    openedAt: trade.openedAt ?? trade.createdAt,
    closedAt: trade.closedAt,
  };
  partial.actualReturnPct = trade.state === "closed" || trade.closedAt !== null ? realizedReturnPct(trade, partial) : null;
  if (input.regime && partial.regime === "") partial.regime = input.regime;
  return partial;
}

/** Per-key mean and standard deviation over a memory set, for standardising vectors. */
export function buildNormalizer(entries: readonly { features: Record<string, number> }[], keys: readonly string[] = MEMORY_FEATURE_KEYS): FeatureNormalizer {
  const out: FeatureNormalizer = {};
  for (const key of keys) {
    const values = entries.map((e) => e.features[key]).filter(isFiniteNumber);
    const m = mean(values) ?? 0;
    const s = stddev(values);
    out[key] = { mean: m, std: s !== null && s > 0 ? s : 1 };
  }
  return out;
}

/** Standardised, clipped (+/-3 sd) feature vector in the fixed key order. Missing features map to 0. */
export function vectorize(features: Record<string, number | null | undefined>, keys: readonly string[] = MEMORY_FEATURE_KEYS, normalizer: FeatureNormalizer | null = null): number[] {
  return keys.map((key) => {
    const v = features[key];
    if (!isFiniteNumber(v)) return 0;
    const n = normalizer?.[key];
    const z = n ? (v - n.mean) / (n.std > 0 ? n.std : 1) : v;
    return clamp(z, -3, 3) / 3;
  });
}

export interface VectorizedMemoryEntry extends TradeMemoryEntry {
  vector: number[];
}

export interface AnalogQuery {
  vector: number[];
  strategyKey: string;
  regime: string;
  symbol: string;
  sector: string | null;
  /** Trade to exclude (e.g. the trade being analysed). */
  excludeTradeId?: string | null;
}

export interface ScoredAnalog extends HistoricalAnalog {
  confidence: number;
  mode: "live" | "shadow";
  classification: TradeMemoryEntry["reviewClassification"];
}

export const ANALOG_WEIGHTS = Object.freeze({ cosine: 0.7, sameStrategy: 0.15, sameRegime: 0.1, sameSector: 0.05 });

export function thesisCorrectFromClassification(c: TradeMemoryEntry["reviewClassification"]): boolean | null {
  switch (c) {
    case "good_win":
      return true;
    case "bad_win":
    case "bad_thesis":
    case "good_loss":
    case "oversized":
      return false;
    default:
      return null;
  }
}

/**
 * Nearest-neighbour retrieval over closed trades from every user's live and shadow memory. This
 * is evidence only: the function reads the memory and returns scored copies, never mutating it.
 */
export function findAnalogs(query: AnalogQuery, memory: readonly VectorizedMemoryEntry[], k = 10): ScoredAnalog[] {
  const scored: ScoredAnalog[] = [];
  for (const entry of memory) {
    if (!isFiniteNumber(entry.actualReturnPct)) continue;
    if (query.excludeTradeId && entry.tradeId === query.excludeTradeId) continue;
    const sim = (cosine(query.vector, entry.vector) + 1) / 2;
    let score = ANALOG_WEIGHTS.cosine * sim;
    if (entry.strategyKey === query.strategyKey) score += ANALOG_WEIGHTS.sameStrategy;
    if (entry.regime === query.regime) score += ANALOG_WEIGHTS.sameRegime;
    if (query.sector !== null && entry.sector === query.sector) score += ANALOG_WEIGHTS.sameSector;
    scored.push({
      tradeId: entry.tradeId,
      symbol: entry.symbol,
      strategyKey: entry.strategyKey,
      regime: entry.regime,
      similarity: clamp(score, 0, 1),
      returnPct: entry.actualReturnPct,
      thesisCorrect: thesisCorrectFromClassification(entry.reviewClassification),
      lesson: entry.lessons[0] ?? null,
      confidence: entry.confidence,
      mode: entry.mode,
      classification: entry.reviewClassification,
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.tradeId.localeCompare(b.tradeId));
  return scored.slice(0, Math.max(0, k));
}

export interface AnalogSummary {
  analogs: number;
  positive: number;
  avgReturnPct: number | null;
  thesisCorrectRate: number | null;
  avgConfidenceError: number | null;
}

export function summarizeAnalogs(analogs: readonly (HistoricalAnalog & { confidence?: number })[]): AnalogSummary {
  const returns = analogs.map((a) => a.returnPct).filter(isFiniteNumber);
  const judged = analogs.filter((a) => a.thesisCorrect !== null);
  const confErrors = analogs
    .filter((a) => isFiniteNumber(a.confidence) && isFiniteNumber(a.returnPct))
    .map((a) => Math.abs((a.confidence as number) - ((a.returnPct as number) > 0 ? 1 : 0)));
  return {
    analogs: analogs.length,
    positive: returns.filter((r) => r > 0).length,
    avgReturnPct: mean(returns),
    thesisCorrectRate: judged.length === 0 ? null : judged.filter((a) => a.thesisCorrect === true).length / judged.length,
    avgConfidenceError: mean(confErrors),
  };
}

export function entryAgeDays(entry: Pick<TradeMemoryEntry, "closedAt" | "openedAt">, now: IsoTimestamp): number | null {
  return daysBetween(entry.closedAt ?? entry.openedAt, now);
}
