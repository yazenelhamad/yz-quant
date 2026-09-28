/**
 * Tenant isolation proofs for the learning engine:
 *  - learning from user A never changes user B's state,
 *  - shared profiles carry no scope-specific mutation instructions,
 *  - missed-opportunity review never yields a settings change.
 */
import { describe, expect, it } from "vitest";
import { CrossTenantError } from "../types/index.js";
import { applyProposals, proposeAdaptations, type ProposeAdaptationsInput } from "./adaptation.js";
import { generateLesson, mergeLessons, retrieveLessons } from "./lessons.js";
import { findAnalogs, vectorize } from "./memory.js";
import { reviewRejectedTrade, summarizeRejectionCalibration } from "./missed.js";
import { reviewTrade } from "./postTradeReview.js";
import { buildStrategyProfile } from "./profiles.js";
import { makeMemory, makeOutcome, makeRejected, makeSeries, makeThesis, makeTrade, NOW, SCOPE_A, SCOPE_B } from "./testFixtures.js";

const entriesA = makeSeries({ n: 60, meanPct: 1.2, sdPct: 1, scope: SCOPE_A, confidence: 0.65 });
const entriesB = makeSeries({ n: 60, meanPct: -1, sdPct: 1, scope: SCOPE_B, mode: "shadow", seed: 9 });

function adaptationInput(scope: typeof SCOPE_A | null, profiles: ProposeAdaptationsInput["strategyProfiles"]): ProposeAdaptationsInput {
  return {
    scope,
    strategyProfiles: profiles,
    signalProfiles: [],
    calibrations: [],
    executionStats: [],
    currentValues: { "strategy_allocation:xs_momentum": 0.2 },
    bounds: { strategy_allocation: { min: 0, max: 0.5, maxStepPerDay: 0.05 } },
    tier: {},
    now: NOW,
  };
}

describe("tenant isolation of the learning engine", () => {
  it("proposals for scope A carry scope A and cannot be applied in scope B", () => {
    const profileA = buildStrategyProfile({ strategyId: "s", strategyKey: "xs_momentum", scope: SCOPE_A, mode: "all", entries: entriesA, executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
    const proposals = proposeAdaptations(adaptationInput(SCOPE_A, [profileA]));
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) expect(p.scope).toEqual(SCOPE_A);

    const stateB = { "strategy_allocation:xs_momentum": 0.2 };
    expect(() => applyProposals(stateB, proposals, SCOPE_B)).toThrow(CrossTenantError);
    expect(stateB["strategy_allocation:xs_momentum"]).toBe(0.2);

    const stateA = { "strategy_allocation:xs_momentum": 0.2 };
    const applied = applyProposals(stateA, proposals, SCOPE_A, NOW);
    expect(applied.values["strategy_allocation:xs_momentum"]).not.toBe(0.2);
    expect(stateA["strategy_allocation:xs_momentum"]).toBe(0.2); // pure
  });

  it("user B's profile can never feed proposals for user A", () => {
    const profileB = buildStrategyProfile({ strategyId: "s", strategyKey: "xs_momentum", scope: SCOPE_B, mode: "all", entries: entriesB, executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
    expect(() => proposeAdaptations(adaptationInput(SCOPE_A, [profileB]))).toThrow(CrossTenantError);
    // and a scoped profile cannot be built from the other user's entries at all
    expect(() => buildStrategyProfile({ strategyId: "s", strategyKey: "xs_momentum", scope: SCOPE_A, mode: "all", entries: entriesB, executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW })).toThrow(CrossTenantError);
  });

  it("shared profiles built from both users contain no scope-specific mutation instructions", () => {
    const shared = buildStrategyProfile({ strategyId: "s", strategyKey: "xs_momentum", scope: null, mode: "all", entries: [...entriesA, ...entriesB], executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
    expect(shared.scope).toBeNull();
    expect(shared.overall.trades).toBe(120);
    const json = JSON.stringify(shared);
    for (const s of [SCOPE_A, SCOPE_B]) {
      expect(json).not.toContain(s.userId);
      expect(json).not.toContain(s.brokerAccountId);
    }
    // The shared assessment is a recommendation with a bounded delta, never a per-user setting.
    expect(Math.abs(shared.assessment.recommendedAllocationDelta)).toBeLessThanOrEqual(0.05);
    // Shared proposals derived from it are scope-null and refuse to be applied inside a user scope.
    const proposals = proposeAdaptations(adaptationInput(null, [shared]));
    for (const p of proposals) expect(p.scope).toBeNull();
    if (proposals.length > 0) expect(() => applyProposals({ "strategy_allocation:xs_momentum": 0.2 }, proposals, SCOPE_A)).toThrow();
  });

  it("reviews and lessons stay in their own scope; retrieval and analogs read across users without mutating", () => {
    const tradeA = makeTrade({ scope: SCOPE_A });
    const review = reviewTrade({ trade: tradeA, memory: makeMemory({ scope: SCOPE_A }), thesis: makeThesis(), executionOutcomes: [makeOutcome({ scope: SCOPE_A })], regimeAtExit: "bull_trend", eventsDuringTrade: [], signalContributions: {}, benchmarkReturnPct: null }, NOW);
    expect(review.scope).toEqual(SCOPE_A);
    const lessonA = generateLesson(review, makeMemory({ scope: SCOPE_A }), "bull_trend", {}, NOW);
    expect(lessonA.scope).toEqual(SCOPE_A);
    const lessonB = { ...lessonA, id: "lb", scope: SCOPE_B };
    const merged = mergeLessons([lessonB], [lessonA]);
    expect(merged).toHaveLength(2); // A's lesson never increments B's counters
    expect(merged[0]?.timesConfirmed).toBe(0);
    expect(retrieveLessons(merged, { strategyKey: "xs_momentum" }).length).toBe(2);

    const memory = [...entriesA, ...entriesB].map((e) => ({ ...e, vector: vectorize(e.features) }));
    const snapshot = JSON.stringify(memory);
    const analogs = findAnalogs({ vector: vectorize(entriesA[0]!.features), strategyKey: "xs_momentum", regime: "bull_trend", symbol: "AAPL", sector: "tech" }, memory, 20);
    expect(analogs.some((a) => a.mode === "shadow")).toBe(true);
    expect(JSON.stringify(memory)).toBe(snapshot);
  });

  it("missed-opportunity review never yields a settings change", () => {
    const rejected = makeRejected({ scope: SCOPE_A });
    const reviews = Array.from({ length: 15 }, (_, i) => reviewRejectedTrade({ ...rejected, id: `r${i}` }, { "5d": 112 }, 5));
    expect(reviews.every((r) => r.verdict === "missed_opportunity")).toBe(true);
    const summary = summarizeRejectionCalibration(reviews);
    expect(summary.kind).toBe("research_evidence");
    expect(summary.recommendations.every((r) => typeof r === "string")).toBe(true);
    // Nothing in the review or the summary looks like a proposal or a setting.
    const json = JSON.stringify({ reviews, summary });
    for (const forbidden of ["proposedValue", "autoApplicable", "minConfidence", "minExpectedEdge", "maxPositionPct", "capitalAllocation"]) expect(json).not.toContain(forbidden);
    // Policy rejections remain correct no matter what the price did.
    const policy = reviewRejectedTrade(makeRejected({ reasons: ["risk_limit_exceeded"] }), { "5d": 150 }, 5);
    expect(policy.verdict).toBe("correct_rejection");
  });
});
