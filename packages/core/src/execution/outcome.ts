import type { ExecutionOutcome, IsoTimestamp, TenantScope } from "../types/index.js";

export interface ExpectedExecution {
  scope: TenantScope;
  brokerOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  /** Price the plan expected to trade at (limit price, or the arrival mid for market orders). */
  expectedPrice: number;
  /** Mid / last at the moment the decision was made (arrival price). */
  arrivalPrice: number;
  expectedSlippageBps: number;
  requestedQuantity: number;
  adv: number | null;
  session: string;
}

export interface ActualExecution {
  fillPrice: number | null;
  filledQuantity: number;
  timeToFillSeconds: number | null;
  reprices: number;
  cancelled: boolean;
  at: IsoTimestamp;
}

export function liquidityBucket(adv: number | null): "low" | "medium" | "high" {
  if (adv === null || adv < 5_000_000) return "low";
  if (adv < 50_000_000) return "medium";
  return "high";
}

/**
 * Compare what the plan expected with what happened. Slippage is measured against the arrival
 * price and signed so that a positive number is a cost to the account for either side.
 */
export function evaluateOutcome(expected: ExpectedExecution, actual: ActualExecution): ExecutionOutcome {
  const filled = actual.filledQuantity > 0 && actual.fillPrice !== null && Number.isFinite(actual.fillPrice);
  let actualSlippageBps: number | null = null;
  if (filled && expected.arrivalPrice > 0) {
    const raw = (((actual.fillPrice as number) - expected.arrivalPrice) / expected.arrivalPrice) * 10_000;
    actualSlippageBps = Math.round((expected.side === "buy" ? raw : -raw) * 100) / 100;
  }
  return {
    scope: expected.scope,
    brokerOrderId: expected.brokerOrderId,
    symbol: expected.symbol,
    side: expected.side,
    expectedPrice: expected.expectedPrice,
    arrivalPrice: expected.arrivalPrice,
    fillPrice: filled ? actual.fillPrice : null,
    expectedSlippageBps: expected.expectedSlippageBps,
    actualSlippageBps,
    timeToFillSeconds: filled ? actual.timeToFillSeconds : null,
    partial: filled && actual.filledQuantity < expected.requestedQuantity,
    missed: !filled,
    reprices: actual.reprices,
    cancelled: actual.cancelled,
    liquidityBucket: liquidityBucket(expected.adv),
    session: expected.session,
    at: actual.at,
  };
}

/** Realised minus expected slippage in bps (positive = worse than modelled); null when unfilled. */
export function slippageSurpriseBps(outcome: ExecutionOutcome): number | null {
  return outcome.actualSlippageBps === null ? null : Math.round((outcome.actualSlippageBps - outcome.expectedSlippageBps) * 100) / 100;
}
