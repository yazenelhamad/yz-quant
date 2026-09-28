import type { FastAction, FastBrainInput, FastBrainOutput, IsoTimestamp } from "../types/index.js";
import { FAST_ACTIONS } from "../types/index.js";
import { clamp, fmtSigned, softmax } from "../features/math.js";

export const FAST_BRAIN_VERSION = "fast-1.0.0";

/** Softmax temperature: scores live in roughly [-8, 8]; 1.0 gives meaningful, not degenerate, probabilities. */
export const FAST_BRAIN_TEMPERATURE = 1.0;
/** Below this probability the argmax is not trusted and the brain falls back to WAIT (no position) / HOLD (position). */
export const FAST_BRAIN_MIN_CONVICTION = 0.45;

const IMPOSSIBLE = -12;

export interface FastBrainScores {
  scores: Record<FastAction, number>;
  /** Named intermediate terms, for audit and tests. */
  terms: Record<string, number>;
}

function freshnessFactor(f: FastBrainInput["dataFreshness"]): number {
  return f === "fresh" ? 1 : f === "aging" ? 0.6 : 0;
}

/**
 * Transparent linear scores for the eight actions. Every term is additive and named so the
 * decision can be audited line by line. Nothing here touches the broker or the risk engine:
 * the output is a proposal that the risk engine may veto.
 */
export function scoreActions(input: FastBrainInput): FastBrainScores {
  const calib = clamp(Number.isFinite(input.calibrationAdjustment) ? input.calibrationAdjustment : 1, 0.25, 2);
  const confidence = clamp(input.confidence * calib, 0, 1);
  const edge = clamp(input.expectedEdge, -1, 1);
  const e = edge * confidence; // signed, calibrated edge in [-1, 1]
  const fresh = freshnessFactor(input.dataFreshness);
  const u = clamp(input.uncertainty, 0, 1);
  const d = clamp(input.disagreement, 0, 1);
  const regime = clamp(input.regimeFit, 0, 1);
  const fit = clamp(input.portfolioFit, -1, 1);
  const capacity = clamp(input.riskCapacity, 0, 1);
  const liquidity = clamp(input.liquidityScore, 0, 1);
  const spreadPenalty = input.spreadBps === null ? 0.3 : clamp(input.spreadBps / 50, 0, 1.5);
  const session = input.marketSession;
  const regular = session === "regular";
  const tradable = regular || session === "pre" || session === "post";
  const closedPenalty = tradable ? (regular ? 0 : 1.5) : 4;
  const hasPos = input.hasPosition;
  const order = input.openOrder;
  const pnl = input.positionPnlPct ?? 0;

  const terms: Record<string, number> = {
    calibratedEdge: e, freshness: fresh, uncertainty: u, disagreement: d, regimeFit: regime, portfolioFit: fit, riskCapacity: capacity,
  };

  const scores: Record<FastAction, number> = { BUY: 0, SELL: 0, HOLD: 0, WAIT: 0, REDUCE: 0, EXIT: 0, CANCEL_ORDER: 0, REPRICE_ORDER: 0 };

  // BUY: only with fresh data, an open session, no pending order, capacity and positive calibrated edge.
  scores.BUY = 4.5 * Math.max(e, 0) * fresh
    - 2.0 * u - 2.0 * d
    + 1.5 * (regime - 0.5) + 1.5 * fit + 1.0 * (capacity - 0.5)
    + 0.8 * (liquidity - 0.5) - 1.0 * spreadPenalty
    - (input.eventRiskWithinHorizon ? 2.5 : 0)
    - (hasPos ? 1.0 : 0)
    - closedPenalty
    - 2.0 * (1 - fresh);
  if (order || capacity <= 0 || fresh === 0 || e <= 0 || !tradable) scores.BUY = IMPOSSIBLE;

  // SELL: opportunistic sale of an existing long on negative calibrated edge (not thesis-driven).
  scores.SELL = hasPos && tradable && fresh > 0
    ? 3.5 * Math.max(-e, 0) * fresh - 1.0 * u - 1.0 * d + 0.5 * (pnl > 0 ? 1 : 0) - closedPenalty - (order ? 3 : 0)
    : IMPOSSIBLE;

  // HOLD: keep an existing position when nothing argues strongly for a change.
  scores.HOLD = hasPos
    ? 1.2 + 1.0 * Math.max(e, 0) + 0.8 * (1 - u) + 0.5 * regime + 1.0 * (1 - fresh) + (!tradable ? 1.5 : 0) - 1.5 * (input.invalidated ? 1 : 0) - 0.8 * (input.targetReached ? 1 : 0)
    : -1.0;

  // WAIT: no position and no compelling action; dominates on stale data, closed sessions and event risk.
  scores.WAIT = (hasPos ? -0.5 : 1.2)
    + 3.5 * (1 - fresh) + 1.5 * u + 1.0 * d
    + (input.eventRiskWithinHorizon && !hasPos ? 1.5 : 0)
    + (!tradable ? 2.0 : regular ? 0 : 0.8)
    + (capacity <= 0 && !hasPos ? 1.0 : 0)
    - 1.0 * Math.max(e, 0) * fresh;

  // REDUCE: trim an existing position on target reached, deteriorating edge, disagreement or capacity pressure.
  scores.REDUCE = hasPos && tradable
    ? 0.3 + 2.5 * (input.targetReached ? 1 : 0) + 2.0 * Math.max(-e, 0) * fresh + 1.0 * d + 0.8 * u + (capacity < 0.1 ? 1.5 : 0) + (input.eventRiskWithinHorizon ? 1.0 : 0) + (pnl > 0 && input.targetReached ? 0.5 : 0) - (order ? 3 : 0) - (regular ? 0 : 1.0)
    : IMPOSSIBLE;

  // EXIT: thesis invalidated, deep loss with negative edge, or target reached with the edge gone.
  scores.EXIT = hasPos && tradable
    ? 0.1 + 6.0 * (input.invalidated ? 1 : 0) + 2.5 * Math.max(-e, 0) * fresh + (pnl <= -0.08 && e <= 0 ? 2.0 : 0) + (input.targetReached && e <= 0 ? 2.0 : 0) - (order ? 3 : 0) - (regular ? 0 : 0.8)
    : IMPOSSIBLE;

  // CANCEL_ORDER / REPRICE_ORDER: only with an open order.
  if (order) {
    const edgeGone = order.side === "buy" ? e <= 0 : e >= 0;
    const farFromMarket = order.distanceFromMarketBps > 30;
    const stale = order.ageSeconds > 900;
    const lowFill = order.fillProbability < 0.2;
    scores.CANCEL_ORDER = 1.0 + (lowFill ? 2.5 : 0) + (edgeGone ? 3.0 : 0) + (stale && farFromMarket ? 1.5 : 0) + 2.0 * (1 - fresh) + (input.eventRiskWithinHorizon ? 1.0 : 0) + (!tradable ? 2.0 : 0);
    const worthRepricing = !edgeGone && order.ageSeconds > 120 && order.distanceFromMarketBps > 10 && order.fillProbability < 0.5 && fresh > 0 && tradable;
    scores.REPRICE_ORDER = 0.5 + (worthRepricing ? 3.0 : 0) - (lowFill ? 1.0 : 0) - (order.distanceFromMarketBps > 100 ? 1.5 : 0) - 1.5 * (1 - fresh);
    terms["orderEdgeGone"] = edgeGone ? 1 : 0;
    terms["orderLowFill"] = lowFill ? 1 : 0;
    terms["orderWorthRepricing"] = worthRepricing ? 1 : 0;
  } else {
    scores.CANCEL_ORDER = IMPOSSIBLE;
    scores.REPRICE_ORDER = IMPOSSIBLE;
  }

  return { scores, terms };
}

/**
 * Deterministic, bounded decision. Produces a probability distribution over the eight actions
 * from `scoreActions` via softmax with a fixed temperature, picks the argmax, and falls back to
 * WAIT / HOLD when conviction is below `FAST_BRAIN_MIN_CONVICTION`. `now` is passed in; the
 * function never reads the clock.
 */
export function decide(input: FastBrainInput, now: IsoTimestamp): FastBrainOutput {
  const { scores, terms } = scoreActions(input);
  const probs = softmax(FAST_ACTIONS.map((a) => scores[a]), FAST_BRAIN_TEMPERATURE);
  const probabilities = {} as Record<FastAction, number>;
  FAST_ACTIONS.forEach((a, i) => { probabilities[a] = probs[i] as number; });
  let action: FastAction = FAST_ACTIONS[0] as FastAction;
  for (const a of FAST_ACTIONS) if (probabilities[a] > probabilities[action]) action = a;
  const reasons: string[] = [];
  const argmax = action;
  const argmaxProb = probabilities[argmax];
  if (argmaxProb < FAST_BRAIN_MIN_CONVICTION) {
    const fallback: FastAction = input.hasPosition ? "HOLD" : "WAIT";
    reasons.push(`Top action ${argmax} has only ${(argmaxProb * 100).toFixed(0)}% probability (below ${FAST_BRAIN_MIN_CONVICTION * 100}%): defaulting to ${fallback}.`);
    action = fallback;
  }
  reasons.push(...explainInputs(input, terms, action));
  return {
    scope: input.scope,
    symbol: input.symbol,
    probabilities,
    action,
    conviction: probabilities[action],
    reasons,
    modelVersion: FAST_BRAIN_VERSION,
    decidedAt: now,
    bypassedRisk: false,
  };
}

function explainInputs(input: FastBrainInput, terms: Record<string, number>, action: FastAction): string[] {
  const r: string[] = [];
  const e = terms["calibratedEdge"] ?? 0;
  r.push(`Calibrated edge ${fmtSigned(e)} (edge ${fmtSigned(input.expectedEdge)} × confidence ${input.confidence.toFixed(2)} × calibration ${input.calibrationAdjustment.toFixed(2)}).`);
  if (input.dataFreshness !== "fresh") r.push(`Market data is ${input.dataFreshness}: new entries are suppressed and waiting is favoured.`);
  if (input.marketSession !== "regular") r.push(`Session is ${input.marketSession}: ${input.marketSession === "closed" || input.marketSession === "overnight" ? "no orders are sent" : "only limit orders are possible, so activity is discounted"}.`);
  if (input.uncertainty > 0.4 || input.disagreement > 0.4) r.push(`Uncertainty ${input.uncertainty.toFixed(2)} and disagreement ${input.disagreement.toFixed(2)} weigh against acting.`);
  if (input.hasPosition) {
    r.push(`Position held${input.positionPnlPct === null ? "" : ` (${fmtSigned(input.positionPnlPct * 100, 1)}%)`}${input.positionAgeDays === null ? "" : `, ${input.positionAgeDays} days old`}.`);
    if (input.invalidated) r.push("Thesis invalidated: exit dominates.");
    if (input.targetReached) r.push("Target reached: reducing or exiting is favoured.");
  } else {
    r.push("No position held: sell, reduce and exit are impossible (long-only account).");
  }
  if (input.openOrder) {
    const o = input.openOrder;
    r.push(`Open ${o.side} order aged ${o.ageSeconds}s, ${o.distanceFromMarketBps.toFixed(0)} bps from market, fill probability ${(o.fillProbability * 100).toFixed(0)}%${terms["orderEdgeGone"] ? "; its edge is gone" : ""}${terms["orderWorthRepricing"] ? "; repricing is worthwhile" : ""}.`);
  }
  if (input.eventRiskWithinHorizon) r.push("Scheduled event inside the horizon raises the bar for new risk.");
  if (input.riskCapacity <= 0) r.push("No remaining risk capacity: buying is impossible.");
  else if (input.riskCapacity < 0.2) r.push(`Risk capacity is low (${(input.riskCapacity * 100).toFixed(0)}%).`);
  r.push(`Regime fit ${input.regimeFit.toFixed(2)}, portfolio fit ${fmtSigned(input.portfolioFit)}, liquidity ${input.liquidityScore.toFixed(2)}${input.spreadBps === null ? "" : `, spread ${input.spreadBps.toFixed(0)} bps`}.`);
  r.push(`Chosen action: ${action}.`);
  return r;
}

/** One-paragraph plain-English explanation of a decision, for journals and the UI. */
export function explainDecision(output: FastBrainOutput): string {
  const ranked = (Object.entries(output.probabilities) as [FastAction, number][]).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 3).map(([a, p]) => `${a} ${(p * 100).toFixed(0)}%`).join(", ");
  return `${output.symbol}: ${output.action} with ${(output.conviction * 100).toFixed(0)}% conviction (${top}). ${output.reasons.join(" ")} Model ${output.modelVersion}; risk engine not bypassed.`;
}
