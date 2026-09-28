import { clamp } from "../features/math.js";

/**
 * Trade geometry: one consistent set of numbers for a long entry. The stop, the target, the
 * stated downside and the stated upside are derived from each other and from the symbol's own
 * volatility over the holding horizon, so a thesis can never claim a 5% downside while its stop
 * sits 18% away, and a target can never sit further out than the horizon could plausibly reach.
 *
 * Everything is expressed as fractions of price; sigma is the expected absolute move over the
 * horizon (annualised vol scaled by sqrt(horizon / 252)).
 */
export const GEOMETRY = {
  /** A stop closer than this many horizon-sigmas is noise and gets widened. */
  minStopSigma: 0.6,
  /** A stop further than this many horizon-sigmas is not a risk stop; the risk stop is tightened to it. */
  maxStopSigma: 2.0,
  /** A default (volatility-derived) target sits at least this far out. */
  minTargetSigma: 0.8,
  /** No target may sit further out than this: the horizon cannot plausibly reach it. */
  maxTargetSigma: 2.5,
  /** Below this reward/risk a long setup is not worth its stop. */
  minRewardRisk: 1.2,
  /** Absolute floor for a stop distance (fraction of price), whatever the volatility says. */
  minStopPct: 0.005,
} as const;

export interface GeometryInput {
  /** Reference price the levels are anchored to. */
  price: number;
  /** Expected absolute move over the horizon as a fraction of price (vol × sqrt(h/252)). */
  sigmaHorizon: number;
  /** Long strength in [0, 1]; scales the default target. */
  strength: number;
  /** A structural thesis level (e.g. the 200-day average): the thesis is wrong below it. */
  structuralStop?: number | null;
  /** A structural target level (e.g. VWAP for a mean-reversion trade). Never raised, only capped. */
  structuralTarget?: number | null;
  /** Explicit upside / downside fractions from the strategy when it has its own estimate. */
  upside?: number;
  downside?: number;
  /**
   * Minimum reward/risk for the setup to be viable (default GEOMETRY.minRewardRisk). Mean-reversion
   * setups target a level as far as their stop and earn their edge from hit rate, which the win
   * probability and net expectancy price; they pass 1.0.
   */
  minRewardRisk?: number;
}

export interface TradeGeometry {
  /** The risk stop: the level the position is exited at. */
  invalidationPrice: number;
  targetPrice: number;
  /** Distance to the risk stop, fraction of price. */
  downsidePct: number;
  /** Distance to the target, fraction of price. */
  upsidePct: number;
  rewardRisk: number;
  stopSigma: number;
  targetSigma: number;
  /** The structural thesis level when it differs from the risk stop (further away). */
  structuralInvalidationPrice: number | null;
  viable: boolean;
  notes: string[];
}

function fin(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Reconcile a strategy's levels into one consistent long-entry geometry. */
export function reconcileGeometry(i: GeometryInput): TradeGeometry {
  const notes: string[] = [];
  const price = i.price;
  const sigma = Math.max(fin(i.sigmaHorizon) ? i.sigmaHorizon : 0, 1e-4);
  const strength = clamp(fin(i.strength) ? i.strength : 0, 0, 1);

  // ---- stop -------------------------------------------------------------------------------
  let structuralInvalidationPrice: number | null = null;
  const stopLo = Math.max(GEOMETRY.minStopSigma * sigma, GEOMETRY.minStopPct);
  const stopHi = Math.max(GEOMETRY.maxStopSigma * sigma, stopLo);
  // The risk stop the position is actually exited at. A structural thesis level serves as the
  // risk stop only when it sits within [minStopSigma, maxStopSigma] of the horizon move; a level
  // further away (a 200-day average 18% below) stays the thesis level while the risk stop falls
  // back to the strategy's own estimate or 1σ, so the stated downside is the real one.
  const fallback = fin(i.downside) && i.downside > 0 ? i.downside : sigma;
  let stop = fallback;
  let stopSource = fin(i.downside) && i.downside > 0 ? "strategy estimate" : "1σ default";
  if (fin(i.structuralStop) && i.structuralStop < price) {
    const structural = (price - i.structuralStop) / price;
    if (structural > stopHi) {
      structuralInvalidationPrice = i.structuralStop;
      notes.push(`thesis level ${i.structuralStop.toFixed(2)} is ${(structural * 100).toFixed(1)}% away (${(structural / sigma).toFixed(1)}σ): kept as the thesis level, risk stop set at ${(Math.min(Math.max(fallback, stopLo), stopHi) * 100).toFixed(1)}%`);
    } else {
      stop = structural;
      stopSource = "thesis level";
    }
  }
  if (stop > stopHi) {
    notes.push(`${stopSource} ${(stop * 100).toFixed(1)}% away (${(stop / sigma).toFixed(1)}σ): risk stop tightened to ${(stopHi / sigma).toFixed(1)}σ (${(stopHi * 100).toFixed(1)}%)`);
    stop = stopHi;
  } else if (stop < stopLo) {
    notes.push(`${stopSource} ${(stop * 100).toFixed(2)}% away is inside noise (${(stop / sigma).toFixed(2)}σ): risk stop widened to ${(stopLo * 100).toFixed(1)}%`);
    stop = stopLo;
  }

  // ---- target -----------------------------------------------------------------------------
  let target: number;
  let structural = false;
  if (fin(i.structuralTarget) && i.structuralTarget > price) {
    target = (i.structuralTarget - price) / price;
    structural = true;
  } else if (fin(i.upside) && i.upside > 0) {
    target = i.upside;
  } else {
    target = (1 + strength) * sigma;
  }
  const targetHi = GEOMETRY.maxTargetSigma * sigma;
  if (target > targetHi) {
    notes.push(`target ${(target * 100).toFixed(1)}% away (${(target / sigma).toFixed(1)}σ) is beyond what the horizon can reach: capped at ${GEOMETRY.maxTargetSigma}σ (${(targetHi * 100).toFixed(1)}%)`);
    target = targetHi;
  } else if (!structural && target < GEOMETRY.minTargetSigma * sigma) {
    target = GEOMETRY.minTargetSigma * sigma;
  }

  const minRR = fin(i.minRewardRisk) && i.minRewardRisk > 0 ? i.minRewardRisk : GEOMETRY.minRewardRisk;
  const rewardRisk = stop > 0 ? target / stop : 0;
  const viable = rewardRisk >= minRR - 1e-9 && target > 0 && stop > 0;
  if (!viable) notes.push(`reward/risk ${rewardRisk.toFixed(2)} below the ${minRR} minimum`);
  return {
    invalidationPrice: round4(price * (1 - stop)), targetPrice: round4(price * (1 + target)),
    downsidePct: round4(stop), upsidePct: round4(target), rewardRisk: round4(rewardRisk),
    stopSigma: round4(stop / sigma), targetSigma: round4(target / sigma),
    structuralInvalidationPrice: structuralInvalidationPrice === null ? null : round4(structuralInvalidationPrice),
    viable, notes,
  };
}

export interface ReanchorInput {
  /** The live price the trade would be entered at. */
  price: number;
  invalidationPrice: number | null;
  targetPrice: number | null;
  /** The candidate's stated fractions, used when a level is missing. */
  statedUpside: number;
  statedDownside: number;
  sigmaHorizon: number;
}

export interface ReanchoredGeometry {
  upsidePct: number;
  downsidePct: number;
  rewardRisk: number;
  stopSigma: number;
  /** Null when the geometry still holds; otherwise why the entry is no longer sound. */
  problem: string | null;
}

/**
 * Re-measure a candidate's upside and downside from the live price against its actual stop and
 * target levels. The levels were set at the candidate's reference close; price has moved since.
 * Fails closed when the stop or target has been reached, when the stop is now inside noise, or
 * when the remaining reward no longer pays for the risk.
 */
export function reanchorGeometry(i: ReanchorInput): ReanchoredGeometry {
  const sigma = Math.max(fin(i.sigmaHorizon) ? i.sigmaHorizon : 0, 1e-4);
  const down = fin(i.invalidationPrice) ? (i.price - i.invalidationPrice) / i.price : i.statedDownside;
  const up = fin(i.targetPrice) ? (i.targetPrice - i.price) / i.price : i.statedUpside;
  const rr = down > 0 ? up / down : 0;
  const stopSigma = down / sigma;
  let problem: string | null = null;
  if (!(down > 0)) problem = `price ${i.price.toFixed(2)} is at or below the stop ${i.invalidationPrice?.toFixed(2) ?? "?"}: thesis already invalidated`;
  else if (!(up > 0)) problem = `price ${i.price.toFixed(2)} is at or above the target ${i.targetPrice?.toFixed(2) ?? "?"}: nothing left to capture`;
  else if (stopSigma < GEOMETRY.minStopSigma * 0.75) problem = `stop is ${(down * 100).toFixed(2)}% away (${stopSigma.toFixed(2)}σ): inside noise after the move since the candidate was formed`;
  else if (rr < GEOMETRY.minRewardRisk) problem = `reward/risk from the live price is ${rr.toFixed(2)} (target +${(up * 100).toFixed(1)}% vs stop -${(down * 100).toFixed(1)}%), below the ${GEOMETRY.minRewardRisk} minimum`;
  return { upsidePct: round4(Math.max(0, up)), downsidePct: round4(Math.max(0, down)), rewardRisk: round4(rr), stopSigma: round4(stopSigma), problem };
}

/** Expected absolute move over `horizonDays` from annualised volatility (fraction of price). */
export function sigmaOverHorizon(annualizedVol: number | null | undefined, horizonDays: number, fallbackDailyMove = 0.02): number {
  const h = Math.max(1, horizonDays);
  if (fin(annualizedVol) && annualizedVol > 0) return (annualizedVol / Math.sqrt(252)) * Math.sqrt(h);
  return fallbackDailyMove * Math.sqrt(h);
}

export interface HitProbability {
  /** Probability the target is touched before the stop within the horizon (no drift). */
  target: number;
  /** Probability the stop is touched first within the horizon. */
  stop: number;
  /** Probability neither level is touched by the end of the horizon. */
  neither: number;
}

/**
 * No-edge base rate: for a driftless random walk with the given horizon volatility, the chance
 * of touching the target before the stop within the horizon. Computed exactly on a symmetric
 * binomial lattice in log-price (deterministic, no sampling). With a 2:1 target/stop this is
 * about a third minus the paths that touch neither, which is what a "63% confidence" has to be
 * measured against.
 */
export function noEdgeHitProbability(upsidePct: number, downsidePct: number, sigmaHorizon: number, steps = 240): HitProbability {
  if (!(upsidePct > 0) || !(downsidePct > 0) || !(sigmaHorizon > 0)) return { target: 0, stop: 0, neither: 1 };
  const n = Math.max(20, Math.min(2000, Math.round(steps)));
  const delta = sigmaHorizon / Math.sqrt(n);
  const upLevel = Math.log(1 + upsidePct);
  const downLevel = Math.log(1 - Math.min(downsidePct, 0.999));
  // Barriers in lattice units (first integer at or beyond the level).
  const kUp = Math.max(1, Math.ceil(upLevel / delta - 1e-12));
  const kDown = Math.max(1, Math.ceil(-downLevel / delta - 1e-12));
  const width = kUp + kDown - 1; // interior states: -kDown+1 .. kUp-1
  let cur = new Float64Array(width);
  cur[kDown - 1] = 1; // origin
  let pTarget = 0;
  let pStop = 0;
  for (let s = 0; s < n; s += 1) {
    const next = new Float64Array(width);
    for (let j = 0; j < width; j += 1) {
      const m = cur[j] as number;
      if (m === 0) continue;
      const half = m / 2;
      if (j + 1 >= width) pTarget += half; else next[j + 1] = (next[j + 1] as number) + half;
      if (j - 1 < 0) pStop += half; else next[j - 1] = (next[j - 1] as number) + half;
    }
    cur = next;
  }
  let neither = 0;
  for (let j = 0; j < width; j += 1) neither += cur[j] as number;
  return { target: round4(pTarget), stop: round4(pStop), neither: round4(clamp(neither, 0, 1)) };
}

export interface ThesisProbabilityInput {
  /** No-edge base rate of reaching the target first (from `noEdgeHitProbability`). */
  baseRate: number;
  /** The calibrated signal confidence in [0, 1]; 0.5 is "no view". */
  signalConfidence: number;
  /**
   * How many probability points a fully confident signal may add over the base rate (default
   * 0.35: a perfect signal adds 17.5 points). Learning may narrow this per strategy from
   * realised outcomes; it is never widened by a model's opinion.
   */
  tiltScale?: number;
}

export interface ThesisProbability {
  /** Calibrated probability the trade reaches its target before its stop. */
  probability: number;
  baseRate: number;
  /** Points added (or removed) by the signal, in probability units. */
  tilt: number;
}

/**
 * The win probability a thesis may claim: the no-edge base rate for its own target/stop
 * geometry plus a bounded tilt from the calibrated signal. A signal cannot turn a 1-in-3 shot
 * into a 2-in-3 one; it can move it by up to `tiltScale / 2`.
 *
 * The base rate to pass is the breakeven probability d / (u + d): a driftless price is a
 * martingale, so whatever mix of target hits, stop hits and unresolved paths a finite horizon
 * produces, its expected return is zero, and the binary-equivalent win probability at the
 * trade's payoff ratio is exactly breakeven. `noEdgeHitProbability` breaks that down into the
 * three outcomes for the narrative.
 */
export function thesisProbability(i: ThesisProbabilityInput): ThesisProbability {
  const base = clamp(fin(i.baseRate) ? i.baseRate : 0, 0, 1);
  const scale = clamp(fin(i.tiltScale) ? i.tiltScale : 0.35, 0, 1);
  const tilt = (clamp(fin(i.signalConfidence) ? i.signalConfidence : 0.5, 0, 1) - 0.5) * scale;
  return { probability: round4(clamp(base + tilt, 0.02, 0.95)), baseRate: round4(base), tilt: round4(tilt) };
}

/** Breakeven win probability for a payoff ratio b = upside / downside: p* = 1 / (1 + b). */
export function breakevenProbability(upsidePct: number | null | undefined, downsidePct: number | null | undefined): number | null {
  if (!fin(upsidePct) || !fin(downsidePct) || upsidePct <= 0 || downsidePct <= 0) return null;
  return round4(downsidePct / (upsidePct + downsidePct));
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/**
 * The win probability an entry must reach under a `minConfidence` setting. The setting is read
 * at even payoff (0.6 = 20% above the 50% breakeven) and scaled with the breakeven of the actual
 * target/stop geometry, so it demands the same edge at any payoff ratio. Without a payoff the
 * setting applies as is.
 */
export function requiredWinProbability(minConfidence: number, upsidePct: number | null | undefined, downsidePct: number | null | undefined): { required: number; breakeven: number | null } {
  const breakeven = breakevenProbability(upsidePct, downsidePct);
  if (breakeven === null) return { required: minConfidence, breakeven: null };
  return { required: round4(clamp(breakeven * (minConfidence / 0.5), 0.05, 0.95)), breakeven };
}
