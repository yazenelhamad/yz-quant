import type { BrokerOrderState, TradeLifecycleState } from "../types/index.js";
import { TERMINAL_ORDER_STATES, TRADE_TRANSITIONS } from "../types/index.js";

/** Trade states with no further transitions. */
export const TERMINAL_TRADE_STATES: ReadonlySet<TradeLifecycleState> = new Set<TradeLifecycleState>([
  "closed", "rejected", "canceled",
]);

/** Trade states in which the account holds (or may hold) exposure from this trade. */
export const OPEN_TRADE_STATES: ReadonlySet<TradeLifecycleState> = new Set<TradeLifecycleState>([
  "partially_filled", "filled", "monitoring", "reduce", "exit_requested",
]);

/** Trade states in which a broker order is expected to be working. */
export const ORDER_WORKING_TRADE_STATES: ReadonlySet<TradeLifecycleState> = new Set<TradeLifecycleState>([
  "order_submitted", "partially_filled", "reduce", "exit_requested",
]);

export function isTerminal(state: TradeLifecycleState): boolean {
  return TERMINAL_TRADE_STATES.has(state);
}

export function isOpen(state: TradeLifecycleState): boolean {
  return OPEN_TRADE_STATES.has(state);
}

export function isTerminalOrderState(state: BrokerOrderState): boolean {
  return TERMINAL_ORDER_STATES.has(state);
}

export function canTransition(from: TradeLifecycleState, to: TradeLifecycleState): boolean {
  const allowed = TRADE_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Returns the list of states reachable from `from` in one step. */
export function allowedTransitions(from: TradeLifecycleState): readonly TradeLifecycleState[] {
  return TRADE_TRANSITIONS[from] ?? [];
}

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  constructor(readonly from: TradeLifecycleState, readonly to: TradeLifecycleState) {
    super(`Invalid trade transition ${from} -> ${to}`);
  }
}

/** Returns `to` when the transition is legal, otherwise throws. */
export function transition(from: TradeLifecycleState, to: TradeLifecycleState): TradeLifecycleState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

/** Order states that end the order without any (further) execution. */
const NON_FILL_TERMINAL: ReadonlySet<BrokerOrderState> = new Set<BrokerOrderState>([
  "cancelled", "rejected", "failed", "voided", "locate_failed",
]);

/**
 * Given the observed broker order state and the trade's current state, returns the trade
 * state the trade should move to, or `null` when the observation implies no change.
 * The result is always a legal transition (or null). The mapping never guesses: an
 * `unknown` order state never moves the trade.
 */
export function nextStateForOrderState(orderState: BrokerOrderState, tradeState: TradeLifecycleState): TradeLifecycleState | null {
  if (orderState === "unknown") return null;
  let next: TradeLifecycleState | null = null;

  switch (tradeState) {
    case "approved":
    case "waiting_for_entry": {
      // An order exists for a trade we have not yet marked submitted.
      if (orderState === "rejected" || orderState === "failed") next = "rejected";
      else if (orderState === "cancelled" || orderState === "voided" || orderState === "locate_failed") next = "canceled";
      else next = "order_submitted";
      break;
    }
    case "order_submitted": {
      if (orderState === "filled") next = "filled";
      else if (orderState === "partially_filled" || orderState === "partially_filled_rest_cancelled") next = "partially_filled";
      else if (orderState === "rejected" || orderState === "failed") next = "rejected";
      else if (orderState === "cancelled" || orderState === "voided" || orderState === "locate_failed") next = "canceled";
      else next = null; // new / queued / unconfirmed / confirmed / pending_cancelled / locating: still working
      break;
    }
    case "partially_filled": {
      if (orderState === "filled") next = "filled";
      else if (orderState === "partially_filled_rest_cancelled" || NON_FILL_TERMINAL.has(orderState)) next = "monitoring"; // partial exposure remains
      else next = null;
      break;
    }
    case "reduce": {
      if (orderState === "filled" || orderState === "partially_filled_rest_cancelled" || NON_FILL_TERMINAL.has(orderState)) next = "monitoring";
      else next = null;
      break;
    }
    case "exit_requested": {
      if (orderState === "filled") next = "closed";
      else if (orderState === "partially_filled_rest_cancelled" || NON_FILL_TERMINAL.has(orderState)) next = "monitoring"; // exit incomplete, position remains
      else next = null;
      break;
    }
    default:
      next = null;
  }

  if (next === null) return null;
  return canTransition(tradeState, next) ? next : null;
}

/** Raw order state strings documented in docs/robinhood/ROBINHOOD_AGENTIC_TRADING.md. */
export const ROBINHOOD_ORDER_STATES: Readonly<Record<string, BrokerOrderState>> = {
  new: "new",
  queued: "queued",
  unconfirmed: "unconfirmed",
  confirmed: "confirmed",
  partially_filled: "partially_filled",
  filled: "filled",
  cancelled: "cancelled",
  canceled: "cancelled",
  rejected: "rejected",
  failed: "failed",
  voided: "voided",
  pending_cancelled: "pending_cancelled",
  pending_canceled: "pending_cancelled",
  partially_filled_rest_cancelled: "partially_filled_rest_cancelled",
  partially_filled_rest_canceled: "partially_filled_rest_cancelled",
  locating: "locating",
  locate_failed: "locate_failed",
};

/** Maps a raw Robinhood order state to the platform state. Anything unrecognised => "unknown". */
export function mapRobinhoodOrderState(raw: unknown): BrokerOrderState {
  if (typeof raw !== "string") return "unknown";
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ROBINHOOD_ORDER_STATES[key] ?? "unknown";
}
