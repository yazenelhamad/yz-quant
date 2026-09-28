import type { ConsensusModel } from "../types/index.js";
import { clamp01, isNum, round } from "./math.js";

/**
 * Significance of a variant view relative to how much analysts already disagree.
 * A 10% differentiated forecast means a lot when everyone else is within 2% of each other,
 * and little when estimates are spread ±20%: the uncertainty is already recognised.
 */

export interface VariantSignificance {
  /** |difference| / dispersion, both in percent of consensus. Null when dispersion unknown. */
  z: number | null;
  /** 0..1 */
  significance: number;
  consensusTight: boolean | null;
  uncertaintyAlreadyRecognised: boolean | null;
  interpretation: string;
  notes: string[];
}

const MIN_STD_PCT = 0.5; // avoid dividing by a degenerate zero-dispersion consensus

export function variantSignificance(differencePct: number | null, epsStdDevPct: number | null, analystCount: number | null): VariantSignificance {
  const notes: string[] = [];
  if (!isNum(differencePct)) {
    notes.push("difference vs consensus unknown: significance set to 0");
    return { z: null, significance: 0, consensusTight: null, uncertaintyAlreadyRecognised: null, interpretation: "no variant difference available", notes };
  }
  const absDiff = Math.abs(differencePct);
  if (!isNum(epsStdDevPct) || epsStdDevPct < 0) {
    notes.push("consensus dispersion unknown: significance capped at 0.4");
    const sig = Math.min(0.4, clamp01(absDiff / 40));
    return { z: null, significance: round(sig), consensusTight: null, uncertaintyAlreadyRecognised: null, interpretation: `${round(absDiff, 1)}% difference with unknown dispersion`, notes };
  }
  const std = Math.max(epsStdDevPct, MIN_STD_PCT);
  const z = absDiff / std;
  let countFactor = 0.6;
  if (isNum(analystCount) && analystCount > 0) countFactor = 0.5 + 0.5 * (1 - Math.exp(-analystCount / 5));
  else notes.push("analyst count unknown: dispersion estimate treated as unreliable");
  if (isNum(analystCount) && analystCount < 3) notes.push("fewer than 3 analysts: dispersion is not a meaningful consensus measure");
  const fromZ = 1 - Math.exp(-z / 1.5);
  const significance = round(clamp01(fromZ * countFactor));
  const consensusTight = epsStdDevPct <= 3;
  const uncertaintyAlreadyRecognised = epsStdDevPct >= 10;
  let interpretation: string;
  if (z >= 2) interpretation = `our view sits ${round(z, 1)} dispersion units from consensus: a genuinely differentiated call`;
  else if (z >= 1) interpretation = `our view is ${round(z, 1)} dispersion units from consensus: differentiated but within the debate`;
  else interpretation = `our view is inside the existing dispersion (${round(z, 1)} units): the market already entertains it`;
  if (uncertaintyAlreadyRecognised) interpretation += "; wide dispersion means uncertainty is already recognised";
  return { z: round(z), significance, consensusTight, uncertaintyAlreadyRecognised, interpretation, notes };
}

/** EPS standard deviation as a percent of consensus EPS, from a ConsensusModel. */
export function epsStdDevPct(consensus: ConsensusModel): number | null {
  const std = consensus.dispersion.epsStdDev;
  const eps = consensus.consensusEps;
  if (!isNum(std) || !isNum(eps) || eps === 0) return null;
  return (std / Math.abs(eps)) * 100;
}
