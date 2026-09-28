import type { RegimeAssessment } from "../../types/index.js";
import { clamp } from "../../features/math.js";
import { WEIGHT_MULTIPLIER_BOUNDS } from "./combine.js";

export interface SignalWeightProfile {
  key: string;
  /** Long-run information coefficient (e.g. rank correlation of signal with forward return). */
  historicalIC: number | null;
  /** Recent-window information coefficient. */
  recentIC: number | null;
  /** Regime label -> relative performance multiplier delta in [-1, 1] (0 = neutral). */
  regimeDependence: Record<string, number>;
  /** Fraction of edge lost recently in [0, 1] (0 = intact, 1 = fully decayed). Null = unknown. */
  decay: number | null;
  /** Optional per-signal hard bounds; default to the global bounds. */
  weightBounds?: { min: number; max: number };
}

export interface AdaptiveWeightBounds {
  min: number;
  max: number;
  /** Base weight before adaptation; default 1. */
  base?: number;
  /** IC at which the IC factor saturates; default 0.05. */
  icScale?: number;
}

/**
 * Compute adaptive signal weights from learning-engine profiles.
 *
 * weight = base × icFactor × regimeFactor × decayFactor, where
 *   icFactor     = 1 + 0.5 × clamp(blendedIC / icScale, -1, 1)   (blendedIC = ½ historical + ½ recent)
 *   regimeFactor = 1 + 0.5 × Σ_label p(label) × dependence(label)
 *   decayFactor  = 1 − 0.5 × decay
 * and the result is clamped to the hard bounds (per-signal bounds intersected with the global
 * bounds, which themselves never exceed [0.25, 2] × base). Unknown inputs are neutral.
 */
export function computeAdaptiveWeights(profiles: readonly SignalWeightProfile[], regime: RegimeAssessment, bounds: AdaptiveWeightBounds): Record<string, number> {
  const base = bounds.base ?? 1;
  const icScale = bounds.icScale ?? 0.05;
  const globalMin = Math.max(bounds.min, base * WEIGHT_MULTIPLIER_BOUNDS.min);
  const globalMax = Math.min(bounds.max, base * WEIGHT_MULTIPLIER_BOUNDS.max);
  const out: Record<string, number> = {};
  for (const p of profiles) {
    const ics = [p.historicalIC, p.recentIC].filter((x): x is number => x !== null && Number.isFinite(x));
    const blendedIC = ics.length === 0 ? 0 : ics.reduce((a, b) => a + b, 0) / ics.length;
    const icFactor = 1 + 0.5 * clamp(blendedIC / icScale, -1, 1);
    let regimeTerm = 0;
    for (const [label, dep] of Object.entries(p.regimeDependence)) {
      const prob = (regime.probabilities as Record<string, number | undefined>)[label] ?? 0;
      regimeTerm += prob * clamp(dep, -1, 1);
    }
    const regimeFactor = 1 + 0.5 * clamp(regimeTerm, -1, 1);
    const decayFactor = 1 - 0.5 * clamp(p.decay ?? 0, 0, 1);
    const raw = base * icFactor * regimeFactor * decayFactor;
    const lo = Math.max(globalMin, p.weightBounds?.min ?? globalMin);
    const hi = Math.min(globalMax, p.weightBounds?.max ?? globalMax);
    out[p.key] = Math.round(clamp(raw, Math.min(lo, hi), Math.max(lo, hi)) * 1e4) / 1e4;
  }
  return out;
}
