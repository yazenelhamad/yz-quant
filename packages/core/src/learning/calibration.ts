import type { CalibrationBucket, CalibrationProfile, IsoTimestamp } from "../types/index.js";
import { clamp, isFiniteNumber } from "./math.js";

export const CALIBRATION_BUCKET_EDGES: readonly number[] = Object.freeze([0, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);

/** The adjustment can shrink confidence a lot but only ever nudge it up slightly. */
export const CALIBRATION_ADJUSTMENT_BOUNDS = Object.freeze({ min: 0.6, max: 1.1 });

export interface CalibrationObservation {
  predicted: number;
  success: boolean;
}

export function bucketIndex(p: number): number {
  const x = clamp(p, 0, 1);
  for (let i = 0; i < CALIBRATION_BUCKET_EDGES.length - 1; i++) {
    const upper = CALIBRATION_BUCKET_EDGES[i + 1] as number;
    if (x < upper || (i === CALIBRATION_BUCKET_EDGES.length - 2 && x <= upper)) return i;
  }
  return CALIBRATION_BUCKET_EDGES.length - 2;
}

export function bucketLabelFor(p: number): string {
  const i = bucketIndex(p);
  return `${CALIBRATION_BUCKET_EDGES[i]}-${CALIBRATION_BUCKET_EDGES[i + 1]}`;
}

export function emptyCalibration(key: string, now: IsoTimestamp): CalibrationProfile {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < CALIBRATION_BUCKET_EDGES.length - 1; i++) {
    buckets.push({ lower: CALIBRATION_BUCKET_EDGES[i] as number, upper: CALIBRATION_BUCKET_EDGES[i + 1] as number, predictions: 0, successes: 0, observed: null, predicted: null });
  }
  return { key, buckets, brierScore: null, expectedCalibrationError: null, overconfidenceRatio: null, sampleSize: 0, updatedAt: now };
}

function summarise(buckets: CalibrationBucket[]): Pick<CalibrationProfile, "expectedCalibrationError" | "overconfidenceRatio" | "sampleSize"> {
  const n = buckets.reduce((a, b) => a + b.predictions, 0);
  if (n === 0) return { expectedCalibrationError: null, overconfidenceRatio: null, sampleSize: 0 };
  let ece = 0;
  let sumPred = 0;
  let sumObs = 0;
  for (const b of buckets) {
    if (b.predictions === 0 || b.observed === null || b.predicted === null) continue;
    ece += (b.predictions / n) * Math.abs(b.observed - b.predicted);
    sumPred += b.predicted * b.predictions;
    sumObs += b.successes;
  }
  const meanPred = sumPred / n;
  const meanObs = sumObs / n;
  return { expectedCalibrationError: ece, overconfidenceRatio: meanObs > 0 ? meanPred / meanObs : null, sampleSize: n };
}

/**
 * Folds new observations into a calibration profile. Bucket counts, average predicted
 * probability and the Brier score are all updated incrementally so the profile never needs the
 * raw history. Returns a new profile; the input is not mutated.
 */
export function updateCalibration(profile: CalibrationProfile | null, observations: readonly CalibrationObservation[], now: IsoTimestamp, key = "system"): CalibrationProfile {
  const base = profile ?? emptyCalibration(key, now);
  const buckets: CalibrationBucket[] = base.buckets.map((b) => ({ ...b }));
  let brierSum = (base.brierScore ?? 0) * base.sampleSize;
  let added = 0;
  for (const o of observations) {
    if (!isFiniteNumber(o.predicted)) continue;
    const p = clamp(o.predicted, 0, 1);
    const b = buckets[bucketIndex(p)] as CalibrationBucket;
    const prevPred = (b.predicted ?? 0) * b.predictions;
    b.predictions += 1;
    b.successes += o.success ? 1 : 0;
    b.predicted = (prevPred + p) / b.predictions;
    b.observed = b.successes / b.predictions;
    brierSum += (p - (o.success ? 1 : 0)) ** 2;
    added += 1;
  }
  const summary = summarise(buckets);
  const total = base.sampleSize + added;
  return {
    key: base.key,
    buckets,
    brierScore: total > 0 ? brierSum / total : null,
    expectedCalibrationError: summary.expectedCalibrationError,
    overconfidenceRatio: summary.overconfidenceRatio,
    sampleSize: total,
    updatedAt: now,
  };
}

/**
 * Multiplicative confidence adjustment derived from the overconfidence ratio, bounded to
 * [0.6, 1.1]. Partial shrinkage toward 1 between `minSamples` and `3 * minSamples` observations.
 */
export function calibrationAdjustment(profile: CalibrationProfile | null, minSamples = 30): number {
  if (!profile || profile.sampleSize < minSamples || profile.overconfidenceRatio === null || profile.overconfidenceRatio <= 0) return 1;
  const target = 1 / profile.overconfidenceRatio;
  const weight = clamp(profile.sampleSize / (3 * minSamples), 1 / 3, 1);
  const adjusted = 1 + weight * (target - 1);
  return clamp(adjusted, CALIBRATION_ADJUSTMENT_BOUNDS.min, CALIBRATION_ADJUSTMENT_BOUNDS.max);
}

/** Pool-adjacent-violators: weighted monotone non-decreasing fit of bucket observed rates. */
export function isotonicBucketRates(buckets: readonly CalibrationBucket[]): (number | null)[] {
  const blocks: { value: number; weight: number; indices: number[] }[] = [];
  buckets.forEach((b, i) => {
    if (b.observed === null || b.predictions === 0) return;
    blocks.push({ value: b.observed, weight: b.predictions, indices: [i] });
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1] as (typeof blocks)[number];
      const prev = blocks[blocks.length - 2] as (typeof blocks)[number];
      if (prev.value <= last.value) break;
      const w = prev.weight + last.weight;
      blocks.splice(blocks.length - 2, 2, { value: (prev.value * prev.weight + last.value * last.weight) / w, weight: w, indices: [...prev.indices, ...last.indices] });
    }
  });
  const out: (number | null)[] = buckets.map(() => null);
  for (const block of blocks) for (const i of block.indices) out[i] = block.value;
  return out;
}

/**
 * Maps a raw confidence through the observed hit rate of its bucket (isotonic across buckets),
 * shrinking toward the raw value when the bucket has few samples.
 */
export function calibratedConfidence(raw: number, profile: CalibrationProfile | null, minSamplesPerBucket = 10): number {
  const p = clamp(raw, 0, 1);
  if (!profile || profile.sampleSize === 0) return p;
  const rates = isotonicBucketRates(profile.buckets);
  const i = bucketIndex(p);
  const mapped = rates[i];
  const bucket = profile.buckets[i];
  if (mapped === null || mapped === undefined || !bucket) return p;
  const w = bucket.predictions / (bucket.predictions + minSamplesPerBucket);
  return clamp(w * mapped + (1 - w) * p, 0, 1);
}

export interface OverconfidenceRule {
  minSamples?: number;
  ratioThreshold?: number;
  eceThreshold?: number;
}

/** True when predictions systematically exceed outcomes; null when there is not enough data. */
export function flagOverconfident(profile: CalibrationProfile | null, rule: OverconfidenceRule = {}): boolean | null {
  const minSamples = rule.minSamples ?? 30;
  const ratioThreshold = rule.ratioThreshold ?? 1.15;
  const eceThreshold = rule.eceThreshold ?? 0.1;
  if (!profile || profile.sampleSize < minSamples) return null;
  if (profile.overconfidenceRatio === null) {
    // No successes at all with enough samples: maximally overconfident.
    return profile.buckets.some((b) => b.predictions > 0);
  }
  if (profile.overconfidenceRatio > ratioThreshold) return true;
  if (profile.expectedCalibrationError !== null && profile.expectedCalibrationError > eceThreshold) {
    // Direction matters: ECE alone does not say which way. Check the mean gap.
    let gap = 0;
    for (const b of profile.buckets) if (b.predicted !== null && b.observed !== null) gap += (b.predicted - b.observed) * b.predictions;
    return gap / profile.sampleSize > 0.05;
  }
  return false;
}

/** Convenience: fold observations from scratch and return the profile. */
export function calibrationFromObservations(key: string, observations: readonly CalibrationObservation[], now: IsoTimestamp): CalibrationProfile {
  return updateCalibration(null, observations, now, key);
}
