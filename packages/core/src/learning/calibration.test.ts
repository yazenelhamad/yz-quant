import { describe, expect, it } from "vitest";
import { bucketIndex, bucketLabelFor, calibratedConfidence, calibrationAdjustment, CALIBRATION_ADJUSTMENT_BOUNDS, emptyCalibration, flagOverconfident, isotonicBucketRates, updateCalibration } from "./calibration.js";
import { NOW } from "./testFixtures.js";

function obs(predicted: number, successes: number, total: number) {
  return Array.from({ length: total }, (_, i) => ({ predicted, success: i < successes }));
}

describe("calibration buckets", () => {
  it("assigns the fixed bucket edges", () => {
    expect(bucketLabelFor(0)).toBe("0-0.5");
    expect(bucketLabelFor(0.49)).toBe("0-0.5");
    expect(bucketLabelFor(0.5)).toBe("0.5-0.6");
    expect(bucketLabelFor(0.65)).toBe("0.6-0.7");
    expect(bucketLabelFor(0.8)).toBe("0.8-0.9");
    expect(bucketLabelFor(0.9)).toBe("0.9-1");
    expect(bucketLabelFor(1)).toBe("0.9-1");
    expect(bucketIndex(1.7)).toBe(5);
    expect(emptyCalibration("k", NOW).buckets).toHaveLength(6);
  });

  it("updates counts, observed/predicted averages, Brier, ECE and overconfidence ratio", () => {
    const p = updateCalibration(null, [...obs(0.75, 5, 10), ...obs(0.85, 4, 10)], NOW, "strat");
    expect(p.key).toBe("strat");
    expect(p.sampleSize).toBe(20);
    const b7 = p.buckets[3]!;
    expect(b7).toMatchObject({ lower: 0.7, upper: 0.8, predictions: 10, successes: 5, observed: 0.5, predicted: 0.75 });
    const b8 = p.buckets[4]!;
    expect(b8).toMatchObject({ predictions: 10, successes: 4 });
    expect(b8.observed).toBeCloseTo(0.4);
    const brier = (5 * 0.25 ** 2 + 5 * 0.75 ** 2 + 4 * 0.15 ** 2 + 6 * 0.85 ** 2) / 20;
    expect(p.brierScore).toBeCloseTo(brier);
    expect(p.expectedCalibrationError).toBeCloseTo(0.5 * 0.25 + 0.5 * 0.45);
    expect(p.overconfidenceRatio).toBeCloseTo(0.8 / 0.45);
  });

  it("folds incrementally without needing raw history and does not mutate the input", () => {
    const first = updateCalibration(null, obs(0.75, 5, 10), NOW);
    const snapshot = JSON.stringify(first);
    const second = updateCalibration(first, obs(0.75, 5, 10), NOW);
    const together = updateCalibration(null, obs(0.75, 10, 20), NOW);
    expect(second.buckets[3]).toEqual(together.buckets[3]);
    expect(second.brierScore).toBeCloseTo(together.brierScore as number);
    expect(second.sampleSize).toBe(20);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it("handles a clamped/empty update", () => {
    const p = updateCalibration(null, [{ predicted: 1.4, success: true }, { predicted: Number.NaN, success: true }], NOW);
    expect(p.sampleSize).toBe(1);
    expect(p.buckets[5]?.predictions).toBe(1);
    expect(updateCalibration(null, [], NOW).brierScore).toBeNull();
  });
});

describe("calibrationAdjustment", () => {
  it("is 1 below the minimum sample size", () => {
    expect(calibrationAdjustment(updateCalibration(null, obs(0.9, 2, 20), NOW))).toBe(1);
    expect(calibrationAdjustment(null)).toBe(1);
  });

  it("shrinks confidence for overconfident profiles, bounded at 0.6", () => {
    const badly = updateCalibration(null, obs(0.9, 20, 100), NOW); // ratio 4.5
    expect(calibrationAdjustment(badly)).toBe(CALIBRATION_ADJUSTMENT_BOUNDS.min);
    const mildly = updateCalibration(null, obs(0.8, 64, 100), NOW); // ratio 1.25 -> target 0.8
    expect(calibrationAdjustment(mildly)).toBeCloseTo(0.8);
  });

  it("never increases confidence beyond 1.1 even for very underconfident profiles", () => {
    const under = updateCalibration(null, obs(0.5, 95, 100), NOW); // ratio ~0.53
    expect(calibrationAdjustment(under)).toBe(CALIBRATION_ADJUSTMENT_BOUNDS.max);
  });

  it("applies partial shrinkage toward 1 between minSamples and 3x minSamples", () => {
    const p = updateCalibration(null, obs(0.8, 24, 30), NOW); // ratio 1.0 -> target 1 ; make it 0.8/0.64 = 1.25
    const q = updateCalibration(null, obs(0.8, 19, 30), NOW); // observed 0.633, ratio ~1.263
    expect(calibrationAdjustment(p)).toBeCloseTo(1);
    const target = 1 / (0.8 / (19 / 30));
    expect(calibrationAdjustment(q)).toBeCloseTo(1 + (1 / 3) * (target - 1));
  });
});

describe("calibratedConfidence", () => {
  it("maps through observed bucket rates with shrinkage toward the raw value", () => {
    const p = updateCalibration(null, obs(0.85, 5, 10), NOW);
    // bucket 0.8-0.9 observed 0.5 with 10 samples: weight 10/20 = 0.5
    expect(calibratedConfidence(0.85, p)).toBeCloseTo(0.5 * 0.5 + 0.5 * 0.85);
    expect(calibratedConfidence(0.85, p, 0)).toBeCloseTo(0.5);
    expect(calibratedConfidence(0.65, p)).toBe(0.65); // no data in that bucket
    expect(calibratedConfidence(0.7, null)).toBe(0.7);
  });

  it("enforces monotone bucket rates (isotonic)", () => {
    const p = updateCalibration(null, [...obs(0.55, 8, 10), ...obs(0.65, 2, 10), ...obs(0.85, 9, 10)], NOW);
    const rates = isotonicBucketRates(p.buckets);
    expect(rates[1]).toBeCloseTo(0.5);
    expect(rates[2]).toBeCloseTo(0.5);
    expect(rates[4]).toBeCloseTo(0.9);
    expect(calibratedConfidence(0.65, p, 0)).toBeCloseTo(0.5);
  });
});

describe("flagOverconfident", () => {
  it("is null with too few samples, true when predictions exceed outcomes, false otherwise", () => {
    expect(flagOverconfident(updateCalibration(null, obs(0.9, 1, 10), NOW))).toBeNull();
    expect(flagOverconfident(updateCalibration(null, obs(0.9, 50, 100), NOW))).toBe(true);
    expect(flagOverconfident(updateCalibration(null, obs(0.7, 70, 100), NOW))).toBe(false);
    expect(flagOverconfident(updateCalibration(null, obs(0.6, 80, 100), NOW))).toBe(false); // underconfident
    expect(flagOverconfident(updateCalibration(null, obs(0.7, 0, 40), NOW))).toBe(true); // no successes at all
    expect(flagOverconfident(null)).toBeNull();
  });
});
