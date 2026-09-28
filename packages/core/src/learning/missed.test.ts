import { describe, expect, it } from "vitest";
import { reviewRejectedTrade, summarizeRejectionCalibration } from "./missed.js";
import { makeRejected } from "./testFixtures.js";

describe("reviewRejectedTrade", () => {
  it("flags a missed opportunity only for confidence/edge rejections with a large forward return", () => {
    const r = reviewRejectedTrade(makeRejected(), { "1d": 101, "5d": 106, "20d": 110 }, { expectedHoldingDays: 5, expectedDownsidePct: 2 });
    expect(r.kind).toBe("missed_opportunity_review");
    expect(r.horizon).toBe("5d");
    expect(r.forwardReturnPct).toBeCloseTo(6);
    expect(r.verdict).toBe("missed_opportunity");
    expect(r.policyRejection).toBe(false);
    expect(r.rejected.reviewVerdict).toBe("missed_opportunity");
    expect(r.rejected.subsequentReturnPct).toEqual({ "1d": 1, "5d": 6, "20d": 10 });
    expect(r.note).toContain("not a settings change");
  });

  it("does not mutate the input rejection", () => {
    const rej = makeRejected();
    reviewRejectedTrade(rej, { "5d": 106 }, 5);
    expect(rej.reviewVerdict).toBeNull();
    expect(rej.subsequentReturnPct).toBeNull();
  });

  it("is undetermined when the forward return is positive but within noise, correct when negative", () => {
    expect(reviewRejectedTrade(makeRejected(), { "5d": 102 }, 5).verdict).toBe("undetermined");
    expect(reviewRejectedTrade(makeRejected(), { "5d": 97 }, 5).verdict).toBe("correct_rejection");
  });

  it("treats policy rejections as correct even when the price rose, recording the evidence", () => {
    for (const reason of ["stale_data", "kill_switch", "risk_limit_exceeded", "autonomy_level"] as const) {
      const r = reviewRejectedTrade(makeRejected({ reasons: [reason, "insufficient_confidence"] }), { "20d": 125 }, 10);
      expect(r.verdict).toBe("correct_rejection");
      expect(r.policyRejection).toBe(true);
      expect(r.forwardReturnPct).toBeCloseTo(25);
      expect(r.note).toContain("never loosened");
    }
  });

  it("does not draw a missed-opportunity verdict for non-judgement reasons", () => {
    const r = reviewRejectedTrade(makeRejected({ reasons: ["poor_liquidity"] }), { "1d": 108 }, 1);
    expect(r.verdict).toBe("undetermined");
    expect(reviewRejectedTrade(makeRejected({ reasons: ["event_risk"] }), { "1d": 95 }, 1).verdict).toBe("correct_rejection");
  });

  it("is undetermined without prices", () => {
    expect(reviewRejectedTrade(makeRejected(), {}, 5).verdict).toBe("undetermined");
    expect(reviewRejectedTrade(makeRejected({ priceAtRejection: null }), { "5d": 110 }, 5).verdict).toBe("undetermined");
    expect(reviewRejectedTrade(makeRejected(), { "1d": 110 }, 5).horizon).toBeNull();
  });
});

describe("summarizeRejectionCalibration", () => {
  it("aggregates by reason and produces text recommendations only", () => {
    const reviews = [
      ...Array.from({ length: 12 }, (_, i) => reviewRejectedTrade(makeRejected({ id: `c${i}` }), { "5d": i < 9 ? 108 : 95 }, 5)),
      ...Array.from({ length: 3 }, (_, i) => reviewRejectedTrade(makeRejected({ id: `k${i}`, reasons: ["kill_switch"] }), { "5d": 110 }, 5)),
      reviewRejectedTrade(makeRejected({ id: "e", reasons: ["insufficient_expected_edge"] }), { "5d": 99 }, 5),
    ];
    const s = summarizeRejectionCalibration(reviews);
    expect(s.kind).toBe("research_evidence");
    expect(s.byReason.insufficient_confidence).toMatchObject({ count: 12, evaluated: 12, wouldHaveWon: 9, missedOpportunities: 9, policy: false });
    expect(s.byReason.insufficient_confidence?.hitRate).toBeCloseTo(0.75);
    expect(s.byReason.kill_switch?.policy).toBe(true);
    expect(s.recommendations).toHaveLength(3);
    expect(s.recommendations.find((r) => r.startsWith("insufficient_confidence"))).toContain("validation pipeline");
    expect(s.recommendations.find((r) => r.startsWith("kill_switch"))).toContain("correct by construction");
    expect(s.recommendations.find((r) => r.startsWith("insufficient_expected_edge"))).toContain("Too few");
    // No numeric settings anywhere in the summary object besides statistics.
    expect(Object.keys(s)).toEqual(["kind", "byReason", "recommendations"]);
  });
});
