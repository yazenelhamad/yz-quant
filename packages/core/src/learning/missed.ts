import type { RejectedTrade, RejectionReason } from "../types/index.js";
import { isFiniteNumber, mean, pct } from "./math.js";

/**
 * Rejections made by policy controls. Even when the price subsequently rises, these are correct
 * rejections: the control did exactly what it exists for. The forward return is recorded as
 * research evidence and nothing else.
 */
export const POLICY_REJECTION_REASONS: ReadonlySet<RejectionReason> = new Set([
  "stale_data",
  "kill_switch",
  "risk_limit_exceeded",
  "autonomy_level",
  "broker_unavailable",
  "identity_uncertain",
  "strategy_disabled",
]);

/** Rejections that were a judgement about the opportunity itself and can therefore be "missed". */
export const JUDGEMENT_REJECTION_REASONS: ReadonlySet<RejectionReason> = new Set([
  "insufficient_confidence",
  "insufficient_expected_edge",
]);

export const DEFAULT_EXPECTED_DOWNSIDE_PCT = 2;
/** Forward return must exceed this multiple of the expected downside to count as missed. */
export const MISSED_OPPORTUNITY_MULTIPLE = 2;

export type ForwardHorizon = "1d" | "5d" | "20d";
export type SubsequentPrices = Partial<Record<ForwardHorizon, number | null>>;

export interface MissedOpportunityReview {
  /** Marker: this object is evidence for research, never an instruction to change settings. */
  readonly kind: "missed_opportunity_review";
  rejectedTradeId: string;
  scope: RejectedTrade["scope"];
  verdict: NonNullable<RejectedTrade["reviewVerdict"]>;
  horizon: ForwardHorizon | null;
  forwardReturnPct: number | null;
  subsequentReturnPct: Record<string, number>;
  policyRejection: boolean;
  reasons: RejectionReason[];
  note: string;
  /** Copy of the rejection with the review fields filled in. The input is not mutated. */
  rejected: RejectedTrade;
}

export function horizonForHolding(expectedHoldingDays: number): ForwardHorizon {
  if (expectedHoldingDays <= 1) return "1d";
  if (expectedHoldingDays <= 5) return "5d";
  return "20d";
}

export interface RejectedReviewOptions {
  expectedHoldingDays: number;
  expectedDownsidePct?: number;
}

export function reviewRejectedTrade(rejected: RejectedTrade, subsequentPrices: SubsequentPrices, options: RejectedReviewOptions | number): MissedOpportunityReview {
  const opts: RejectedReviewOptions = typeof options === "number" ? { expectedHoldingDays: options } : options;
  const downside = Math.abs(opts.expectedDownsidePct ?? DEFAULT_EXPECTED_DOWNSIDE_PCT);
  const base = rejected.priceAtRejection;
  const subsequentReturnPct: Record<string, number> = {};
  if (isFiniteNumber(base) && base > 0) {
    for (const h of ["1d", "5d", "20d"] as const) {
      const p = subsequentPrices[h];
      if (isFiniteNumber(p)) subsequentReturnPct[h] = Math.round((p / base - 1) * 1e8) / 1e6;
    }
  }
  const horizon = horizonForHolding(opts.expectedHoldingDays);
  const forward = subsequentReturnPct[horizon] ?? null;
  const policyReasons = rejected.reasons.filter((r) => POLICY_REJECTION_REASONS.has(r));
  const judgementReasons = rejected.reasons.filter((r) => JUDGEMENT_REJECTION_REASONS.has(r));
  const policyRejection = policyReasons.length > 0;

  let verdict: MissedOpportunityReview["verdict"];
  let note: string;
  if (forward === null) {
    verdict = "undetermined";
    note = isFiniteNumber(base) ? `No ${horizon} price is available yet, so the outcome is undetermined.` : "No price at rejection was recorded, so the outcome cannot be evaluated.";
  } else if (policyRejection) {
    verdict = "correct_rejection";
    note = `Rejected by policy control (${policyReasons.join(", ")}); the ${horizon} return of ${pct(forward)} is recorded as research evidence only. Policy controls are correct by construction and are never loosened by this review.`;
  } else if (judgementReasons.length > 0) {
    if (forward > MISSED_OPPORTUNITY_MULTIPLE * downside) {
      verdict = "missed_opportunity";
      note = `Rejected for ${judgementReasons.join(", ")} but ${rejected.symbol} returned ${pct(forward)} over ${horizon}, more than ${MISSED_OPPORTUNITY_MULTIPLE}x the expected downside of ${pct(-downside)}. Evidence for research into the confidence/edge thresholds; not a settings change.`;
    } else if (forward < 0) {
      verdict = "correct_rejection";
      note = `Rejected for ${judgementReasons.join(", ")} and ${rejected.symbol} went on to return ${pct(forward)} over ${horizon}.`;
    } else {
      verdict = "undetermined";
      note = `Rejected for ${judgementReasons.join(", ")}; the ${horizon} return of ${pct(forward)} is positive but within noise (needs > ${pct(MISSED_OPPORTUNITY_MULTIPLE * downside)}).`;
    }
  } else {
    // Other judgement-adjacent reasons (liquidity, event risk, concentration, devil's advocate...).
    verdict = forward < 0 ? "correct_rejection" : "undetermined";
    note = forward < 0
      ? `Rejected for ${rejected.reasons.join(", ")} and the ${horizon} return was ${pct(forward)}.`
      : `Rejected for ${rejected.reasons.join(", ")}; the ${horizon} return of ${pct(forward)} is noted, but these reasons are not judgements about edge or confidence, so no missed-opportunity verdict is drawn.`;
  }

  return {
    kind: "missed_opportunity_review",
    rejectedTradeId: rejected.id,
    scope: rejected.scope,
    verdict,
    horizon: forward === null ? null : horizon,
    forwardReturnPct: forward,
    subsequentReturnPct,
    policyRejection,
    reasons: [...rejected.reasons],
    note,
    rejected: { ...rejected, reasons: [...rejected.reasons], subsequentReturnPct: { ...subsequentReturnPct }, reviewVerdict: verdict },
  };
}

export interface RejectionReasonSummary {
  reason: RejectionReason;
  count: number;
  evaluated: number;
  wouldHaveWon: number;
  hitRate: number | null;
  avgForwardReturnPct: number | null;
  missedOpportunities: number;
  policy: boolean;
}

export interface RejectionCalibrationSummary {
  /** Marker: research evidence only. There is no field that a settings writer could consume. */
  readonly kind: "research_evidence";
  byReason: Record<string, RejectionReasonSummary>;
  recommendations: string[];
}

/** Aggregates rejection reviews by reason into text recommendations for research. Never a settings change. */
export function summarizeRejectionCalibration(reviews: readonly MissedOpportunityReview[]): RejectionCalibrationSummary {
  const byReason: Record<string, RejectionReasonSummary> = {};
  for (const review of reviews) {
    for (const reason of review.reasons) {
      const s = (byReason[reason] ??= { reason, count: 0, evaluated: 0, wouldHaveWon: 0, hitRate: null, avgForwardReturnPct: null, missedOpportunities: 0, policy: POLICY_REJECTION_REASONS.has(reason) });
      s.count += 1;
      if (review.forwardReturnPct !== null) {
        s.evaluated += 1;
        if (review.forwardReturnPct > 0) s.wouldHaveWon += 1;
      }
      if (review.verdict === "missed_opportunity") s.missedOpportunities += 1;
    }
  }
  const recommendations: string[] = [];
  for (const reason of Object.keys(byReason).sort()) {
    const s = byReason[reason] as RejectionReasonSummary;
    const forwards = reviews.filter((r) => r.reasons.includes(s.reason) && r.forwardReturnPct !== null).map((r) => r.forwardReturnPct as number);
    s.hitRate = s.evaluated === 0 ? null : s.wouldHaveWon / s.evaluated;
    s.avgForwardReturnPct = mean(forwards);
    if (s.policy) {
      recommendations.push(`${reason}: ${s.count} rejections by policy control${s.hitRate !== null ? ` (${(s.hitRate * 100).toFixed(0)}% would have been profitable)` : ""}. These are correct by construction; no threshold change is implied.`);
    } else if (s.evaluated < 10) {
      recommendations.push(`${reason}: ${s.count} rejections, ${s.evaluated} evaluated. Too few to draw a conclusion.`);
    } else if (s.hitRate !== null && s.hitRate > 0.6 && s.missedOpportunities >= 3) {
      recommendations.push(`${reason}: ${(s.hitRate * 100).toFixed(0)}% of ${s.evaluated} evaluated rejections would have been profitable (${s.missedOpportunities} clear misses, average forward return ${pct(s.avgForwardReturnPct)}). Worth a research study of the threshold; any change must go through the validation pipeline.`);
    } else {
      recommendations.push(`${reason}: ${(s.hitRate === null ? 0 : s.hitRate * 100).toFixed(0)}% of ${s.evaluated} evaluated rejections would have been profitable (average forward return ${pct(s.avgForwardReturnPct)}). The threshold looks reasonable.`);
    }
  }
  return { kind: "research_evidence", byReason, recommendations };
}
