import { clamp, isFiniteNumber } from "../portfolio/math.js";

export interface KellyEstimate {
  /** Win probability used. */
  probability: number;
  /** Payoff ratio (average win / average loss) used. */
  payoffRatio: number;
  /** Full Kelly fraction of equity (>= 0). */
  fullKelly: number;
  /** Full Kelly multiplied by the configured fraction cap. */
  cappedKelly: number;
  /** Fraction actually applied (never above the settings cap). */
  fractionApplied: number;
}

/**
 * Full Kelly fraction f* = p - (1 - p) / b for a binary bet with win probability p and
 * payoff ratio b. Returns null when the inputs are missing or degenerate; never negative.
 */
export function fullKelly(probability: number | null | undefined, payoffRatio: number | null | undefined): number | null {
  if (!isFiniteNumber(probability) || !isFiniteNumber(payoffRatio)) return null;
  if (probability <= 0 || probability >= 1 || payoffRatio <= 0) return null;
  return Math.max(0, probability - (1 - probability) / payoffRatio);
}

/** Payoff ratio from expected upside/downside magnitudes (both positive fractions). */
export function payoffFromExpectations(expectedUpsidePct: number | null | undefined, expectedDownsidePct: number | null | undefined): number | null {
  if (!isFiniteNumber(expectedUpsidePct) || !isFiniteNumber(expectedDownsidePct)) return null;
  if (expectedUpsidePct <= 0 || expectedDownsidePct <= 0) return null;
  return expectedUpsidePct / expectedDownsidePct;
}

export interface BlendedProbabilityInput {
  calibratedConfidence: number;
  strategyWinRate: number | null;
  strategyTrades: number;
  regimeWinRate: number | null;
  regimeTrades: number;
  /** Trades needed for a historical estimate to receive full weight (default 30). */
  fullWeightTrades?: number;
}

/**
 * Blends the calibrated confidence with the strategy's historical win rate (overall and in the
 * current regime), giving history weight proportional to its sample size. Result in (0,1).
 */
export function blendedWinProbability(input: BlendedProbabilityInput): { probability: number; notes: string[] } {
  const notes: string[] = [];
  const full = input.fullWeightTrades ?? 30;
  let p = clamp(input.calibratedConfidence, 0.01, 0.99);
  if (isFiniteNumber(input.strategyWinRate) && input.strategyTrades > 0) {
    const w = clamp(input.strategyTrades / full, 0, 1) * 0.5;
    p = (1 - w) * p + w * clamp(input.strategyWinRate, 0.01, 0.99);
    notes.push(`blended with strategy win rate ${(input.strategyWinRate * 100).toFixed(0)}% over ${input.strategyTrades} trades (weight ${w.toFixed(2)})`);
  }
  if (isFiniteNumber(input.regimeWinRate) && input.regimeTrades > 0) {
    const w = clamp(input.regimeTrades / full, 0, 1) * 0.3;
    p = (1 - w) * p + w * clamp(input.regimeWinRate, 0.01, 0.99);
    notes.push(`blended with regime-specific win rate ${(input.regimeWinRate * 100).toFixed(0)}% over ${input.regimeTrades} trades (weight ${w.toFixed(2)})`);
  }
  return { probability: clamp(p, 0.01, 0.99), notes };
}

/**
 * Capped fractional Kelly. `kellyFraction` is the settings cap (<= 0.5 by schema); the
 * applied fraction can never exceed it.
 */
export function cappedKelly(probability: number, payoffRatio: number, kellyFraction: number): KellyEstimate | null {
  const fk = fullKelly(probability, payoffRatio);
  if (fk === null) return null;
  const fraction = clamp(kellyFraction, 0, 0.5);
  return { probability, payoffRatio, fullKelly: fk, cappedKelly: fk * fraction, fractionApplied: fraction };
}
