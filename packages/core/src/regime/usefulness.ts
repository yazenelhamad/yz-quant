import type { RegimeAssessment, RegimeLabel } from "../types/index.js";
import { clamp, mean } from "../features/math.js";

export interface RegimeHistoryPoint {
  assessment: RegimeAssessment;
  /** Realised return of the market (SPY) over the following 5 trading days, as a fraction. */
  forwardReturn5d: number | null;
  /** Realised (annualised) volatility over the following 5 trading days. */
  forwardVol5d: number | null;
}

export interface RegimeUsefulness {
  /** -1..1: 0 = no better than chance, 1 = every classification was borne out. */
  score: number;
  hitRate: number | null;
  samples: number;
  byLabel: Record<string, { samples: number; hitRate: number | null }>;
  notes: string[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/**
 * Measures whether regime classifications had predictive value. Each primary label implies a
 * testable statement about the next five days; the score is the confidence-weighted hit rate
 * mapped to [-1, 1]. Labels with no testable implication (sector_rotation, event_driven without
 * vol data) are skipped rather than counted as hits.
 */
export function regimeUsefulnessScore(history: readonly RegimeHistoryPoint[]): RegimeUsefulness {
  const notes: string[] = [];
  const rets = history.map((h) => h.forwardReturn5d).filter((x): x is number => x !== null);
  const vols = history.map((h) => h.forwardVol5d).filter((x): x is number => x !== null);
  const medVol = median(vols);
  const medAbsRet = median(rets.map((r) => Math.abs(r)));
  const byLabel: Record<string, { samples: number; hits: number; weights: number; weightedHits: number }> = {};
  let weights = 0;
  let weightedHits = 0;
  let samples = 0;

  for (const h of history) {
    const label: RegimeLabel = h.assessment.primary;
    const r = h.forwardReturn5d;
    const v = h.forwardVol5d;
    let hit: boolean | null = null;
    switch (label) {
      case "bull_trend":
      case "risk_on":
        hit = r === null ? null : r > 0; break;
      case "bear_trend":
      case "risk_off":
        hit = r === null ? null : r < 0; break;
      case "high_volatility":
      case "liquidity_shock":
      case "event_driven":
        hit = v === null || medVol === null ? null : v > medVol; break;
      case "low_volatility":
        hit = v === null || medVol === null ? null : v <= medVol; break;
      case "range_bound":
        hit = r === null || medAbsRet === null ? null : Math.abs(r) <= medAbsRet; break;
      case "momentum": {
        const t = h.assessment.metrics.spyTrend20;
        hit = r === null || t === null || t === 0 ? null : Math.sign(r) === Math.sign(t); break;
      }
      case "mean_reversion": {
        const t = h.assessment.metrics.spyTrend20;
        hit = r === null || t === null || t === 0 ? null : Math.sign(r) === -Math.sign(t); break;
      }
      case "sector_rotation":
        hit = null; break;
      default:
        hit = null;
    }
    if (hit === null) continue;
    const w = clamp(0.5 + 0.5 * h.assessment.confidence, 0.5, 1);
    samples += 1;
    weights += w;
    weightedHits += hit ? w : 0;
    const entry = byLabel[label] ?? { samples: 0, hits: 0, weights: 0, weightedHits: 0 };
    entry.samples += 1;
    entry.hits += hit ? 1 : 0;
    entry.weights += w;
    entry.weightedHits += hit ? w : 0;
    byLabel[label] = entry;
  }

  const hitRate = weights > 0 ? weightedHits / weights : null;
  const score = hitRate === null ? 0 : clamp(2 * hitRate - 1, -1, 1);
  if (samples < 20) notes.push(`Only ${samples} testable classifications; treat the score as indicative.`);
  if (hitRate !== null) notes.push(`Confidence-weighted hit rate ${(hitRate * 100).toFixed(0)}% over ${samples} samples.`);
  const out: Record<string, { samples: number; hitRate: number | null }> = {};
  for (const [k, v] of Object.entries(byLabel)) out[k] = { samples: v.samples, hitRate: v.weights > 0 ? v.weightedHits / v.weights : null };
  const avgConf = mean(history.map((h) => h.assessment.confidence));
  if (avgConf !== null && hitRate !== null && avgConf > hitRate + 0.2) notes.push("Regime confidence exceeds realised hit rate: the engine is overconfident.");
  return { score, hitRate, samples, byLabel: out, notes };
}
