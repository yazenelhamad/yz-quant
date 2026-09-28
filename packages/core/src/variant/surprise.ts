import type { ExpectationsRecord } from "../types/index.js";
import { clamp01, isNum, leastSquares, pctDiff, round, sign } from "./math.js";

/**
 * Expected surprise model. The question is not "will the company beat?" but
 * "how will the stock react given what is already priced and who is already positioned?".
 * A positive surprise with a crowded, fully priced setup can produce a negative reaction.
 */

export interface SensitivityEstimate {
  /** Stock reaction (%) per 1% surprise. */
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  metric: string;
}

export function surpriseOfRecord(record: ExpectationsRecord, metric: string): number | null {
  const actual = record.actualResult?.[metric];
  const consensus = record.consensus[metric];
  return pctDiff(actual ?? null, consensus ?? null);
}

/** Least-squares regression of reaction % on surprise % across resolved records. Null with fewer than 4 usable points. */
export function historicalSensitivity(records: readonly ExpectationsRecord[], metric = "eps"): SensitivityEstimate | null {
  const points: { x: number; y: number }[] = [];
  for (const r of records) {
    const x = surpriseOfRecord(r, metric);
    const y = r.reactionPct;
    if (x === null || !isNum(y)) continue;
    points.push({ x, y });
  }
  const fit = leastSquares(points, 4);
  if (!fit) return null;
  return { slope: round(fit.slope), intercept: round(fit.intercept), r2: round(fit.r2), n: fit.n, metric };
}

export interface ExpectedSurpriseInput {
  metric: string;
  consensus: number | null;
  internal: number | null;
  /** 0..100: share of our expected surprise the market already discounts. */
  pricedInPct: number | null;
  /** Reaction % per 1% surprise (from `historicalSensitivity`). */
  historicalSensitivity: number | null;
  impliedMovePct: number | null;
  /** 0..1 position of the current valuation inside its own history (1 = richest ever). */
  valuationPercentile: number | null;
  /** 0..1 positioning crowding. */
  crowding: number | null;
}

export interface ExpectedSurpriseResult {
  metric: string;
  consensus: number | null;
  internal: number | null;
  surprisePct: number | null;
  pricedInPct: number | null;
  historicalSensitivity: number | null;
  adjustedImpactPct: number | null;
  /** Unadjusted surprise × sensitivity. */
  rawImpactPct: number | null;
  reasoning: string[];
  notes: string[];
}

export function expectedSurprise(input: ExpectedSurpriseInput): ExpectedSurpriseResult {
  const reasoning: string[] = [];
  const notes: string[] = [];
  const consensus = isNum(input.consensus) ? input.consensus : null;
  const internal = isNum(input.internal) ? input.internal : null;
  const sensitivity = isNum(input.historicalSensitivity) ? input.historicalSensitivity : null;
  const pricedIn = isNum(input.pricedInPct) ? Math.max(0, Math.min(100, input.pricedInPct)) : null;
  const crowding = isNum(input.crowding) ? clamp01(input.crowding) : null;
  const valuationPct = isNum(input.valuationPercentile) ? clamp01(input.valuationPercentile) : null;
  const implied = isNum(input.impliedMovePct) ? Math.abs(input.impliedMovePct) : null;

  const base: ExpectedSurpriseResult = { metric: input.metric, consensus, internal, surprisePct: null, pricedInPct: pricedIn, historicalSensitivity: sensitivity, adjustedImpactPct: null, rawImpactPct: null, reasoning, notes };

  const surprisePct = pctDiff(internal, consensus);
  if (surprisePct === null) {
    notes.push(`cannot compute expected ${input.metric} surprise: consensus or internal forecast missing`);
    return base;
  }
  base.surprisePct = round(surprisePct, 2);
  reasoning.push(`internal ${input.metric} ${internal} vs consensus ${consensus}: expected surprise ${round(surprisePct, 1)}%`);

  if (sensitivity === null) {
    notes.push("no historical sensitivity (fewer than 4 resolved events): reaction not estimated, not guessed");
    return base;
  }
  const raw = surprisePct * sensitivity;
  base.rawImpactPct = round(raw, 2);
  reasoning.push(`historical sensitivity ${sensitivity}% per 1% surprise ⇒ raw reaction ${round(raw, 1)}%`);

  let adjusted = raw;
  if (pricedIn !== null) {
    adjusted *= 1 - pricedIn / 100;
    reasoning.push(`${pricedIn}% of the surprise already priced ⇒ ${round(adjusted, 1)}%`);
  } else notes.push("priced-in share unknown: no priced-in adjustment applied (reaction may be overstated)");

  if (crowding !== null) {
    adjusted *= 1 - 0.5 * crowding;
    reasoning.push(`crowding ${crowding} dampens the reaction ⇒ ${round(adjusted, 1)}%`);
    if (surprisePct > 0 && crowding >= 0.7 && (pricedIn ?? 0) >= 60) {
      const unwind = implied !== null ? 0.25 * crowding * implied : 0.25 * crowding * Math.abs(raw);
      adjusted -= unwind;
      reasoning.push(`crowded and largely priced: positioning unwind risk of ${round(unwind, 1)}% subtracted — a beat can still sell off`);
    }
  } else notes.push("crowding unknown: no positioning adjustment");

  if (valuationPct !== null) {
    if (valuationPct > 0.5) {
      const stretch = (valuationPct - 0.5) * 2; // 0..1
      if (adjusted > 0) {
        adjusted *= 1 - 0.4 * stretch;
        reasoning.push(`valuation in the ${Math.round(valuationPct * 100)}th percentile of its history: upside reaction muted`);
      } else if (adjusted < 0) {
        adjusted *= 1 + 0.4 * stretch;
        reasoning.push(`rich valuation amplifies the downside reaction`);
      }
    } else if (valuationPct < 0.3 && adjusted < 0) {
      adjusted *= 0.8;
      reasoning.push("cheap valuation cushions the downside reaction");
    }
  } else notes.push("valuation percentile unknown: no valuation asymmetry applied");

  if (implied !== null && implied > 0) {
    const cap = 2 * implied;
    if (Math.abs(adjusted) > cap) {
      adjusted = sign(adjusted) * cap;
      reasoning.push(`capped at 2× the options implied move (${implied}%)`);
    } else if (Math.abs(adjusted) < 0.25 * implied) {
      reasoning.push(`expected reaction is small relative to the ${implied}% implied move: the options market expects more than our thesis delivers`);
    }
  } else notes.push("options implied move unknown: no sanity cap on the reaction");

  base.adjustedImpactPct = round(adjusted, 2);
  if (surprisePct > 0 && adjusted <= 0) reasoning.push("positive surprise, non-positive expected reaction: the setup, not the fundamentals, decides the trade");
  return base;
}
