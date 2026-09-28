import type { IsoTimestamp, TenantScope } from "./ids.js";

export type TradeLifecycleState =
  | "candidate"
  | "analyzing"
  | "approved"
  | "waiting_for_entry"
  | "order_submitted"
  | "partially_filled"
  | "filled"
  | "monitoring"
  | "reduce"
  | "exit_requested"
  | "closed"
  | "rejected"
  | "canceled";

export const TRADE_TRANSITIONS: Readonly<Record<TradeLifecycleState, readonly TradeLifecycleState[]>> = {
  candidate: ["analyzing", "rejected", "canceled"],
  analyzing: ["approved", "rejected", "canceled"],
  approved: ["waiting_for_entry", "order_submitted", "rejected", "canceled"],
  waiting_for_entry: ["order_submitted", "canceled", "rejected"],
  order_submitted: ["partially_filled", "filled", "canceled", "rejected"],
  partially_filled: ["filled", "monitoring", "canceled", "exit_requested"],
  filled: ["monitoring"],
  monitoring: ["reduce", "exit_requested", "closed"],
  reduce: ["monitoring", "exit_requested", "closed"],
  exit_requested: ["closed", "monitoring"],
  closed: [],
  rejected: [],
  canceled: [],
};

export type TradeMode = "live" | "shadow";

export interface TradeRecord {
  id: string;
  scope: TenantScope;
  mode: TradeMode;
  symbol: string;
  strategyId: string;
  strategyVersionId: string | null;
  thesisId: string | null;
  state: TradeLifecycleState;
  direction: "long";
  entryQuantity: number;
  openQuantity: number;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  realizedPnl: number;
  fees: number;
  maxAdverseExcursionPct: number | null;
  maxFavorableExcursionPct: number | null;
  initialConfidence: number;
  expectedEdge: number;
  expectedDownsidePct: number;
  regimeAtEntry: string;
  openedAt: IsoTimestamp | null;
  closedAt: IsoTimestamp | null;
  exitReason: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type RejectionReason =
  | "insufficient_confidence"
  | "insufficient_expected_edge"
  | "portfolio_concentration"
  | "poor_liquidity"
  | "bad_risk_reward"
  | "event_risk"
  | "stale_data"
  | "strategy_disabled"
  | "risk_limit_exceeded"
  | "kill_switch"
  | "autonomy_level"
  | "no_thesis"
  | "devils_advocate"
  | "execution_cost"
  | "negative_net_expectancy"
  | "survival_mandate"
  | "market_session"
  | "broker_unavailable"
  | "identity_uncertain"
  | "other";

export interface RejectedTrade {
  id: string;
  scope: TenantScope;
  candidateId: string | null;
  symbol: string;
  strategyId: string;
  reasons: RejectionReason[];
  detail: string;
  expectedEdge: number;
  confidence: number;
  regime: string;
  priceAtRejection: number | null;
  rejectedAt: IsoTimestamp;
  /** Filled in later by the missed-opportunity review. */
  subsequentReturnPct: Record<string, number> | null; // e.g. {"1d": 0.4, "5d": 2.1}
  reviewVerdict: "correct_rejection" | "missed_opportunity" | "undetermined" | null;
}
