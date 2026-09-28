import { describe, expect, it } from "vitest";
import type { FastBrainInput, FastBrainOutput } from "@yz/core";
import { FakeStructuredClient } from "../testing/fakeClient.js";
import { NotConfiguredClient } from "../llm/notConfiguredClient.js";
import { applyFastVerification, fastVerify } from "./fastVerify.js";
import { SCOPE_A } from "../committee/testFixtures.js";

const decision: FastBrainOutput = {
  scope: SCOPE_A,
  symbol: "ACME",
  probabilities: { BUY: 0.6, SELL: 0, HOLD: 0.2, WAIT: 0.2, REDUCE: 0, EXIT: 0, CANCEL_ORDER: 0, REPRICE_ORDER: 0 },
  action: "BUY",
  conviction: 0.6,
  reasons: ["edge"],
  modelVersion: "fb.1",
  decidedAt: "t",
  bypassedRisk: false,
};
const context: FastBrainInput = {
  scope: SCOPE_A, symbol: "ACME", strategyKey: "k", hasPosition: false, positionPnlPct: null, positionAgeDays: null, invalidated: false, targetReached: false,
  expectedEdge: 0.1, confidence: 0.6, disagreement: 0.1, uncertainty: 0.2, regimeFit: 0.8, liquidityScore: 0.9, spreadBps: 5, dataFreshness: "aging", portfolioFit: 0.3,
  riskCapacity: 0.5, eventRiskWithinHorizon: false, openOrder: null, marketSession: "regular", calibrationAdjustment: 1,
};

describe("fastVerify", () => {
  it("is advisory: disagreement can only lower conviction, never change the action", async () => {
    const client = new FakeStructuredClient({ outputs: { fast_verify: { agree: false, concern: "data is aging", confidence: 0.8 } } });
    const verification = await fastVerify({ decision, context, reasonFlagged: "aging data" }, client);
    const applied = applyFastVerification(decision, verification);
    expect(applied.decision.action).toBe("BUY");
    expect(applied.decision.probabilities).toEqual(decision.probabilities);
    expect(applied.decision.conviction).toBeCloseTo(0.36);
    expect(applied.convictionLowered).toBe(true);
    expect(applied.decision.bypassedRisk).toBe(false);
    expect(client.requests[0]!.user).not.toContain("user-a");
  });

  it("leaves the decision untouched when the verifier agrees or is unavailable", async () => {
    const agree = new FakeStructuredClient({ outputs: { fast_verify: { agree: true, concern: null, confidence: 0.9 } } });
    expect(applyFastVerification(decision, await fastVerify({ decision, context, reasonFlagged: "x" }, agree)).decision).toEqual(decision);
    const off = applyFastVerification(decision, await fastVerify({ decision, context, reasonFlagged: "x" }, new NotConfiguredClient()));
    expect(off.decision).toEqual(decision);
    expect(off.note).toContain("not_configured");
    expect(applyFastVerification(decision, null).decision).toBe(decision);
  });
});
