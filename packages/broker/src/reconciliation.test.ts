import { describe, expect, it } from "vitest";
import { CrossTenantError } from "@yz/core";
import type { BrokerOrder, PortfolioSnapshot, Position } from "@yz/core";
import { BrokerError } from "./errors.js";
import { classifyReconciliationFailure, reconcile } from "./reconciliation.js";
import { SCOPE_A, SCOPE_B } from "./testing/fixtures.js";

const prov = { source: "robinhood_mcp:test", observedAt: "2026-09-28T14:30:00Z", receivedAt: "2026-09-28T14:30:00Z", reliability: 0.98 };
const pos = (symbol: string, quantity: number, scope = SCOPE_A): Position => ({ scope, symbol, assetClass: "equity", quantity, intradayQuantity: 0, sharesAvailableForSells: quantity, averageCost: 100, markPrice: null, marketValue: null, unrealizedPnl: null, asOf: prov.observedAt, provenance: prov });
const order = (id: string, o: Partial<BrokerOrder> = {}): BrokerOrder => ({ scope: SCOPE_A, brokerOrderId: id, refId: `ref-${id}`, symbol: "AAPL", side: "buy", type: "limit", state: "confirmed", quantity: 10, cumulativeQuantity: 0, limitPrice: 100, stopPrice: null, averagePrice: null, fees: 0, timeInForce: "gfd", marketHours: "regular_hours", placedAgent: "agentic", createdAt: prov.observedAt, updatedAt: prov.observedAt, ...o });
const portfolio = (cash: number): PortfolioSnapshot => ({ scope: SCOPE_A, asOf: prov.observedAt, totalValue: cash, equityValue: 0, optionsValue: 0, cryptoValue: 0, cash, pendingDeposits: 0, buyingPower: cash, unleveragedBuyingPower: cash, currency: "USD", provenance: prov });

describe("reconcile", () => {
  it("is ok when everything matches within tolerance", () => {
    const r = reconcile({ positions: [{ symbol: "AAPL", quantity: 10 }], openOrders: [{ brokerOrderId: "o1", refId: "ref-o1", symbol: "AAPL", side: "buy", state: "confirmed" }], cash: 1000.4 }, { positions: [pos("AAPL", 10)], orders: [order("o1")], portfolio: portfolio(1000) });
    expect(r).toMatchObject({ ok: true, action: "none", positionMismatches: [], orderMismatches: [], unexpectedPositions: [] });
    expect(r.cashDifference).toBeCloseTo(-0.4);
  });
  it("pauses on position quantity mismatch", () => {
    const r = reconcile({ positions: [{ symbol: "AAPL", quantity: 10 }], openOrders: [], cash: null }, { positions: [pos("AAPL", 12)], orders: [], portfolio: null });
    expect(r.ok).toBe(false);
    expect(r.action).toBe("pause_account");
    expect(r.positionMismatches).toEqual([{ symbol: "AAPL", internalQuantity: 10, brokerQuantity: 12, difference: 2 }]);
    expect(r.cashDifference).toBeNull();
  });
  it("reports unexpected broker positions; pauses unless flagged external", () => {
    const broker = { positions: [pos("TSLA", 3)], orders: [], portfolio: null };
    const unmanaged = reconcile({ positions: [], openOrders: [], cash: null }, broker);
    expect(unmanaged).toMatchObject({ ok: false, action: "pause_account", unexpectedPositions: [{ symbol: "TSLA", brokerQuantity: 3, external: false }] });
    const flagged = reconcile({ positions: [], openOrders: [], cash: null, externalSymbols: ["TSLA"] }, broker);
    expect(flagged).toMatchObject({ ok: true, action: "none", unexpectedPositions: [{ symbol: "TSLA", brokerQuantity: 3, external: true }] });
  });
  it("detects order mismatches in both directions and unknown states", () => {
    const r = reconcile(
      { positions: [], openOrders: [{ brokerOrderId: "gone", refId: null, symbol: "AAPL", side: "buy", state: "confirmed" }, { brokerOrderId: null, refId: "ref-o2", symbol: "AAPL", side: "buy", state: "confirmed" }], cash: null },
      { positions: [], orders: [order("o2", { state: "filled" }), order("o3", { placedAgent: "user" }), order("o4", { state: "unknown" }), order("o5", { state: "cancelled" })], portfolio: null },
    );
    expect(r.orderMismatches.map((m) => [m.kind, m.brokerOrderId])).toEqual([
      ["missing_at_broker", "gone"],
      ["state_mismatch", "o2"],
      ["missing_internally", "o3"],
      ["state_mismatch", "o4"],
    ]);
    expect(r.action).toBe("pause_account");
  });
  it("applies cash tolerances and pauses when the portfolio is unavailable", () => {
    const base = { positions: [], openOrders: [], cash: 1000 };
    expect(reconcile(base, { positions: [], orders: [], portfolio: portfolio(1000.9) }).ok).toBe(true);
    expect(reconcile(base, { positions: [], orders: [], portfolio: portfolio(1002) }).ok).toBe(false);
    expect(reconcile(base, { positions: [], orders: [], portfolio: portfolio(1002) }, { cashAbs: 5 }).ok).toBe(true);
    expect(reconcile(base, { positions: [], orders: [], portfolio: null })).toMatchObject({ ok: false, cashDifference: null });
  });
  it("refuses broker snapshots that span tenants", () => {
    expect(() => reconcile({ positions: [], openOrders: [], cash: null }, { positions: [pos("AAPL", 1), pos("MSFT", 1, SCOPE_B)], orders: [], portfolio: null })).toThrow(CrossTenantError);
  });
});

describe("classifyReconciliationFailure", () => {
  it("separates systemic from account-specific failures", () => {
    expect(classifyReconciliationFailure(new BrokerError("transport", "down")).kind).toBe("systemic");
    expect(classifyReconciliationFailure(new BrokerError("rate_limited", "slow")).kind).toBe("systemic");
    expect(classifyReconciliationFailure(new BrokerError("schema_drift", "changed")).kind).toBe("systemic");
    expect(classifyReconciliationFailure(new BrokerError("token_expired", "relogin")).kind).toBe("account_specific");
    expect(classifyReconciliationFailure(new BrokerError("not_connected", "none")).kind).toBe("account_specific");
    expect(classifyReconciliationFailure(new BrokerError("upstream_rejected", "no")).kind).toBe("account_specific");
    expect(classifyReconciliationFailure(new CrossTenantError("x", SCOPE_A, SCOPE_B))).toMatchObject({ kind: "account_specific", code: "cross_tenant" });
    expect(classifyReconciliationFailure(new TypeError("fetch failed"))).toMatchObject({ kind: "systemic", code: "network" });
  });
});
