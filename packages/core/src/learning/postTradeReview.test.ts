import { describe, expect, it } from "vitest";
import { CrossTenantError } from "../types/index.js";
import { reviewTrade, REVIEW_RULES, type ReviewInput } from "./postTradeReview.js";
import { makeMemory, makeOutcome, makeThesis, makeTrade, NOW, SCOPE_B } from "./testFixtures.js";

function input(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    trade: makeTrade(),
    memory: makeMemory(),
    thesis: makeThesis(),
    executionOutcomes: [makeOutcome()],
    regimeAtExit: "bull_trend",
    eventsDuringTrade: [],
    signalContributions: { momentum_12_1: 0.4, vwap_zscore: -0.1 },
    benchmarkReturnPct: 1,
    ...over,
  };
}

describe("reviewTrade classification rules", () => {
  it("good_win: thesis played out within planned downside", () => {
    const r = reviewTrade(input(), NOW);
    expect(r.classification).toBe("good_win");
    expect(r.thesisCorrect).toBe(true);
    expect(r.sizingCorrect).toBe(true);
    expect(r.executionEfficient).toBe(true);
    expect(r.wouldTakeAgain).toBe(true);
    expect(r.signalsHelped).toEqual(["momentum_12_1"]);
    expect(r.signalsHurt).toEqual(["vwap_zscore"]);
    expect(r.scope).toEqual(makeTrade().scope);
    expect(r.narrative).toContain("+4.00%");
    expect(r.narrative).toContain("good win");
    expect(r.reviewerVersion).toBe("review-1.0.0");
  });

  it("bad_win: positive return although the thesis was invalidated and the exit came late", () => {
    const r = reviewTrade(input({
      trade: makeTrade({ exitReason: "invalidation", maxAdverseExcursionPct: -5.5 }),
      memory: makeMemory({ exitReason: "invalidation", actualReturnPct: 1, exitPrice: 101, maePct: -5.5, mfePct: 6 }),
    }), NOW);
    expect(r.classification).toBe("bad_win");
    expect(r.thesisCorrect).toBe(false);
    expect(r.narrative).toContain("gave back");
  });

  it("good_loss: loss but invalidation respected and size right", () => {
    const r = reviewTrade(input({
      trade: makeTrade({ exitReason: "stop_loss", averageExitPrice: 97, maxAdverseExcursionPct: -3.2 }),
      memory: makeMemory({ exitReason: "stop_loss", actualReturnPct: -3, exitPrice: 97, maePct: -3.2, mfePct: 0.5 }),
    }), NOW);
    expect(r.classification).toBe("good_loss");
    expect(r.thesisCorrect).toBe(false);
    expect(r.sizingCorrect).toBe(true);
    expect(r.wouldTakeAgain).toBe(true);
  });

  it("oversized: invalidation respected but MAE far beyond the expected downside", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "stop_loss", actualReturnPct: -7, exitPrice: 93, maePct: -7.5, mfePct: 0.2 }),
    }), NOW);
    expect(r.classification).toBe("oversized");
    expect(r.sizingCorrect).toBe(false);
    expect(r.wouldTakeAgain).toBe(false);
  });

  it("bad_thesis: held through a loss far beyond expected downside without invalidation", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "time_stop", actualReturnPct: -7, exitPrice: 93, maePct: -8, mfePct: 0.2 }),
    }), NOW);
    expect(r.classification).toBe("bad_thesis");
  });

  it("bad_thesis: ordinary loss without the invalidation being hit", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "time_stop", actualReturnPct: -2, exitPrice: 98, maePct: -2.5, mfePct: 0.3 }),
    }), NOW);
    expect(r.classification).toBe("bad_thesis");
    expect(r.strategyBehavedAsIntended).toBe(true);
  });

  it("bad_timing: holding far shorter than expected with a reversal", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "stop_loss", holdingDays: 1, actualReturnPct: -2, exitPrice: 98, maePct: -2.5, mfePct: 4 }),
    }), NOW);
    expect(r.classification).toBe("bad_timing");
    expect(r.timingCorrect).toBe(false);
  });

  it("bad_execution: slippage larger than the loss itself", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "time_stop", actualReturnPct: -0.3, exitPrice: 99.7, maePct: -1, mfePct: 0.5 }),
      executionOutcomes: [makeOutcome({ actualSlippageBps: 200, expectedSlippageBps: 5 })],
    }), NOW);
    expect(r.classification).toBe("bad_execution");
    expect(r.executionEfficient).toBe(false);
    expect(r.slippageBps).toBe(200);
  });

  it("flags inefficient execution when slippage exceeds the drag fraction of expected edge", () => {
    const edgeBps = makeThesis().expectedUpsidePct * 100;
    const r = reviewTrade(input({ executionOutcomes: [makeOutcome({ actualSlippageBps: REVIEW_RULES.executionDragFraction * edgeBps + 1, expectedSlippageBps: 5 })] }), NOW);
    expect(r.executionEfficient).toBe(false);
  });

  it("regime_change: loss while the regime label changed", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "time_stop", actualReturnPct: -2, exitPrice: 98, maePct: -2.5, mfePct: 0.3 }),
      regimeAtExit: "risk_off",
    }), NOW);
    expect(r.classification).toBe("regime_change");
    expect(r.regimeAtExit).toBe("risk_off");
    expect(r.wouldTakeAgain).toBe(false);
  });

  it("unexpected_event: events during the trade blew through the downside", () => {
    const r = reviewTrade(input({
      memory: makeMemory({ exitReason: "stop_loss", actualReturnPct: -6, exitPrice: 94, maePct: -6, mfePct: 0.2 }),
      eventsDuringTrade: ["earnings pre-announcement"],
    }), NOW);
    expect(r.classification).toBe("unexpected_event");
    expect(r.narrative).toContain("earnings pre-announcement");
  });

  it("data_error / model_error come from explicit flags and unknown returns", () => {
    expect(reviewTrade(input({ flags: { dataError: true } }), NOW).classification).toBe("data_error");
    expect(reviewTrade(input({ flags: { modelError: true } }), NOW).classification).toBe("model_error");
    const noReturn = reviewTrade(input({
      trade: makeTrade({ averageEntryPrice: null, averageExitPrice: null }),
      memory: makeMemory({ actualReturnPct: null, exitPrice: null, entryPrice: 0 }),
    }), NOW);
    expect(noReturn.classification).toBe("data_error");
    expect(noReturn.returnPct).toBe(0);
    expect(noReturn.signalsHelped).toEqual([]);
    expect(noReturn.wouldTakeAgain).toBeNull();
  });

  it("marks confidence as miscalibrated when a high-confidence thesis fails", () => {
    const r = reviewTrade(input({
      thesis: makeThesis({ confidence: 0.9 }),
      memory: makeMemory({ exitReason: "stop_loss", actualReturnPct: -3, exitPrice: 97, maePct: -3, mfePct: 0.1 }),
    }), NOW);
    expect(r.confidenceCalibrated).toBe(false);
    expect(r.initialConfidence).toBe(0.9);
  });

  it("marks strategy as not behaving as intended for manual / kill-switch exits", () => {
    const r = reviewTrade(input({ memory: makeMemory({ exitReason: "kill_switch" }) }), NOW);
    expect(r.strategyBehavedAsIntended).toBe(false);
  });

  it("refuses cross-tenant inputs", () => {
    expect(() => reviewTrade(input({ memory: makeMemory({ scope: SCOPE_B }) }), NOW)).toThrow(CrossTenantError);
    expect(() => reviewTrade(input({ executionOutcomes: [makeOutcome({ scope: SCOPE_B })] }), NOW)).toThrow(CrossTenantError);
    expect(() => reviewTrade(input({ memory: makeMemory({ tradeId: "other" }) }), NOW)).toThrow(/does not belong/);
  });
});
