import { clamp01, isNum, round } from "./math.js";

/**
 * Timing assessment. Being right is not the same as being right at the right time.
 * The output can say "timing poor — wait" even when the thesis itself is attractive.
 */

export interface TechnicalSetup {
  /** -1 (downtrend) .. +1 (uptrend). */
  trend?: number | null;
  /** Percent distance from the 52-week high (0 = at the high, -20 = 20% below). */
  distanceFrom52wHighPct?: number | null;
  rsi?: number | null;
}

export interface TimingInput {
  catalystDaysAway: number | null;
  holdingPeriodDays: number;
  technicalSetup?: TechnicalSetup | null;
  /** 0..1 */
  positioningCrowding?: number | null;
  /** 0..1 */
  liquidityScore?: number | null;
  recentMovePct?: { d5?: number | null; d20?: number | null } | null;
  /** 0..1: how well the current regime suits this kind of trade. */
  regimeFit?: number | null;
  /** Annualised volatility as a fraction (0.3 = 30%). */
  volatility?: number | null;
  /** Days for the signal's edge to halve. */
  signalDecayHalfLife?: number | null;
  /** Days since the signal fired. */
  signalAgeDays?: number | null;
  /** Direction of the intended trade; timing is assessed for this direction. */
  direction?: "long" | "short";
}

export interface TimingAssessment {
  appropriate: boolean;
  score: number;
  reasons: string[];
  components: Record<string, number | null>;
  /** Set when the recommendation is to wait for a better entry. */
  waitFor: string | null;
}

interface Component {
  key: string;
  value: number | null;
  weight: number;
}

export function assessTiming(input: TimingInput): TimingAssessment {
  const reasons: string[] = [];
  const dir = input.direction ?? "long";
  const sideSign = dir === "long" ? 1 : -1;
  const comps: Component[] = [];
  let hardBlock: string | null = null;
  let waitFor: string | null = null;

  // Catalyst proximity vs holding period.
  let catalystScore: number | null;
  if (!isNum(input.catalystDaysAway)) {
    catalystScore = 0.3;
    reasons.push("no dated catalyst inside the plan: time is working against the thesis");
  } else if (input.catalystDaysAway < 0) {
    catalystScore = 0.2;
    reasons.push("catalyst already passed");
  } else if (input.catalystDaysAway <= input.holdingPeriodDays) {
    catalystScore = input.catalystDaysAway < 1 ? 0.8 : 1;
    if (input.catalystDaysAway < 1) reasons.push("catalyst is imminent: entry carries binary event risk");
    else reasons.push(`catalyst in ${Math.round(input.catalystDaysAway)} days, inside the ${input.holdingPeriodDays}-day holding period`);
  } else {
    catalystScore = clamp01(input.holdingPeriodDays / input.catalystDaysAway);
    reasons.push(`catalyst in ${Math.round(input.catalystDaysAway)} days lies beyond the ${input.holdingPeriodDays}-day holding period`);
    if (input.catalystDaysAway > input.holdingPeriodDays * 2) {
      waitFor = `closer to the catalyst (~${Math.round(input.catalystDaysAway - input.holdingPeriodDays)} days)`;
    }
  }
  comps.push({ key: "catalystProximity", value: catalystScore, weight: 0.25 });

  // Technical setup.
  const t = input.technicalSetup;
  let momentumExhausted = false;
  if (t && (isNum(t.trend) || isNum(t.rsi) || isNum(t.distanceFrom52wHighPct))) {
    let score = 0.5;
    if (isNum(t.trend)) {
      score += 0.25 * sideSign * Math.max(-1, Math.min(1, t.trend));
    }
    if (isNum(t.rsi)) {
      const overbought = t.rsi >= 75;
      const oversold = t.rsi <= 25;
      if (dir === "long" && overbought) {
        score -= 0.25;
        momentumExhausted = true;
        reasons.push(`RSI ${Math.round(t.rsi)}: momentum extended`);
      } else if (dir === "long" && oversold) {
        reasons.push(`RSI ${Math.round(t.rsi)}: oversold, entry not chased`);
      } else if (dir === "short" && oversold) {
        score -= 0.25;
        momentumExhausted = true;
        reasons.push(`RSI ${Math.round(t.rsi)}: downside momentum extended`);
      }
    }
    if (isNum(t.distanceFrom52wHighPct)) {
      if (dir === "long" && t.distanceFrom52wHighPct >= -2) {
        score -= 0.1;
        reasons.push("at the 52-week high: little room before resistance");
      }
    }
    comps.push({ key: "technical", value: clamp01(score), weight: 0.15 });
  } else {
    comps.push({ key: "technical", value: null, weight: 0.15 });
    reasons.push("technical setup unknown");
  }

  // Recent move: chasing a move that already happened.
  const d5 = input.recentMovePct?.d5;
  const d20 = input.recentMovePct?.d20;
  if (isNum(d5) || isNum(d20)) {
    const m5 = isNum(d5) ? d5 * sideSign : 0;
    const m20 = isNum(d20) ? d20 * sideSign : 0;
    let score = 1;
    if (m5 > 8 || m20 > 20) {
      score = 0.2;
      momentumExhausted = true;
      reasons.push(`the move already happened (5d ${isNum(d5) ? round(d5, 1) : "n/a"}%, 20d ${isNum(d20) ? round(d20, 1) : "n/a"}%)`);
    } else if (m5 > 4 || m20 > 12) {
      score = 0.55;
      reasons.push("entry after a sizeable recent move");
    } else if (m5 < -8 || m20 < -20) {
      score = 0.6;
      reasons.push("entering against a sharp adverse move: confirm the thesis is not what the market is repricing");
    }
    comps.push({ key: "recentMove", value: score, weight: 0.15 });
  } else {
    comps.push({ key: "recentMove", value: null, weight: 0.15 });
    reasons.push("recent price action unknown");
  }

  if (isNum(input.positioningCrowding)) {
    const v = clamp01(1 - input.positioningCrowding);
    comps.push({ key: "positioning", value: v, weight: 0.12 });
    if (input.positioningCrowding >= 0.7) reasons.push("positioning is crowded: the entry competes with everyone already in");
  } else {
    comps.push({ key: "positioning", value: null, weight: 0.12 });
    reasons.push("positioning unknown");
  }

  if (isNum(input.liquidityScore)) {
    comps.push({ key: "liquidity", value: clamp01(input.liquidityScore), weight: 0.08 });
    if (input.liquidityScore < 0.3) reasons.push("liquidity is thin");
  } else comps.push({ key: "liquidity", value: null, weight: 0.08 });

  if (isNum(input.regimeFit)) {
    comps.push({ key: "regimeFit", value: clamp01(input.regimeFit), weight: 0.12 });
    if (input.regimeFit < 0.35) reasons.push("current regime does not favour this kind of trade");
  } else {
    comps.push({ key: "regimeFit", value: null, weight: 0.12 });
    reasons.push("regime fit unknown");
  }

  if (isNum(input.volatility)) {
    const v = input.volatility > 0.8 ? 0.3 : input.volatility > 0.5 ? 0.6 : 1;
    comps.push({ key: "volatility", value: v, weight: 0.06 });
    if (v < 1) reasons.push(`volatility ${Math.round(input.volatility * 100)}% annualised: sizing and stops need room`);
  } else comps.push({ key: "volatility", value: null, weight: 0.06 });

  if (isNum(input.signalDecayHalfLife) && input.signalDecayHalfLife > 0 && isNum(input.signalAgeDays)) {
    const remaining = Math.pow(0.5, Math.max(0, input.signalAgeDays) / input.signalDecayHalfLife);
    comps.push({ key: "signalFreshness", value: clamp01(remaining), weight: 0.07 });
    if (remaining < 0.5) reasons.push(`signal is ${round(input.signalAgeDays, 0)} days old with a ${input.signalDecayHalfLife}-day half-life: most of its edge has decayed`);
  } else comps.push({ key: "signalFreshness", value: null, weight: 0.07 });

  // Weighted score over available components; missing components count as 0.3 (unknown is not fine).
  let num = 0;
  let den = 0;
  const components: Record<string, number | null> = {};
  let missing = 0;
  for (const c of comps) {
    components[c.key] = c.value === null ? null : round(c.value);
    const v = c.value === null ? 0.3 : c.value;
    if (c.value === null) missing++;
    num += v * c.weight;
    den += c.weight;
  }
  let score = den > 0 ? num / den : 0;
  if (missing > 0) reasons.push(`${missing} timing input(s) missing: treated as unfavourable`);

  if (momentumExhausted && isNum(input.catalystDaysAway) && input.catalystDaysAway > input.holdingPeriodDays) {
    hardBlock = "catalyst is far and momentum is exhausted";
    waitFor = waitFor ?? "a pullback or a dated catalyst inside the holding period";
  }
  if (momentumExhausted && !isNum(input.catalystDaysAway)) {
    hardBlock = "no dated catalyst and momentum is exhausted";
    waitFor = waitFor ?? "a pullback and a dated catalyst";
  }
  if (hardBlock) score = Math.min(score, 0.4);

  const appropriate = hardBlock === null && score >= 0.55;
  if (!appropriate) {
    reasons.unshift(`Timing poor — wait${waitFor ? ` for ${waitFor}` : ""}${hardBlock ? ` (${hardBlock})` : ""}`);
  }
  return { appropriate, score: round(clamp01(score)), reasons, components, waitFor: appropriate ? null : waitFor };
}
