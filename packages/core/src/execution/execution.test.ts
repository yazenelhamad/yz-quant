import { describe, expect, it } from "vitest";
import type { ExecutionContext, ExecutionPlan } from "../types/index.js";
import { evaluateOutcome, liquidityBucket, slippageSurpriseBps } from "./outcome.js";
import { shouldCancel, shouldReprice, type MarketSnapshot, type OpenOrderState } from "./monitor.js";
import { DEFAULT_EXECUTION_SETTINGS, modelSlippageBps, planExecution, roundPrice } from "./plan.js";

const SETTINGS = { maxSpreadBps: 25, maxChaseBps: 20, defaultRepriceSeconds: 45 };
const SCOPE = { userId: "u1", brokerAccountId: "a1" };

function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    scope: SCOPE, symbol: "TEST", side: "buy", quantity: 100, urgency: "normal",
    last: 100, bid: 99.98, ask: 100.02, spreadBps: null, adv: 50_000_000, realizedVolDaily: 0.015,
    session: "regular", minutesToClose: 120, expectedEdgeBps: 150, fractionalAllowed: true, extendedHoursAllowed: true, learned: null,
    ...over,
  };
}

describe("planExecution", () => {
  it("uses a limit at mid for normal urgency in regular hours and never a stop type", () => {
    const p = planExecution(ctx(), SETTINGS);
    expect(p.abort).toBe(false);
    expect(p.orderType).toBe("limit");
    expect(p.stopPrice).toBeNull();
    expect(p.limitPrice).toBe(100);
    expect(p.marketHours).toBe("regular_hours");
    expect(p.timeInForce).toBe("gfd");
    expect(p.expectedCostBps).toBeGreaterThan(0);
    expect(p.expectedCostBps).toBeLessThan(75);
    expect(p.repricing.maxChaseBps).toBe(20);
    expect(p.repricing.afterSeconds).toBe(45);
    expect(p.reasons.some((r) => /limit at mid/.test(r))).toBe(true);
  });

  it("goes to market for high urgency with a tight spread and small size, keeping fractional quantity", () => {
    const p = planExecution(ctx({ urgency: "high", quantity: 10.5 }), SETTINGS);
    expect(p.orderType).toBe("market");
    expect(p.limitPrice).toBeNull();
    expect(p.quantity).toBe(10.5);
    expect(p.repricing.maxReprices).toBe(0);
  });

  it("uses a marketable limit through the ask for high urgency when the spread is wide or size is large", () => {
    const p = planExecution(ctx({ urgency: "high", bid: 99.9, ask: 100.1, quantity: 100 }), SETTINGS);
    expect(p.orderType).toBe("limit");
    expect(p.limitPrice!).toBeGreaterThan(100.1);
    const sell = planExecution(ctx({ urgency: "high", side: "sell", bid: 99.9, ask: 100.1 }), SETTINGS);
    expect(sell.limitPrice!).toBeLessThan(99.9);
    expect(sell.limitPrice!).toBeGreaterThanOrEqual(99.9 * (1 - 20 / 10_000) - 0.01);
  });

  it("rests passively at the bid/ask for low urgency", () => {
    const buy = planExecution(ctx({ urgency: "low" }), SETTINGS);
    expect(buy.limitPrice).toBe(99.98);
    const sell = planExecution(ctx({ urgency: "low", side: "sell" }), SETTINGS);
    expect(sell.limitPrice).toBe(100.02);
    expect(buy.repricing.afterSeconds).toBe(45);
  });

  it("forces limit-only orders in extended and overnight sessions and rounds fractional quantities down", () => {
    const ext = planExecution(ctx({ session: "post", urgency: "high", quantity: 10.7 }), SETTINGS);
    expect(ext.orderType).toBe("limit");
    expect(ext.marketHours).toBe("extended_hours");
    expect(ext.quantity).toBe(10);
    const overnight = planExecution(ctx({ session: "overnight", quantity: 10.7 }), SETTINGS);
    expect(overnight.marketHours).toBe("all_day_hours");
    expect(overnight.orderType).toBe("limit");
    expect(overnight.quantity).toBe(10);
    const notAllowed = planExecution(ctx({ session: "pre", extendedHoursAllowed: false }), SETTINGS);
    expect(notAllowed.abort).toBe(true);
    expect(notAllowed.abortReason).toMatch(/extended-hours/);
    const closed = planExecution(ctx({ session: "closed" }), SETTINGS);
    expect(closed.abort).toBe(true);
  });

  it("rounds fractional quantity down for limit orders and aborts when that leaves nothing", () => {
    const p = planExecution(ctx({ quantity: 3.6 }), SETTINGS);
    expect(p.quantity).toBe(3);
    const zero = planExecution(ctx({ quantity: 0.6 }), SETTINGS);
    expect(zero.abort).toBe(true);
    expect(zero.abortReason).toMatch(/rounds to zero/);
    const noFractional = planExecution(ctx({ quantity: 3.6, urgency: "high", fractionalAllowed: false }), SETTINGS);
    expect(noFractional.orderType).toBe("market");
    expect(noFractional.quantity).toBe(3);
  });

  it("aborts when the spread exceeds the maximum", () => {
    const p = planExecution(ctx({ bid: 99.5, ask: 100.5 }), SETTINGS);
    expect(p.abort).toBe(true);
    expect(p.abortReason).toMatch(/spread/);
    const explicit = planExecution(ctx({ spreadBps: 40 }), SETTINGS);
    expect(explicit.abort).toBe(true);
  });

  it("aborts when expected cost destroys the edge", () => {
    const p = planExecution(ctx({ expectedEdgeBps: 8, urgency: "high", bid: 99.9, ask: 100.1, quantity: 5000 }), SETTINGS);
    expect(p.abort).toBe(true);
    expect(p.abortReason).toMatch(/expected cost/);
    expect(p.reasons[p.reasons.length - 1]).toMatch(/^ABORT/);
    const noEdge = planExecution(ctx({ expectedEdgeBps: 0 }), SETTINGS);
    expect(noEdge.abort).toBe(true);
    const learnedBad = planExecution(ctx({ expectedEdgeBps: 30, learned: { avgSlippageBps: 20, fillRateLimitAtMid: null, avgTimeToFillSec: null } }), SETTINGS);
    expect(learnedBad.abort).toBe(true);
    expect(learnedBad.reasons.some((r) => /learned slippage/.test(r))).toBe(true);
  });

  it("stages orders that are large relative to ADV and refuses ones that are too large", () => {
    const staged = planExecution(ctx({ quantity: 30_000, adv: 50_000_000, expectedEdgeBps: 400 }), SETTINGS); // 6% of ADV
    expect(staged.abort).toBe(false);
    expect(staged.staging).toEqual({ slices: 3, intervalSeconds: 300 });
    const tooBig = planExecution(ctx({ quantity: 150_000, adv: 50_000_000 }), SETTINGS); // 30% of ADV
    expect(tooBig.abort).toBe(true);
    expect(tooBig.abortReason).toMatch(/ADV/);
    expect(planExecution(ctx(), SETTINGS).staging).toBeNull();
  });

  it("slippage model: half spread + impact + timing, with passive styles cheaper and learned overrides", () => {
    const s = DEFAULT_EXECUTION_SETTINGS;
    const market = modelSlippageBps({ spreadBps: 10, participation: 0.01, realizedVolDaily: 0.02, expectedTimeToFillSec: 5, orderStyle: "market", settings: s });
    expect(market.halfSpread).toBe(5);
    expect(market.impact).toBeCloseTo(2.5, 6);
    expect(market.volTerm).toBeGreaterThan(0);
    expect(market.total).toBeCloseTo(market.halfSpread + market.impact + market.volTerm, 9);
    const passive = modelSlippageBps({ spreadBps: 10, participation: 0.01, realizedVolDaily: 0.02, expectedTimeToFillSec: 90, orderStyle: "passive_limit", settings: s });
    expect(passive.total).toBeLessThan(market.total);
    expect(passive.total).toBeGreaterThanOrEqual(0);
    const bigger = modelSlippageBps({ spreadBps: 10, participation: 0.09, realizedVolDaily: 0.02, expectedTimeToFillSec: 5, orderStyle: "market", settings: s });
    expect(bigger.impact).toBeCloseTo(7.5, 6);
    const learned = planExecution(ctx({ learned: { avgSlippageBps: 3, fillRateLimitAtMid: 0.6, avgTimeToFillSec: 20 } }), SETTINGS);
    expect(learned.expectedSlippageBps).toBe(3);
    expect(learned.repricing.afterSeconds).toBe(20);
  });

  it("handles the close: aborts non-urgent orders in the last two minutes, promotes low urgency near the close", () => {
    expect(planExecution(ctx({ minutesToClose: 1 }), SETTINGS).abort).toBe(true);
    expect(planExecution(ctx({ minutesToClose: 1, urgency: "high" }), SETTINGS).abort).toBe(false);
    const promoted = planExecution(ctx({ minutesToClose: 4, urgency: "low" }), SETTINGS);
    expect(promoted.limitPrice).toBe(100);
    expect(promoted.reasons.some((r) => /promoted/.test(r))).toBe(true);
  });

  it("repricing rules stay within the chase budget", () => {
    const p = planExecution(ctx({ bid: 99.95, ask: 100.05 }), SETTINGS);
    expect(p.repricing.stepBps).toBe(5);
    expect(p.repricing.maxReprices).toBe(4);
    expect(p.repricing.stepBps * p.repricing.maxReprices).toBeLessThanOrEqual(SETTINGS.maxChaseBps);
  });

  it("is deterministic and rounds prices to the tick", () => {
    expect(planExecution(ctx(), SETTINGS)).toEqual(planExecution(ctx(), SETTINGS));
    expect(roundPrice(100.005, "buy")).toBe(100);
    expect(roundPrice(100.005, "sell")).toBe(100.01);
    expect(roundPrice(0.12345, "buy")).toBe(0.1234);
  });
});

describe("monitor: shouldReprice / shouldCancel", () => {
  const plan: ExecutionPlan = planExecution(ctx({ bid: 99.95, ask: 100.05 }), SETTINGS);
  const placed = "2025-03-03T15:00:00Z";
  const order = (over: Partial<OpenOrderState> = {}): OpenOrderState => ({
    side: "buy", orderType: "limit", limitPrice: 100, originalLimitPrice: 100, placedAt: placed, lastRepricedAt: null, reprices: 0, quantity: 100, filledQuantity: 0, ...over,
  });
  const quote = (over: Partial<MarketSnapshot> = {}, at = "2025-03-03T15:01:00Z"): MarketSnapshot => ({ bid: 100.05, ask: 100.15, last: 100.1, asOf: at, session: "regular", ...over });

  it("reprices toward the ask after the rest period, in bounded steps", () => {
    const early = shouldReprice(order(), quote({}, "2025-03-03T15:00:20Z"), plan, "2025-03-03T15:00:20Z");
    expect(early.reprice).toBe(false);
    expect(early.reason).toMatch(/waiting/);
    const due = shouldReprice(order(), quote(), plan, "2025-03-03T15:01:00Z");
    expect(due.reprice).toBe(true);
    expect(due.newLimitPrice).toBe(100.05); // one 5 bps step
    expect(due.newLimitPrice!).toBeLessThanOrEqual(100.15);
  });

  it("does not chase beyond maxChaseBps and stops when the budget is spent", () => {
    const atCap = shouldReprice(order({ limitPrice: 100.2, reprices: 3, lastRepricedAt: "2025-03-03T15:00:00Z" }), quote({ bid: 100.4, ask: 100.5 }), plan, "2025-03-03T15:01:00Z");
    expect(atCap.reprice).toBe(false);
    expect(atCap.reason).toMatch(/chase limit/);
    const nearCap = shouldReprice(order({ limitPrice: 100.18, reprices: 3, lastRepricedAt: "2025-03-03T15:00:00Z" }), quote({ bid: 100.4, ask: 100.5 }), plan, "2025-03-03T15:01:00Z");
    expect(nearCap.reprice).toBe(true);
    expect(nearCap.newLimitPrice!).toBeLessThanOrEqual(100.2 + 1e-9);
    const spent = shouldReprice(order({ reprices: plan.repricing.maxReprices }), quote(), plan, "2025-03-03T15:01:00Z");
    expect(spent.reprice).toBe(false);
    expect(spent.reason).toMatch(/exhausted/);
  });

  it("never reprices on a stale quote, a marketable order, a filled order or a non-limit order", () => {
    expect(shouldReprice(order(), quote({}, "2025-03-03T14:50:00Z"), plan, "2025-03-03T15:01:00Z").reprice).toBe(false);
    expect(shouldReprice(order({ limitPrice: 100.2 }), quote(), plan, "2025-03-03T15:01:00Z").reason).toMatch(/already at or above/);
    expect(shouldReprice(order({ filledQuantity: 100 }), quote(), plan, "2025-03-03T15:01:00Z").reprice).toBe(false);
    expect(shouldReprice(order({ orderType: "market", limitPrice: null }), quote(), plan, "2025-03-03T15:01:00Z").reprice).toBe(false);
  });

  it("reprices sell orders downward toward the bid", () => {
    const d = shouldReprice(order({ side: "sell", limitPrice: 100.2, originalLimitPrice: 100.2 }), quote({ bid: 100.05, ask: 100.15 }), plan, "2025-03-03T15:01:00Z");
    expect(d.reprice).toBe(true);
    expect(d.newLimitPrice).toBe(100.14);
  });

  it("cancels when the edge is gone, the market ran away, the session ends, or data is stale", () => {
    const base = { currentExpectedEdgeBps: 150, minutesToClose: 60, dataFreshness: "fresh" as const };
    expect(shouldCancel(order(), quote(), plan, "2025-03-03T15:01:00Z", base).cancel).toBe(false);
    expect(shouldCancel(order(), quote(), plan, "2025-03-03T15:01:00Z", { ...base, currentExpectedEdgeBps: 1 }).reason).toMatch(/edge gone/);
    expect(shouldCancel(order(), quote({ bid: 100.5, ask: 100.6 }), plan, "2025-03-03T15:01:00Z", base).reason).toMatch(/moved .* away/);
    expect(shouldCancel(order(), quote(), plan, "2025-03-03T15:01:00Z", { ...base, minutesToClose: 0.5 }).reason).toMatch(/session ending/);
    expect(shouldCancel(order(), quote({ session: "closed" }), plan, "2025-03-03T15:01:00Z", base).cancel).toBe(true);
    expect(shouldCancel(order(), quote(), plan, "2025-03-03T15:01:00Z", { ...base, dataFreshness: "stale" }).reason).toMatch(/stale/);
    expect(shouldCancel(order(), quote(), plan, "2025-03-03T16:00:00Z", base).reason).toMatch(/old/);
    expect(shouldCancel(order({ reprices: plan.repricing.maxReprices, lastRepricedAt: "2025-03-03T15:00:00Z" }), quote(), plan, "2025-03-03T15:02:00Z", base).reason).toMatch(/budget spent/);
    expect(shouldCancel(order({ filledQuantity: 100 }), quote(), plan, "2025-03-03T15:01:00Z", base).cancel).toBe(false);
  });
});

describe("evaluateOutcome", () => {
  const expected = { scope: SCOPE, brokerOrderId: "o1", symbol: "TEST", side: "buy" as const, expectedPrice: 100, arrivalPrice: 100, expectedSlippageBps: 4, requestedQuantity: 100, adv: 20_000_000, session: "regular" };

  it("computes signed slippage for buys and sells", () => {
    const buy = evaluateOutcome(expected, { fillPrice: 100.1, filledQuantity: 100, timeToFillSeconds: 12, reprices: 1, cancelled: false, at: "2025-03-03T15:01:00Z" });
    expect(buy.actualSlippageBps).toBeCloseTo(10, 6);
    expect(buy.partial).toBe(false);
    expect(buy.missed).toBe(false);
    expect(buy.liquidityBucket).toBe("medium");
    expect(slippageSurpriseBps(buy)).toBeCloseTo(6, 6);
    const sell = evaluateOutcome({ ...expected, side: "sell" }, { fillPrice: 100.1, filledQuantity: 60, timeToFillSeconds: 30, reprices: 0, cancelled: true, at: "2025-03-03T15:01:00Z" });
    expect(sell.actualSlippageBps).toBeCloseTo(-10, 6);
    expect(sell.partial).toBe(true);
    expect(sell.cancelled).toBe(true);
  });

  it("marks missed fills and buckets liquidity", () => {
    const missed = evaluateOutcome(expected, { fillPrice: null, filledQuantity: 0, timeToFillSeconds: null, reprices: 2, cancelled: true, at: "2025-03-03T15:01:00Z" });
    expect(missed.missed).toBe(true);
    expect(missed.actualSlippageBps).toBeNull();
    expect(slippageSurpriseBps(missed)).toBeNull();
    expect(liquidityBucket(null)).toBe("low");
    expect(liquidityBucket(1e9)).toBe("high");
  });
});
