import type { ExecutionContext, ExecutionPlan, MarketHours, OrderType } from "../types/index.js";
import { clamp } from "../features/math.js";

export const EXECUTION_MODEL_VERSION = "exec-1.0.0";

export interface ExecutionSettings {
  /** Abort when the quoted spread exceeds this. */
  maxSpreadBps: number;
  /** Never chase a limit price more than this far from the original price. */
  maxChaseBps: number;
  /** Seconds a limit order rests before the monitor considers repricing. */
  defaultRepriceSeconds: number;
  /** Market-impact coefficient k in bps: impact = k × sqrt(participation of ADV). Default 25. */
  impactCoefficientBps?: number;
  /** Multiplier on the volatility-timing term. Default 0.3. */
  volTermCoefficient?: number;
  /** Orders larger than this fraction of ADV are refused. Default 0.2. */
  maxParticipation?: number;
  /** Orders larger than this fraction of ADV are staged into slices. Default 0.02. */
  stagingParticipation?: number;
  /** Abort when expected cost >= expected edge × this ratio. Default 0.5. */
  costEdgeRatio?: number;
  /** Spread at or below which a high-urgency regular-hours order may go to market. Default 5 bps. */
  marketableSpreadBps?: number;
}

export const DEFAULT_EXECUTION_SETTINGS: Required<ExecutionSettings> = {
  maxSpreadBps: 25,
  maxChaseBps: 20,
  defaultRepriceSeconds: 45,
  impactCoefficientBps: 25,
  volTermCoefficient: 0.3,
  maxParticipation: 0.2,
  stagingParticipation: 0.02,
  costEdgeRatio: 0.5,
  marketableSpreadBps: 5,
};

/** Regular session length in seconds (09:30–16:00 ET). */
const SESSION_SECONDS = 23_400;
const REGULATORY_SELL_FEE_BPS = 0.3;

function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

/** Price tick: cents at or above $1, sub-penny (4 dp) below. */
export function roundPrice(price: number, side: "buy" | "sell"): number {
  const decimals = price >= 1 ? 2 : 4;
  const f = 10 ** decimals;
  return (side === "buy" ? Math.floor(price * f + 1e-9) : Math.ceil(price * f - 1e-9)) / f;
}

export interface SlippageModelInput {
  spreadBps: number | null;
  participation: number | null;
  realizedVolDaily: number | null;
  expectedTimeToFillSec: number;
  orderStyle: "market" | "marketable_limit" | "mid_limit" | "passive_limit";
  settings: Required<ExecutionSettings>;
}

/**
 * Expected slippage (bps) = half spread (for liquidity-taking styles) + impact k·sqrt(participation)
 * + volatility × sqrt(time / session) timing term. Passive styles earn back some spread but
 * carry the timing risk of resting; the estimate is floored at zero.
 */
export function modelSlippageBps(input: SlippageModelInput): { total: number; halfSpread: number; impact: number; volTerm: number } {
  const s = input.settings;
  const halfSpread = (input.spreadBps ?? s.maxSpreadBps) / 2;
  const participation = input.participation ?? 0.05;
  const impact = s.impactCoefficientBps * Math.sqrt(clamp(participation, 0, 1));
  const vol = input.realizedVolDaily ?? 0.02;
  const volTerm = vol * Math.sqrt(clamp(input.expectedTimeToFillSec, 0, 6 * SESSION_SECONDS) / SESSION_SECONDS) * 10_000 * s.volTermCoefficient;
  let total: number;
  switch (input.orderStyle) {
    case "market": total = halfSpread + impact + volTerm; break;
    case "marketable_limit": total = halfSpread + impact + volTerm; break;
    case "mid_limit": total = 0.7 * impact + volTerm; break;
    case "passive_limit": total = -halfSpread + 0.5 * impact + volTerm; break;
    default: total = halfSpread + impact + volTerm;
  }
  return { total: Math.max(0, total), halfSpread, impact, volTerm };
}

function abortPlan(reason: string, reasons: string[], quantity: number, marketHours: MarketHours): ExecutionPlan {
  return {
    orderType: "limit", limitPrice: null, stopPrice: null, timeInForce: "gfd", marketHours, quantity,
    expectedSlippageBps: 0, expectedCostBps: 0, abort: true, abortReason: reason,
    repricing: { afterSeconds: 0, maxReprices: 0, stepBps: 0, maxChaseBps: 0 }, staging: null,
    reasons: [...reasons, `ABORT: ${reason}`],
  };
}

/**
 * Choose order type, price, quantity, staging and repricing rules for one order, and decide
 * whether the expected execution cost leaves enough of the edge to justify sending it.
 * Pure: no clock, no I/O. Stop order types are never used for entries or exits here.
 */
export function planExecution(ctx: ExecutionContext, settingsIn: ExecutionSettings): ExecutionPlan {
  const s: Required<ExecutionSettings> = { ...DEFAULT_EXECUTION_SETTINGS, ...settingsIn };
  const reasons: string[] = [];
  const marketHours: MarketHours = ctx.session === "regular" ? "regular_hours" : ctx.session === "overnight" ? "all_day_hours" : "extended_hours";

  if (!(ctx.quantity > 0)) return abortPlan("quantity must be positive", reasons, 0, marketHours);
  if (!(ctx.last > 0)) return abortPlan("no valid last price", reasons, ctx.quantity, marketHours);
  if (ctx.session === "closed") return abortPlan("market session is closed; no order can be worked", reasons, ctx.quantity, marketHours);
  if (ctx.session !== "regular" && !ctx.extendedHoursAllowed) return abortPlan(`session ${ctx.session} but extended-hours trading is not allowed for this symbol/account`, reasons, ctx.quantity, marketHours);
  if (ctx.expectedEdgeBps <= 0) return abortPlan("no positive expected edge to pay execution costs from", reasons, ctx.quantity, marketHours);

  // Spread
  let spreadBps = ctx.spreadBps;
  if (spreadBps === null && ctx.bid !== null && ctx.ask !== null && ctx.bid > 0 && ctx.ask >= ctx.bid) {
    spreadBps = ((ctx.ask - ctx.bid) / ((ctx.ask + ctx.bid) / 2)) * 10_000;
  }
  if (spreadBps === null) reasons.push(`spread unknown; assuming the maximum ${s.maxSpreadBps} bps for cost estimation`);
  else reasons.push(`spread ${spreadBps.toFixed(1)} bps`);
  if (spreadBps !== null && spreadBps > s.maxSpreadBps) return abortPlan(`spread ${spreadBps.toFixed(1)} bps exceeds the ${s.maxSpreadBps} bps limit`, reasons, ctx.quantity, marketHours);

  // Participation
  const notional = ctx.quantity * ctx.last;
  const participation = ctx.adv !== null && ctx.adv > 0 ? notional / ctx.adv : null;
  if (participation === null) reasons.push("ADV unknown; impact estimated at 5% participation");
  else reasons.push(`order is ${(participation * 100).toFixed(2)}% of ADV`);
  if (participation !== null && participation > s.maxParticipation) return abortPlan(`order is ${(participation * 100).toFixed(1)}% of ADV, above the ${(s.maxParticipation * 100).toFixed(0)}% cap`, reasons, ctx.quantity, marketHours);

  // Close proximity
  if (ctx.minutesToClose !== null && ctx.minutesToClose < 2 && ctx.urgency !== "high") {
    return abortPlan(`only ${ctx.minutesToClose.toFixed(1)} minutes to the close; not enough time to work a non-urgent order`, reasons, ctx.quantity, marketHours);
  }
  let urgency = ctx.urgency;
  if (ctx.minutesToClose !== null && ctx.minutesToClose < 5 && urgency === "low") {
    urgency = "normal";
    reasons.push("close is near; low urgency promoted to normal so the order can fill");
  }

  // Prices
  const bid = ctx.bid !== null && ctx.bid > 0 ? ctx.bid : ctx.last;
  const ask = ctx.ask !== null && ctx.ask > 0 ? ctx.ask : ctx.last;
  const mid = (bid + ask) / 2;
  const regular = ctx.session === "regular";
  const spreadForOffset = spreadBps ?? s.maxSpreadBps;

  // Order type & style
  let orderType: OrderType;
  let style: SlippageModelInput["orderStyle"];
  let limitPrice: number | null = null;
  let expectedTime: number;
  const learnedTime = ctx.learned?.avgTimeToFillSec ?? null;
  const restTime = learnedTime !== null && learnedTime > 0 ? clamp(learnedTime, 10, 900) : s.defaultRepriceSeconds;

  if (urgency === "high") {
    const tightAndSmall = spreadBps !== null && spreadBps <= s.marketableSpreadBps && (participation ?? 0.05) <= 0.01;
    if (regular && tightAndSmall) {
      orderType = "market"; style = "market"; expectedTime = 5;
      reasons.push("high urgency, tight spread and small size: market order in regular hours");
    } else {
      orderType = "limit"; style = "marketable_limit"; expectedTime = 30;
      const offsetBps = Math.min(Math.max(spreadForOffset / 2, 2), s.maxChaseBps);
      limitPrice = ctx.side === "buy" ? roundPrice(ask * (1 + offsetBps / 10_000), "sell") : roundPrice(bid * (1 - offsetBps / 10_000), "buy");
      reasons.push(`high urgency: marketable limit ${offsetBps.toFixed(1)} bps through the ${ctx.side === "buy" ? "ask" : "bid"}${regular ? "" : " (limit-only session)"}`);
    }
  } else if (urgency === "normal") {
    orderType = "limit"; style = "mid_limit"; expectedTime = restTime;
    limitPrice = roundPrice(mid, ctx.side);
    reasons.push(`normal urgency: limit at mid ${limitPrice}`);
  } else {
    orderType = "limit"; style = "passive_limit"; expectedTime = 2 * restTime;
    limitPrice = ctx.side === "buy" ? roundPrice(bid, "buy") : roundPrice(ask, "sell");
    reasons.push(`low urgency: passive limit at the ${ctx.side === "buy" ? "bid" : "ask"} ${limitPrice}`);
  }
  if (!regular && orderType !== "limit") { orderType = "limit"; style = "marketable_limit"; limitPrice = ctx.side === "buy" ? roundPrice(ask, "sell") : roundPrice(bid, "buy"); }

  // Quantity rounding: fractional only for market orders in regular hours when the symbol allows it.
  let quantity = ctx.quantity;
  const fractionalOk = orderType === "market" && regular && ctx.fractionalAllowed;
  if (!Number.isInteger(quantity)) {
    if (fractionalOk) {
      quantity = roundTo(quantity, 4);
      reasons.push("fractional quantity kept (market order, regular hours)");
    } else {
      quantity = Math.floor(quantity);
      reasons.push(`quantity rounded down to ${quantity} whole shares (${orderType} order${regular ? "" : ", non-regular session"})`);
      if (quantity <= 0) return abortPlan("quantity rounds to zero whole shares; fractional shares need a market order in regular hours", reasons, ctx.quantity, marketHours);
    }
  }

  // Slippage / cost
  const model = modelSlippageBps({ spreadBps, participation, realizedVolDaily: ctx.realizedVolDaily, expectedTimeToFillSec: expectedTime, orderStyle: style, settings: s });
  let expectedSlippageBps = model.total;
  reasons.push(`model slippage ${model.total.toFixed(1)} bps (half-spread ${model.halfSpread.toFixed(1)}, impact ${model.impact.toFixed(1)}, timing ${model.volTerm.toFixed(1)})`);
  if (ctx.learned && ctx.learned.avgSlippageBps !== null && Number.isFinite(ctx.learned.avgSlippageBps)) {
    expectedSlippageBps = Math.max(0, ctx.learned.avgSlippageBps);
    reasons.push(`learned slippage ${expectedSlippageBps.toFixed(1)} bps overrides the model`);
  }
  const expectedCostBps = expectedSlippageBps + (ctx.side === "sell" ? REGULATORY_SELL_FEE_BPS : 0);
  if (expectedCostBps >= ctx.expectedEdgeBps * s.costEdgeRatio) {
    return abortPlan(`expected cost ${expectedCostBps.toFixed(1)} bps consumes ${((expectedCostBps / ctx.expectedEdgeBps) * 100).toFixed(0)}% of the ${ctx.expectedEdgeBps.toFixed(0)} bps edge (limit ${(s.costEdgeRatio * 100).toFixed(0)}%)`, reasons, quantity, marketHours);
  }
  reasons.push(`expected cost ${expectedCostBps.toFixed(1)} bps versus edge ${ctx.expectedEdgeBps.toFixed(0)} bps`);

  // Staging
  let staging: ExecutionPlan["staging"] = null;
  if (participation !== null && participation > s.stagingParticipation) {
    const slices = Math.min(10, Math.ceil(participation / s.stagingParticipation));
    staging = { slices, intervalSeconds: 300 };
    reasons.push(`large versus ADV: staged into ${slices} slices five minutes apart`);
  }

  // Repricing rules
  const stepBps = orderType === "market" ? 0 : Math.max(1, Math.round(spreadForOffset / 2));
  const maxReprices = orderType === "market" ? 0 : Math.max(0, Math.min(5, Math.floor(s.maxChaseBps / stepBps)));
  let afterSeconds = orderType === "market" ? 0 : restTime;
  if (urgency === "high" && orderType !== "market") afterSeconds = Math.min(afterSeconds, 30);
  const repricing = { afterSeconds: Math.round(afterSeconds), maxReprices, stepBps, maxChaseBps: orderType === "market" ? 0 : s.maxChaseBps };
  if (orderType !== "market") reasons.push(`reprice after ${repricing.afterSeconds}s in ${stepBps} bps steps, at most ${maxReprices} times, never more than ${s.maxChaseBps} bps from the original price`);

  return {
    orderType, limitPrice, stopPrice: null, timeInForce: "gfd", marketHours, quantity,
    expectedSlippageBps: roundTo(expectedSlippageBps, 2), expectedCostBps: roundTo(expectedCostBps, 2),
    abort: false, abortReason: null, repricing, staging, reasons,
  };
}
