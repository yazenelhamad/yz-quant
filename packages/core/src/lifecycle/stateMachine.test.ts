import { describe, expect, it } from "vitest";
import type { BrokerOrderState, TradeLifecycleState } from "../types/index.js";
import { TRADE_TRANSITIONS } from "../types/index.js";
import {
  allowedTransitions,
  canTransition,
  InvalidTransitionError,
  isOpen,
  isTerminal,
  isTerminalOrderState,
  mapRobinhoodOrderState,
  nextStateForOrderState,
  transition,
} from "./stateMachine.js";

const ALL_STATES = Object.keys(TRADE_TRANSITIONS) as TradeLifecycleState[];
const ALL_ORDER_STATES: BrokerOrderState[] = [
  "new", "queued", "unconfirmed", "confirmed", "partially_filled", "filled", "pending_cancelled", "cancelled",
  "partially_filled_rest_cancelled", "rejected", "failed", "voided", "locating", "locate_failed", "unknown",
];

describe("canTransition", () => {
  it("allows documented transitions", () => {
    expect(canTransition("candidate", "analyzing")).toBe(true);
    expect(canTransition("analyzing", "approved")).toBe(true);
    expect(canTransition("approved", "order_submitted")).toBe(true);
    expect(canTransition("order_submitted", "filled")).toBe(true);
    expect(canTransition("filled", "monitoring")).toBe(true);
    expect(canTransition("monitoring", "exit_requested")).toBe(true);
    expect(canTransition("exit_requested", "closed")).toBe(true);
  });

  it("rejects undocumented transitions", () => {
    expect(canTransition("candidate", "filled")).toBe(false);
    expect(canTransition("closed", "monitoring")).toBe(false);
    expect(canTransition("rejected", "candidate")).toBe(false);
    expect(canTransition("filled", "closed")).toBe(false);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const s of ["closed", "rejected", "canceled"] as const) {
      expect(allowedTransitions(s)).toEqual([]);
      for (const t of ALL_STATES) expect(canTransition(s, t)).toBe(false);
    }
  });

  it("transition() returns the target or throws", () => {
    expect(transition("candidate", "analyzing")).toBe("analyzing");
    expect(() => transition("closed", "analyzing")).toThrow(InvalidTransitionError);
  });
});

describe("isOpen / isTerminal", () => {
  it("classifies states", () => {
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("monitoring")).toBe(false);
    expect(isOpen("monitoring")).toBe(true);
    expect(isOpen("partially_filled")).toBe(true);
    expect(isOpen("exit_requested")).toBe(true);
    expect(isOpen("candidate")).toBe(false);
    expect(isOpen("order_submitted")).toBe(false);
    expect(isOpen("closed")).toBe(false);
  });

  it("no state is both open and terminal", () => {
    for (const s of ALL_STATES) expect(isOpen(s) && isTerminal(s)).toBe(false);
  });

  it("isTerminalOrderState mirrors TERMINAL_ORDER_STATES", () => {
    expect(isTerminalOrderState("filled")).toBe(true);
    expect(isTerminalOrderState("cancelled")).toBe(true);
    expect(isTerminalOrderState("confirmed")).toBe(false);
    expect(isTerminalOrderState("unknown")).toBe(false);
  });
});

describe("nextStateForOrderState", () => {
  it("entry order lifecycle", () => {
    expect(nextStateForOrderState("confirmed", "approved")).toBe("order_submitted");
    expect(nextStateForOrderState("queued", "waiting_for_entry")).toBe("order_submitted");
    expect(nextStateForOrderState("confirmed", "order_submitted")).toBeNull();
    expect(nextStateForOrderState("partially_filled", "order_submitted")).toBe("partially_filled");
    expect(nextStateForOrderState("filled", "order_submitted")).toBe("filled");
    expect(nextStateForOrderState("filled", "partially_filled")).toBe("filled");
    expect(nextStateForOrderState("partially_filled_rest_cancelled", "partially_filled")).toBe("monitoring");
    expect(nextStateForOrderState("cancelled", "partially_filled")).toBe("monitoring");
  });

  it("entry rejection / cancellation", () => {
    expect(nextStateForOrderState("rejected", "order_submitted")).toBe("rejected");
    expect(nextStateForOrderState("failed", "order_submitted")).toBe("rejected");
    expect(nextStateForOrderState("cancelled", "order_submitted")).toBe("canceled");
    expect(nextStateForOrderState("voided", "order_submitted")).toBe("canceled");
    expect(nextStateForOrderState("locate_failed", "order_submitted")).toBe("canceled");
    expect(nextStateForOrderState("rejected", "approved")).toBe("rejected");
    expect(nextStateForOrderState("cancelled", "waiting_for_entry")).toBe("canceled");
  });

  it("exit order lifecycle", () => {
    expect(nextStateForOrderState("filled", "exit_requested")).toBe("closed");
    expect(nextStateForOrderState("partially_filled", "exit_requested")).toBeNull();
    expect(nextStateForOrderState("cancelled", "exit_requested")).toBe("monitoring");
    expect(nextStateForOrderState("rejected", "exit_requested")).toBe("monitoring");
    expect(nextStateForOrderState("partially_filled_rest_cancelled", "exit_requested")).toBe("monitoring");
  });

  it("reduce order lifecycle", () => {
    expect(nextStateForOrderState("filled", "reduce")).toBe("monitoring");
    expect(nextStateForOrderState("cancelled", "reduce")).toBe("monitoring");
    expect(nextStateForOrderState("confirmed", "reduce")).toBeNull();
  });

  it("unknown order state never moves a trade", () => {
    for (const s of ALL_STATES) expect(nextStateForOrderState("unknown", s)).toBeNull();
  });

  it("states without an active order never move", () => {
    for (const s of ["candidate", "analyzing", "filled", "monitoring", "closed", "rejected", "canceled"] as const) {
      for (const o of ALL_ORDER_STATES) expect(nextStateForOrderState(o, s)).toBeNull();
    }
  });

  it("every non-null result is a legal transition", () => {
    for (const s of ALL_STATES) {
      for (const o of ALL_ORDER_STATES) {
        const n = nextStateForOrderState(o, s);
        if (n !== null) expect(canTransition(s, n)).toBe(true);
      }
    }
  });
});

describe("mapRobinhoodOrderState", () => {
  it("maps every documented state", () => {
    const documented = [
      "new", "queued", "unconfirmed", "confirmed", "partially_filled", "filled", "cancelled", "rejected", "failed",
      "voided", "pending_cancelled", "partially_filled_rest_cancelled", "locating", "locate_failed",
    ];
    for (const s of documented) expect(mapRobinhoodOrderState(s)).toBe(s);
  });

  it("normalises case, whitespace and American spelling", () => {
    expect(mapRobinhoodOrderState(" Filled ")).toBe("filled");
    expect(mapRobinhoodOrderState("canceled")).toBe("cancelled");
    expect(mapRobinhoodOrderState("Pending Cancelled")).toBe("pending_cancelled");
    expect(mapRobinhoodOrderState("partially-filled")).toBe("partially_filled");
  });

  it("unknown inputs map to unknown, never a guess", () => {
    expect(mapRobinhoodOrderState("weird_state")).toBe("unknown");
    expect(mapRobinhoodOrderState("")).toBe("unknown");
    expect(mapRobinhoodOrderState(null)).toBe("unknown");
    expect(mapRobinhoodOrderState(undefined)).toBe("unknown");
    expect(mapRobinhoodOrderState(42)).toBe("unknown");
    expect(mapRobinhoodOrderState({ state: "filled" })).toBe("unknown");
  });
});
