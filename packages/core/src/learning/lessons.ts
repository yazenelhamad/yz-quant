import type { IsoTimestamp, PostTradeReview, TenantScope, TradeLesson, TradeMemoryEntry } from "../types/index.js";
import { GOOD_CLASSIFICATIONS } from "./postTradeReview.js";
import { clamp, isFiniteNumber, pct } from "./math.js";

export const CONFIDENCE_IMPACT_BOUNDS = Object.freeze({ min: 0.85, max: 1.15 });

/** Tags that describe the outcome rather than the setup; excluded from the lesson signature. */
export const OUTCOME_TAG_KEYS: ReadonlySet<string> = new Set(["classification", "outcome", "polarity"]);

const BASE_IMPACT: Record<PostTradeReview["classification"], number> = {
  good_win: 1.04,
  bad_win: 0.97,
  good_loss: 1.0,
  bad_thesis: 0.9,
  bad_timing: 0.95,
  bad_execution: 1.0,
  oversized: 0.92,
  unexpected_event: 1.0,
  model_error: 0.9,
  data_error: 1.0,
  regime_change: 0.97,
};

/** Features that are bucketed into tags when present. Values are compared against the given thresholds. */
export const FEATURE_TAG_RULES: readonly { key: string; tag: string; low: number; high: number; labels: [string, string, string] }[] = [
  { key: "breadth", tag: "breadth", low: 0.4, high: 0.6, labels: ["weak", "neutral", "strong"] },
  { key: "realized_vol_20", tag: "vol", low: 0.15, high: 0.3, labels: ["low", "normal", "high"] },
  { key: "momentum_20", tag: "momentum", low: -0.02, high: 0.02, labels: ["negative", "flat", "positive"] },
  { key: "liquidity_score", tag: "liquidity", low: 0.33, high: 0.66, labels: ["low", "medium", "high"] },
  { key: "spread_bps", tag: "spread", low: 5, high: 20, labels: ["tight", "normal", "wide"] },
  { key: "volume_ratio", tag: "volume", low: 0.8, high: 1.5, labels: ["quiet", "normal", "heavy"] },
];

export function featureBucketLabel(value: number, low: number, high: number, labels: [string, string, string]): string {
  return value < low ? labels[0] : value >= high ? labels[2] : labels[1];
}

export function confidenceBucket(confidence: number): string {
  if (confidence < 0.5) return "<0.5";
  if (confidence < 0.6) return "0.5-0.6";
  if (confidence < 0.7) return "0.6-0.7";
  if (confidence < 0.8) return "0.7-0.8";
  if (confidence < 0.9) return "0.8-0.9";
  return "0.9-1";
}

export function holdingBucket(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 1) return "intraday";
  if (days <= 5) return "short";
  if (days <= 20) return "medium";
  return "long";
}

export function lessonPolarity(lesson: Pick<TradeLesson, "tags">): "positive" | "negative" | "neutral" {
  const p = lesson.tags.polarity;
  return p === "positive" || p === "negative" ? p : "neutral";
}

/** Setup signature: strategy + every non-outcome tag, order-independent. */
export function lessonSignature(lesson: Pick<TradeLesson, "strategyKey" | "tags">): string {
  const parts = Object.entries(lesson.tags)
    .filter(([k]) => !OUTCOME_TAG_KEYS.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return `${lesson.strategyKey}|${parts.join(",")}`;
}

export interface GenerateLessonOptions {
  /** Force the lesson to be shared (scope null). Defaults to the review's scope. */
  shared?: boolean;
  id?: string;
}

export function generateLesson(
  review: PostTradeReview,
  memory: TradeMemoryEntry,
  regime: string,
  features: Record<string, number>,
  now: IsoTimestamp,
  options: GenerateLessonOptions = {},
): TradeLesson {
  const tags: Record<string, string> = {
    setup: memory.strategyKey,
    regime,
    confidence: confidenceBucket(review.initialConfidence),
    holding: holdingBucket(memory.holdingDays),
    classification: review.classification,
    outcome: review.returnPct > 0 ? "win" : review.returnPct < 0 ? "loss" : "flat",
    polarity: GOOD_CLASSIFICATIONS.has(review.classification) ? "positive" : review.classification === "data_error" ? "neutral" : "negative",
  };
  for (const rule of FEATURE_TAG_RULES) {
    const v = features[rule.key];
    if (isFiniteNumber(v)) tags[rule.tag] = featureBucketLabel(v, rule.low, rule.high, rule.labels);
  }

  const contextBits = Object.entries(tags)
    .filter(([k]) => !OUTCOME_TAG_KEYS.has(k) && k !== "setup" && k !== "regime")
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const setup = `${memory.strategyKey} on ${memory.symbol} in a ${regime} regime${contextBits ? ` (${contextBits})` : ""}.`;
  const expected = `Expected ${pct(memory.expectedEdge * 100)} edge with ${(review.initialConfidence * 100).toFixed(0)}% confidence, downside ${pct(-Math.abs(memory.predictedDownsidePct))}, holding ~${memory.holdingDays !== null ? holdingBucket(memory.holdingDays) : "unknown"} horizon.`;
  const actual = `Realised ${pct(review.returnPct)}${review.maePct !== null ? ` with adverse excursion ${pct(review.maePct)}` : ""}${review.mfePct !== null ? ` and favourable excursion ${pct(review.mfePct)}` : ""}; classified as ${review.classification.replace(/_/g, " ")}.`;

  let lesson: string;
  let action: string;
  switch (review.classification) {
    case "good_win":
      lesson = "The setup worked as designed; this is confirming evidence, not a reason to size up.";
      action = "Keep the setup; do not increase allocation on the strength of one outcome.";
      break;
    case "bad_win":
      lesson = "The trade made money for reasons other than the thesis; the process would lose on average.";
      action = "Treat as a loss for calibration purposes; tighten exit discipline.";
      break;
    case "good_loss":
      lesson = "The thesis failed but the loss was controlled by the invalidation and the size.";
      action = "No change; this is the expected cost of the strategy.";
      break;
    case "bad_thesis":
      lesson = "The entry logic did not hold in this context.";
      action = "Reduce confidence for this setup in this regime until more evidence accumulates.";
      break;
    case "bad_timing":
      lesson = "The idea may have been right but the entry was early or the exit was mistimed.";
      action = "Require confirmation before entry for this setup; review time-stop rules.";
      break;
    case "bad_execution":
      lesson = "Execution cost consumed the edge.";
      action = "Prefer patient limit orders in this liquidity bucket; avoid urgent fills.";
      break;
    case "oversized":
      lesson = "The realised downside exceeded what the size assumed.";
      action = "Use a wider downside estimate for this setup when sizing.";
      break;
    case "unexpected_event":
      lesson = "An event outside the thesis dominated the outcome.";
      action = "Check the event calendar before entries with this holding horizon.";
      break;
    case "regime_change":
      lesson = "The regime changed while the position was open and the setup is regime-dependent.";
      action = "Re-evaluate open positions of this strategy whenever the regime label changes.";
      break;
    case "model_error":
      lesson = "A model produced an invalid or abnormal output.";
      action = "Route to model validation; no strategy conclusion can be drawn.";
      break;
    case "data_error":
    default:
      lesson = "The data behind this trade is unreliable; no strategy conclusion can be drawn.";
      action = "Exclude from strategy statistics until the data issue is resolved.";
      break;
  }

  // Confidence impact: base per classification, nudged by how wrong the confidence was, then bounded.
  const confidenceError = review.thesisCorrect === null ? 0 : review.initialConfidence - (review.thesisCorrect ? 1 : 0);
  const raw = BASE_IMPACT[review.classification] - 0.1 * confidenceError;
  const confidenceImpact = clamp(raw, CONFIDENCE_IMPACT_BOUNDS.min, CONFIDENCE_IMPACT_BOUNDS.max);

  return {
    id: options.id ?? `lesson:${review.tradeId}:${review.reviewerVersion}`,
    scope: options.shared ? null : review.scope,
    tradeId: review.tradeId,
    strategyKey: memory.strategyKey,
    regime,
    setup,
    expected,
    actual,
    lesson,
    action,
    tags,
    confidenceImpact,
    createdAt: now,
    timesConfirmed: 0,
    timesContradicted: 0,
  };
}

function scopesMatch(a: TenantScope | null, b: TenantScope | null): boolean {
  if (a === null || b === null) return a === b;
  return a.userId === b.userId && a.brokerAccountId === b.brokerAccountId;
}

/**
 * Merges incoming lessons into the existing set without duplicating setups. A lesson with the
 * same signature (strategy + setup tags) and the same scope confirms an existing lesson when its
 * polarity agrees and contradicts it otherwise. Returns a new array; inputs are not mutated.
 */
export function mergeLessons(existing: readonly TradeLesson[], incoming: readonly TradeLesson[]): TradeLesson[] {
  const out: TradeLesson[] = existing.map((l) => ({ ...l, tags: { ...l.tags } }));
  for (const inc of incoming) {
    const sig = lessonSignature(inc);
    const idx = out.findIndex((l) => lessonSignature(l) === sig && scopesMatch(l.scope, inc.scope));
    if (idx === -1) {
      out.push({ ...inc, tags: { ...inc.tags } });
      continue;
    }
    const cur = out[idx] as TradeLesson;
    const agrees = lessonPolarity(cur) === lessonPolarity(inc);
    const n = cur.timesConfirmed + cur.timesContradicted + 1;
    const blended = clamp((cur.confidenceImpact * n + inc.confidenceImpact) / (n + 1), CONFIDENCE_IMPACT_BOUNDS.min, CONFIDENCE_IMPACT_BOUNDS.max);
    out[idx] = {
      ...cur,
      timesConfirmed: cur.timesConfirmed + (agrees ? 1 : 0),
      timesContradicted: cur.timesContradicted + (agrees ? 0 : 1),
      confidenceImpact: blended,
    };
  }
  return out;
}

export interface LessonQuery {
  strategyKey?: string;
  regime?: string;
  tags?: Record<string, string>;
}

export interface RankedLesson {
  lesson: TradeLesson;
  score: number;
  matchedTags: string[];
}

/** Laplace-smoothed confirmation ratio in (0, 1). */
export function confirmationRatio(lesson: Pick<TradeLesson, "timesConfirmed" | "timesContradicted">): number {
  return (lesson.timesConfirmed + 1) / (lesson.timesConfirmed + lesson.timesContradicted + 2);
}

/** Read-only retrieval: lessons from any scope are evidence; nothing is mutated. */
export function retrieveLessons(lessons: readonly TradeLesson[], query: LessonQuery, limit = 10): RankedLesson[] {
  const queryTags = Object.entries(query.tags ?? {});
  const ranked: RankedLesson[] = [];
  for (const lesson of lessons) {
    const matchedTags = queryTags.filter(([k, v]) => lesson.tags[k] === v).map(([k]) => k);
    const overlap = queryTags.length === 0 ? 0 : matchedTags.length / queryTags.length;
    const strategyMatch = query.strategyKey === undefined ? 0 : lesson.strategyKey === query.strategyKey ? 1 : 0;
    const regimeMatch = query.regime === undefined ? 0 : lesson.regime === query.regime ? 1 : 0;
    if (query.strategyKey !== undefined && strategyMatch === 0 && overlap === 0) continue;
    const relevance = 0.5 * overlap + 0.3 * strategyMatch + 0.2 * regimeMatch;
    if (relevance === 0) continue;
    // Confirmation modulates relevance (x0.5 .. x1) rather than dominating it.
    ranked.push({ lesson, score: relevance * (0.5 + 0.5 * confirmationRatio(lesson)), matchedTags });
  }
  ranked.sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  return ranked.slice(0, limit);
}
