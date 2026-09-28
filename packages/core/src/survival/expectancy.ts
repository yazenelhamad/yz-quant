import { clamp, isFiniteNumber } from "../learning/math.js";

/**
 * NET EXPECTED VALUE GATE — a trade that does not pay for itself is a loss, however good it looks.
 *
 * EV = p x upside - (1 - p) x downside, in bps of notional, minus the round-trip cost of getting in
 * and out (spread, modelled slippage, commissions, regulatory fees). The result must clear the
 * survival mandate's hurdle. Unknown costs are assumed at their maximum (fail conservative).
 */
export interface NetExpectancyInput {
  /** Calibrated probability the trade is profitable (0..1). */
  confidence: number | null;
  /** Expected favourable move as a positive fraction (0.06 = +6%). */
  expectedUpsidePct: number | null;
  /** Expected adverse move as a positive fraction. */
  expectedDownsidePct: number | null;
  spreadBps: number | null;
  /** Modelled or learned slippage per side (bps). */
  expectedSlippageBps: number | null;
  /** Round-trip commission in bps (default 0: Robinhood charges none). */
  commissionBps?: number;
  /** Regulatory/SEC/TAF fees on the sell side, bps (default 0.3). */
  regulatoryFeeBps?: number;
  /** Assumed spread when unknown (default 25 bps: the risk settings' default maximum). */
  assumedSpreadBps?: number;
  /** Assumed slippage per side when unknown (default 10 bps). */
  assumedSlippageBps?: number;
  holdingDays: number | null;
  /** Hurdle from the survival mandate (bps net of costs). */
  hurdleBps: number;
}

export interface NetExpectancy {
  grossEvBps: number | null;
  costBps: number;
  netEvBps: number | null;
  hurdleBps: number;
  /** Net EV per calendar day held (bps), for comparing opportunities. */
  evPerDayBps: number | null;
  /** Cost as a share of the gross EV (null when gross EV <= 0). */
  costShare: number | null;
  passes: boolean;
  breakdown: string[];
}

export function netExpectancy(input: NetExpectancyInput): NetExpectancy {
  const breakdown: string[] = [];
  const spread = isFiniteNumber(input.spreadBps) ? Math.max(0, input.spreadBps) : (input.assumedSpreadBps ?? 25);
  if (!isFiniteNumber(input.spreadBps)) breakdown.push(`spread unknown: assuming ${spread} bps`);
  const slip = isFiniteNumber(input.expectedSlippageBps) ? Math.max(0, input.expectedSlippageBps) : (input.assumedSlippageBps ?? 10);
  if (!isFiniteNumber(input.expectedSlippageBps)) breakdown.push(`slippage unknown: assuming ${slip} bps per side`);
  const commission = Math.max(0, input.commissionBps ?? 0);
  const fees = Math.max(0, input.regulatoryFeeBps ?? 0.3);
  // Round trip: half the spread crossed twice, slippage on both sides, commissions, sell-side fees.
  const costBps = spread + 2 * slip + commission + fees;
  breakdown.push(`round-trip cost ${costBps.toFixed(1)} bps (spread ${spread.toFixed(1)}, slippage 2x${slip.toFixed(1)}, commission ${commission.toFixed(1)}, fees ${fees.toFixed(1)})`);

  const hurdleBps = Math.max(0, input.hurdleBps);
  if (!isFiniteNumber(input.confidence) || !isFiniteNumber(input.expectedUpsidePct) || !isFiniteNumber(input.expectedDownsidePct)) {
    breakdown.push("expected value unknown (missing confidence, upside or downside): fails closed");
    return { grossEvBps: null, costBps, netEvBps: null, hurdleBps, evPerDayBps: null, costShare: null, passes: false, breakdown };
  }
  const p = clamp(input.confidence, 0, 1);
  const up = Math.max(0, input.expectedUpsidePct) * 10_000;
  const down = Math.max(0, input.expectedDownsidePct) * 10_000;
  const grossEvBps = p * up - (1 - p) * down;
  const netEvBps = grossEvBps - costBps;
  const days = isFiniteNumber(input.holdingDays) && input.holdingDays > 0 ? input.holdingDays : null;
  const evPerDayBps = days !== null ? netEvBps / days : null;
  const costShare = grossEvBps > 0 ? costBps / grossEvBps : null;
  breakdown.push(`gross EV ${grossEvBps.toFixed(1)} bps = ${(p * 100).toFixed(0)}% x ${up.toFixed(0)} - ${((1 - p) * 100).toFixed(0)}% x ${down.toFixed(0)}`);
  breakdown.push(`net EV ${netEvBps.toFixed(1)} bps versus hurdle ${hurdleBps} bps${days !== null ? ` (${evPerDayBps!.toFixed(1)} bps/day over ${days} days)` : ""}`);
  const passes = netEvBps > 0 && netEvBps >= hurdleBps;
  if (!passes) breakdown.push(netEvBps <= 0 ? "the trade does not pay for its own costs" : "the trade clears costs but not the survival hurdle");
  return { grossEvBps, costBps, netEvBps, hurdleBps, evPerDayBps, costShare, passes, breakdown };
}
