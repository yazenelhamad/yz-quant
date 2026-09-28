import type { IsoTimestamp, TenantScope } from "./ids.js";

export type FastAction =
  | "BUY" | "SELL" | "HOLD" | "WAIT" | "REDUCE" | "EXIT" | "CANCEL_ORDER" | "REPRICE_ORDER";

export const FAST_ACTIONS: readonly FastAction[] = [
  "BUY", "SELL", "HOLD", "WAIT", "REDUCE", "EXIT", "CANCEL_ORDER", "REPRICE_ORDER",
];

export interface FastBrainInput {
  scope: TenantScope;
  symbol: string;
  strategyKey: string;
  hasPosition: boolean;
  positionPnlPct: number | null;
  positionAgeDays: number | null;
  invalidated: boolean;
  targetReached: boolean;
  expectedEdge: number;
  confidence: number;
  disagreement: number;
  uncertainty: number;
  regimeFit: number;
  liquidityScore: number;
  spreadBps: number | null;
  dataFreshness: "fresh" | "aging" | "stale" | "unknown";
  portfolioFit: number; // -1..1 from the portfolio engine
  riskCapacity: number; // 0..1 remaining capacity
  eventRiskWithinHorizon: boolean;
  openOrder: { side: "buy" | "sell"; ageSeconds: number; distanceFromMarketBps: number; fillProbability: number } | null;
  marketSession: "closed" | "pre" | "regular" | "post" | "overnight";
  calibrationAdjustment: number; // multiplicative on confidence, from the learning engine
}

export interface FastBrainOutput {
  scope: TenantScope;
  symbol: string;
  probabilities: Record<FastAction, number>;
  action: FastAction;
  /** Probability of the chosen action. */
  conviction: number;
  reasons: string[];
  modelVersion: string;
  decidedAt: IsoTimestamp;
  /** Never true: the fast brain cannot bypass risk. Present for auditing. */
  bypassedRisk: false;
}
