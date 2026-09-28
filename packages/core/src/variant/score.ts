import type { Catalyst, VariantView } from "../types/index.js";
import { clamp01, isNum, round } from "./math.js";

/**
 * Variant Perception Score. Every component lives in [0, 1]; a missing input scores 0 for its
 * component and is recorded in `notes` so nobody mistakes "unknown" for "fine". The score is an
 * input to the decision hierarchy, never an order: `recommendAction` says so explicitly and the
 * portfolio and risk engines still have to approve.
 */

export interface ScoreInputs {
  /** Largest |difference| vs consensus in percent (null when no forecast). */
  expectationGapPct: number | null;
  /** 0..1 from the internal forecast. */
  forecastConfidence: number | null;
  /** 0..1 */
  evidenceQuality: number | null;
  /** 0..1 aggregate catalyst strength. */
  catalystStrength: number | null;
  /** 0..1 timing score. */
  timingScore: number | null;
  /** 0..1 how much of the view is already priced. */
  pricedInScore: number | null;
  /** 0..1 from `variantSignificance`. */
  dispersionSignificance: number | null;
  /** 0..1 positioning crowding. */
  positioningCrowding: number | null;
  upsidePct: number | null;
  downsidePct: number | null;
  /** Explicit override for risk/reward (upside / |downside|) when computed elsewhere. */
  riskReward?: number | null;
}

export const SCORE_WEIGHTS: Record<string, number> = {
  expectationGap: 0.12,
  forecastConfidence: 0.1,
  evidenceQuality: 0.1,
  catalystStrength: 0.12,
  catalystTiming: 0.1,
  notPricedIn: 0.12,
  dispersionSignificance: 0.08,
  positioningNotCrowded: 0.06,
  upside: 0.06,
  downside: 0.06,
  riskReward: 0.08,
};

export interface VariantPerceptionScore {
  total: number;
  components: Record<string, number>;
  notes: string[];
  riskReward: number | null;
  /** True when there is no meaningful variant (gap too small or unknown). */
  noVariantView: boolean;
}

export function riskRewardRatio(upsidePct: number | null, downsidePct: number | null): number | null {
  if (!isNum(upsidePct) || !isNum(downsidePct)) return null;
  const d = Math.abs(downsidePct);
  if (d === 0) return upsidePct > 0 ? 10 : null;
  return round(Math.max(0, upsidePct) / d, 3);
}

export function variantPerceptionScore(input: ScoreInputs): VariantPerceptionScore {
  const notes: string[] = [];
  const components: Record<string, number> = {};
  const set = (key: string, value: number | null, missingNote: string) => {
    if (value === null) {
      components[key] = 0;
      notes.push(`${key}: ${missingNote} (component scored 0)`);
    } else components[key] = round(clamp01(value));
  };

  const gap = isNum(input.expectationGapPct) ? Math.abs(input.expectationGapPct) : null;
  set("expectationGap", gap === null ? null : Math.tanh(gap / 15), "no internal forecast to compare with consensus");
  set("forecastConfidence", isNum(input.forecastConfidence) ? input.forecastConfidence : null, "forecast confidence unknown");
  set("evidenceQuality", isNum(input.evidenceQuality) ? input.evidenceQuality : null, "evidence quality unknown");
  set("catalystStrength", isNum(input.catalystStrength) ? input.catalystStrength : null, "no catalyst strength");
  set("catalystTiming", isNum(input.timingScore) ? input.timingScore : null, "timing not assessed");
  set("notPricedIn", isNum(input.pricedInScore) ? 1 - clamp01(input.pricedInScore) : null, "priced-in share unknown");
  set("dispersionSignificance", isNum(input.dispersionSignificance) ? input.dispersionSignificance : null, "dispersion significance unknown");
  set("positioningNotCrowded", isNum(input.positioningCrowding) ? 1 - clamp01(input.positioningCrowding) : null, "positioning unknown");
  set("upside", isNum(input.upsidePct) ? Math.tanh(Math.max(0, input.upsidePct) / 20) : null, "upside unknown");
  set("downside", isNum(input.downsidePct) ? 1 - Math.tanh(Math.abs(input.downsidePct) / 20) : null, "downside unknown");
  const rr = isNum(input.riskReward) ? input.riskReward : riskRewardRatio(input.upsidePct, input.downsidePct);
  set("riskReward", rr === null ? null : Math.tanh(rr / 3), "risk/reward unknown");

  let total = 0;
  for (const [key, weight] of Object.entries(SCORE_WEIGHTS)) total += weight * (components[key] ?? 0);

  const noVariantView = gap === null || gap < 2;
  if (noVariantView) {
    total = Math.min(total, 0.4);
    notes.push(gap === null ? "no variant view: conviction capped at 0.4" : `variant gap ${round(gap, 1)}% is not meaningful: conviction capped at 0.4`);
  }
  if ((components.catalystStrength ?? 0) < 0.1) {
    total = Math.min(total, 0.5);
    notes.push("no meaningful catalyst: conviction capped at 0.5 (a thesis without a catalyst can stay wrong for a long time)");
  }
  return { total: round(clamp01(total)), components, notes, riskReward: rr, noVariantView };
}

export type RecommendedAction = VariantView["recommendedAction"];
export type PreMortemVerdict = "proceed" | "reduce" | "wait" | "reject";

export interface ActionRecommendation {
  action: RecommendedAction;
  reasons: string[];
  /** Always present: the score never executes anything on its own. */
  disclaimer: string;
}

export const ACTION_DISCLAIMER = "Variant perception output is an input to the thesis, portfolio engine and risk engine; it never places or sizes an order by itself.";

export function recommendAction(
  score: number,
  timing: { appropriate: boolean; score: number },
  preMortemVerdict: PreMortemVerdict | null,
  redTeamSeverity: number | null,
  riskReward: number | null,
): ActionRecommendation {
  const reasons: string[] = [];
  const sev = isNum(redTeamSeverity) ? clamp01(redTeamSeverity) : null;
  if (sev === null) reasons.push("red-team severity unknown: treated as moderate");
  const severity = sev ?? 0.5;
  if (preMortemVerdict === null) reasons.push("pre-mortem missing: treated as 'reduce'");
  const verdict = preMortemVerdict ?? "reduce";

  const decide = (): RecommendedAction => {
    if (verdict === "reject") {
      reasons.push("pre-mortem verdict: reject");
      return "REJECT";
    }
    if (severity >= 0.8) {
      reasons.push(`red team found severe flaws (${severity})`);
      return "REJECT";
    }
    if (score < 0.35) {
      reasons.push(`score ${score} below the 0.35 floor`);
      return "REJECT";
    }
    if (verdict === "wait" || !timing.appropriate) {
      reasons.push(verdict === "wait" ? "pre-mortem verdict: wait" : `timing inappropriate (${timing.score})`);
      if (score >= 0.6) reasons.push("thesis attractive but timing poor — wait");
      return "WAIT";
    }
    if (severity >= 0.6) {
      reasons.push(`red team severity ${severity}: proceed only at reduced size`);
      return "REDUCE";
    }
    if (verdict === "reduce") {
      reasons.push("pre-mortem verdict: reduce");
      return "REDUCE";
    }
    if (riskReward !== null && riskReward < 1.5) {
      reasons.push(`risk/reward ${riskReward} below 1.5: hold, do not add`);
      return "HOLD";
    }
    if (score >= 0.6) {
      reasons.push(`score ${score} with acceptable timing, pre-mortem and red team`);
      return "BUY";
    }
    reasons.push(`score ${score} is in the indeterminate band (0.35..0.6)`);
    return "HOLD";
  };
  const action = decide();
  return { action, reasons, disclaimer: ACTION_DISCLAIMER };
}

const GENERIC_SECOND_ORDER: string[] = [
  "Who has to act because of this event, and are they forced or discretionary?",
  "What does the event do to competitors, suppliers and customers, not just this company?",
  "Which existing positioning gets unwound, and who is the marginal buyer/seller afterwards?",
  "Does the event change the multiple, the estimates, or only the narrative?",
  "What would the market need to see next to keep the move going?",
  "What is the base rate of follow-through after similar events?",
];

const SECOND_ORDER: Record<string, string[]> = {
  rate_cut: [
    "Why is the central bank cutting: growth scare or inflation victory? The reason matters more than the cut.",
    "Which balance sheets benefit from lower rates and which lose (banks' NIM, insurers, floating-rate borrowers)?",
    "Is the cut already in the forward curve? How many cuts does the curve price for the next 12 months?",
    "Does a cut weaken the currency and what does that do to importers vs exporters?",
    "Does lower discounting re-rate long-duration equities, or does the growth scare dominate?",
  ],
  earnings_beat: [
    "Did the beat come from revenue, margin, tax, buyback or a one-off? Only some of these raise future estimates.",
    "Was the beat above the whisper number, not just the published consensus?",
    "What did guidance do? A beat with a guide-down is a miss.",
    "How were investors positioned into the print and what did options imply?",
    "Did estimates for next year rise, or is the beat pulled forward from later quarters?",
  ],
  earnings_miss: [
    "Is the miss company-specific or the first sign of an industry problem? Read across to peers.",
    "Did management reset expectations low enough that the next print is a beat?",
    "Was the miss on volume, price or cost? Each implies a different recovery path.",
    "Who is forced to sell (index rules, mandates, stop-losses) and when does that end?",
  ],
  guidance: [
    "Is the guidance conservative by habit? Check this company's guidance accuracy history.",
    "Which assumptions underlie the guide (FX, pricing, volumes) and which are already stale?",
    "Does the guide change the consensus mid-point or just the range?",
  ],
  regulatory: [
    "Who wins from the rule change: incumbents (compliance moat) or challengers?",
    "What is the implementation timeline and is it enforceable?",
    "Is a legal challenge likely and what happens in the interim?",
  ],
  product_launch: [
    "Is this cannibalising the existing product line or expanding the market?",
    "What is the supply/capacity constraint and who supplies it?",
    "How do competitors respond on price within the next two quarters?",
  ],
  m_and_a: [
    "Who else is a target once this transaction sets a valuation benchmark?",
    "Is the acquirer's stock the currency, and does its fall change the deal?",
    "What has to be divested and who buys it?",
  ],
  sector_rerating: [
    "Is the re-rating driven by flows (ETF, factor) or by fundamentals? Flow-driven re-ratings reverse faster.",
    "Which names in the sector have not moved yet and why?",
    "What does the re-rating do to the sector's cost of capital and capex plans?",
  ],
  economic_data: [
    "Is the data good news for the economy but bad for rate expectations, or the reverse?",
    "Which sectors' earnings are most sensitive to this data series?",
    "Is the print noise (revisions, seasonality) or a change in trend?",
  ],
};

/** Second-order questions the analyst has to answer for an event kind (snake_case, e.g. "rate_cut", "earnings_beat"). */
export function secondOrderChecklist(eventKind: string | Catalyst["kind"]): string[] {
  const key = eventKind.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const specific = SECOND_ORDER[key] ?? (key === "earnings" ? [...SECOND_ORDER.earnings_beat!, ...SECOND_ORDER.earnings_miss!] : []);
  return [...specific, ...GENERIC_SECOND_ORDER];
}
