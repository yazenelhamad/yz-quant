import type {
  ExecutionOutcome,
  IsoTimestamp,
  OutcomeClassification,
  PostTradeReview,
  TradeMemoryEntry,
  TradeRecord,
} from "../types/index.js";
import { assertSameScope } from "../types/index.js";
import { isFiniteNumber, mean, pct } from "./math.js";

/** The parts of a TradeThesis the review needs. All *Pct values are percentage points. */
export interface ThesisSummary {
  expectedEdge: number;
  confidence: number;
  expectedHoldingDays: number;
  expectedUpsidePct: number;
  expectedDownsidePct: number;
  invalidationPrice: number | null;
  targetPrice: number | null;
  exitConditions: string[];
}

export interface ReviewInput {
  trade: TradeRecord;
  memory: TradeMemoryEntry;
  thesis: ThesisSummary;
  executionOutcomes: ExecutionOutcome[];
  regimeAtExit: string | null;
  eventsDuringTrade: string[];
  /** Signed contribution of each signal to the entry decision. */
  signalContributions: Record<string, number>;
  benchmarkReturnPct: number | null;
  /** Explicit error flags raised upstream (data pipeline / model validation). */
  flags?: { dataError?: boolean; modelError?: boolean };
}

/** Thresholds used by the classification rules. Exported so tests and docs can reference them. */
export const REVIEW_RULES = Object.freeze({
  /** Slippage above this fraction of the expected upside counts as bad execution. */
  executionDragFraction: 0.25,
  /** Actual slippage above this multiple of the expected slippage (and > minSlippageBps) counts as bad execution. */
  slippageMultiple: 2,
  minSlippageBps: 10,
  /** MAE beyond this multiple of expected downside means the size assumed a downside that did not hold. */
  oversizedMaeMultiple: 2,
  /** MAE beyond this multiple of expected downside means the exit came late. */
  lateExitMaeMultiple: 1.5,
  /** Holding period below this fraction of the expected one is "far shorter". */
  shortHoldFraction: 0.25,
  /** Holding period above this multiple of the expected one is "far longer". */
  longHoldMultiple: 2,
  /** A win that keeps less than this fraction of its MFE gave most of it back. */
  giveBackFraction: 0.5,
  /** Fraction of expected upside that counts as the thesis playing out. */
  thesisCorrectFraction: 0.5,
  highConfidence: 0.75,
  lowConfidence: 0.5,
});

const INVALIDATION_EXIT = /invalid|stop_loss|stopped_out|stop_out|stopout/i;
const TARGET_EXIT = /target|take_profit|profit/i;
const TIME_EXIT = /time|expiry|horizon/i;
const OVERRIDE_EXIT = /manual|kill|risk|halt|reconcil|liquidat/i;
const DATA_ERROR_EXIT = /data_error|bad_data|stale/i;

export function realizedReturnPct(trade: TradeRecord, memory: TradeMemoryEntry): number | null {
  if (isFiniteNumber(memory.actualReturnPct)) return memory.actualReturnPct;
  if (isFiniteNumber(memory.exitPrice) && memory.entryPrice > 0) return (memory.exitPrice / memory.entryPrice - 1) * 100;
  if (isFiniteNumber(trade.averageEntryPrice) && isFiniteNumber(trade.averageExitPrice) && trade.averageEntryPrice > 0) {
    return (trade.averageExitPrice / trade.averageEntryPrice - 1) * 100;
  }
  if (isFiniteNumber(trade.averageEntryPrice) && trade.entryQuantity > 0 && trade.averageEntryPrice > 0) {
    return ((trade.realizedPnl - trade.fees) / (trade.entryQuantity * trade.averageEntryPrice)) * 100;
  }
  return null;
}

function magnitude(x: number | null | undefined): number | null {
  return isFiniteNumber(x) ? Math.abs(x) : null;
}

/**
 * Deterministic post-trade review. Winning is not the same as deciding well and losing is not
 * the same as deciding badly: the rules look at process (thesis, timing, sizing, execution)
 * separately from the P&L sign.
 */
export function reviewTrade(input: ReviewInput, now: IsoTimestamp, reviewerVersion = "review-1.0.0"): PostTradeReview {
  const { trade, memory, thesis } = input;
  assertSameScope(trade.scope, memory.scope, "reviewTrade(memory)");
  for (const o of input.executionOutcomes) assertSameScope(trade.scope, o.scope, "reviewTrade(executionOutcome)");
  if (memory.tradeId !== trade.id) throw new Error(`Memory entry ${memory.tradeId} does not belong to trade ${trade.id}`);

  const R = REVIEW_RULES;
  const ret = realizedReturnPct(trade, memory);
  const exitReason = memory.exitReason ?? trade.exitReason ?? "";
  const holdingDays = isFiniteNumber(memory.holdingDays) ? memory.holdingDays : null;
  const mae = magnitude(memory.maePct ?? trade.maxAdverseExcursionPct);
  const mfe = magnitude(memory.mfePct ?? trade.maxFavorableExcursionPct);
  const expectedDownside = Math.max(Math.abs(thesis.expectedDownsidePct), 1e-9);
  const expectedUpside = Math.max(Math.abs(thesis.expectedUpsidePct), 1e-9);
  const regimeAtEntry = memory.regime || trade.regimeAtEntry;
  const regimeChanged = input.regimeAtExit !== null && input.regimeAtExit !== regimeAtEntry;

  const fillSlips = input.executionOutcomes.map((o) => o.actualSlippageBps).filter(isFiniteNumber);
  const expectedSlips = input.executionOutcomes.map((o) => o.expectedSlippageBps).filter(isFiniteNumber);
  const slippageBps = fillSlips.length > 0 ? (mean(fillSlips) as number) : isFiniteNumber(memory.slippageBps) ? memory.slippageBps : null;
  const expectedSlippageBps = mean(expectedSlips);
  const edgeBps = expectedUpside * 100;

  const dataError = input.flags?.dataError === true || DATA_ERROR_EXIT.test(exitReason) || ret === null;
  const modelError = input.flags?.modelError === true;

  /** The strategy exited because its invalidation rule fired (the process respected the plan). */
  const invalidationExit = INVALIDATION_EXIT.test(exitReason);
  /** The exit price was at or through the invalidation level, whatever the stated reason. */
  const invalidationBreached = thesis.invalidationPrice !== null && isFiniteNumber(memory.exitPrice) && memory.exitPrice <= thesis.invalidationPrice;
  const invalidated = invalidationExit || invalidationBreached;
  const targetReached = TARGET_EXIT.test(exitReason) || (thesis.targetPrice !== null && isFiniteNumber(memory.exitPrice) && memory.exitPrice >= thesis.targetPrice);
  const isWin = ret !== null && ret > 0;

  // --- process judgements ---------------------------------------------------------------
  let thesisCorrect: boolean | null;
  if (ret === null) thesisCorrect = null;
  else if (invalidated) thesisCorrect = false;
  else if (targetReached || ret >= R.thesisCorrectFraction * expectedUpside) thesisCorrect = true;
  else if (isWin) thesisCorrect = null;
  else thesisCorrect = false;

  const executionEfficient: boolean | null = slippageBps === null
    ? null
    : !(slippageBps > R.executionDragFraction * edgeBps || (expectedSlippageBps !== null && slippageBps > R.slippageMultiple * expectedSlippageBps && slippageBps > R.minSlippageBps));

  const sizingCorrect: boolean | null = mae === null ? null : mae <= R.oversizedMaeMultiple * expectedDownside;

  const shortHold = holdingDays !== null && thesis.expectedHoldingDays > 0 && holdingDays < R.shortHoldFraction * thesis.expectedHoldingDays;
  const longHold = holdingDays !== null && thesis.expectedHoldingDays > 0 && holdingDays > R.longHoldMultiple * thesis.expectedHoldingDays;
  const reversal = isFiniteNumber(mfe) && mfe >= R.thesisCorrectFraction * expectedUpside && ret !== null && ret <= 0;
  const gaveBack = isWin && isFiniteNumber(mfe) && mfe > 0 && (ret as number) < R.giveBackFraction * mfe;
  const lateExit = (mae !== null && mae > R.lateExitMaeMultiple * expectedDownside) || gaveBack;
  let timingCorrect: boolean | null;
  if (holdingDays === null || ret === null) timingCorrect = null;
  else timingCorrect = !((shortHold && (reversal || invalidationExit)) || reversal || (longHold && !isWin));

  const strategyBehavedAsIntended: boolean | null = exitReason === ""
    ? null
    : OVERRIDE_EXIT.test(exitReason)
      ? false
      : INVALIDATION_EXIT.test(exitReason) || TARGET_EXIT.test(exitReason) || TIME_EXIT.test(exitReason) || thesis.exitConditions.some((c) => c.toLowerCase().includes(exitReason.toLowerCase()) || exitReason.toLowerCase().includes(c.toLowerCase()));

  let confidenceCalibrated: boolean | null;
  if (thesisCorrect === null) confidenceCalibrated = null;
  else if (thesis.confidence >= R.highConfidence && !thesisCorrect) confidenceCalibrated = false;
  else if (thesis.confidence < R.lowConfidence && thesisCorrect) confidenceCalibrated = false;
  else confidenceCalibrated = true;

  // --- classification -------------------------------------------------------------------
  let classification: OutcomeClassification;
  const notes: string[] = [];
  if (dataError) {
    classification = "data_error";
    notes.push(ret === null ? "The realised return could not be established, so the outcome is treated as a data error." : "The trade was flagged as a data error upstream.");
  } else if (modelError) {
    classification = "model_error";
    notes.push("The trade was flagged as a model error upstream.");
  } else if (!isWin) {
    const maeBlowThrough = mae !== null && mae > R.lateExitMaeMultiple * expectedDownside;
    if (input.eventsDuringTrade.length > 0 && maeBlowThrough) {
      classification = "unexpected_event";
      notes.push(`Events during the trade (${input.eventsDuringTrade.join("; ")}) pushed the adverse move to ${pct(-(mae as number))}, well beyond the expected downside of ${pct(-expectedDownside)}.`);
    } else if (regimeChanged) {
      classification = "regime_change";
      notes.push(`The regime moved from ${regimeAtEntry} to ${input.regimeAtExit} while the position was open.`);
    } else if (sizingCorrect === false) {
      classification = invalidationExit ? "oversized" : "bad_thesis";
      notes.push(invalidationExit
        ? `The invalidation was respected but the adverse excursion (${pct(-(mae as number))}) was more than ${R.oversizedMaeMultiple}x the expected downside, so the size assumed a risk that did not hold.`
        : `The adverse excursion (${pct(-(mae as number))}) was more than ${R.oversizedMaeMultiple}x the expected downside and the position was held through it: the thesis, not just the size, was wrong.`);
    } else if (shortHold && (reversal || invalidationExit)) {
      classification = "bad_timing";
      notes.push(`The position lasted ${holdingDays?.toFixed(1)} days against an expected ${thesis.expectedHoldingDays}, ${reversal ? "reversing after an initial favourable move" : "being invalidated almost immediately"}.`);
    } else if (executionEfficient === false && slippageBps !== null && slippageBps / 100 >= Math.abs(ret as number)) {
      classification = "bad_execution";
      notes.push(`Slippage of ${slippageBps.toFixed(1)} bps was at least as large as the loss itself; execution turned a flat trade into a losing one.`);
    } else if (invalidationExit) {
      classification = "good_loss";
      notes.push("The thesis did not play out, the invalidation point was respected and the loss stayed within the sized downside.");
    } else {
      classification = "bad_thesis";
      notes.push(invalidationBreached ? "The price went through the invalidation level without the strategy exiting on it." : "The trade lost without the invalidation being triggered, which points at the thesis itself.");
    }
  } else {
    const badProcess = thesisCorrect === false || lateExit || sizingCorrect === false || (executionEfficient === false && slippageBps !== null && slippageBps / 100 > R.giveBackFraction * (ret as number));
    if (badProcess) {
      classification = "bad_win";
      if (thesisCorrect === false) notes.push("The return was positive even though the thesis was invalidated: a win the process did not earn.");
      if (gaveBack) notes.push(`The trade gave back most of its favourable excursion (peak ${pct(mfe)}, closed ${pct(ret)}), so the exit came late.`);
      if (mae !== null && mae > R.lateExitMaeMultiple * expectedDownside) notes.push(`The adverse excursion (${pct(-mae)}) exceeded the planned downside before the trade recovered.`);
      if (sizingCorrect === false) notes.push("The position size assumed a downside that was breached.");
      if (executionEfficient === false) notes.push(`Slippage of ${slippageBps?.toFixed(1)} bps consumed a large share of the gain.`);
    } else {
      classification = "good_win";
      notes.push(regimeChanged ? "The thesis played out despite a regime change during the trade." : "The thesis played out within the expected downside and holding period.");
    }
  }

  // --- signals ---------------------------------------------------------------------------
  const sign = ret === null ? 0 : Math.sign(ret);
  const signalsHelped: string[] = [];
  const signalsHurt: string[] = [];
  if (sign !== 0) {
    for (const [key, contribution] of Object.entries(input.signalContributions)) {
      if (!isFiniteNumber(contribution) || contribution === 0) continue;
      (contribution * sign > 0 ? signalsHelped : signalsHurt).push(key);
    }
  }
  signalsHelped.sort();
  signalsHurt.sort();

  let wouldTakeAgain: boolean | null;
  switch (classification) {
    case "good_win":
    case "good_loss":
      wouldTakeAgain = true;
      break;
    case "bad_thesis":
    case "oversized":
    case "bad_timing":
      wouldTakeAgain = false;
      break;
    case "data_error":
    case "model_error":
      wouldTakeAgain = null;
      break;
    default:
      wouldTakeAgain = thesisCorrect !== false;
  }

  const benchmark = input.benchmarkReturnPct;
  const narrativeParts = [
    `${trade.symbol} (${memory.strategyKey}, ${memory.mode}) closed at ${pct(ret)}${benchmark !== null ? ` versus a benchmark of ${pct(benchmark)}` : ""}` +
      `${holdingDays !== null ? ` after ${holdingDays.toFixed(1)} days` : ""} with entry confidence ${(thesis.confidence * 100).toFixed(0)}% and expected upside ${pct(expectedUpside)}.`,
    ...notes,
    `Classified as ${classification.replace(/_/g, " ")}.`,
    signalsHelped.length > 0 ? `Signals that helped: ${signalsHelped.join(", ")}.` : "",
    signalsHurt.length > 0 ? `Signals that hurt: ${signalsHurt.join(", ")}.` : "",
    wouldTakeAgain === true ? "We would take this trade again." : wouldTakeAgain === false ? "We would not take this trade again as structured." : "",
  ].filter((s) => s.length > 0);

  return {
    id: `review:${trade.id}:${reviewerVersion}`,
    scope: trade.scope,
    tradeId: trade.id,
    thesisCorrect,
    timingCorrect,
    sizingCorrect,
    executionEfficient,
    strategyBehavedAsIntended,
    confidenceCalibrated,
    signalsHelped,
    signalsHurt,
    wouldTakeAgain,
    classification,
    returnPct: ret ?? 0,
    expectedEdge: thesis.expectedEdge,
    initialConfidence: thesis.confidence,
    maePct: mae !== null ? -mae : null,
    mfePct: mfe,
    slippageBps,
    regimeAtEntry,
    regimeAtExit: input.regimeAtExit,
    narrative: narrativeParts.join(" "),
    reviewedAt: now,
    reviewerVersion,
  };
}

export const GOOD_CLASSIFICATIONS: ReadonlySet<OutcomeClassification> = new Set(["good_win", "good_loss"]);
export const BAD_PROCESS_CLASSIFICATIONS: ReadonlySet<OutcomeClassification> = new Set(["bad_win", "bad_thesis", "bad_timing", "bad_execution", "oversized", "model_error"]);
