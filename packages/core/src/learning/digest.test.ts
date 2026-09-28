import { describe, expect, it } from "vitest";
import { buildLearningDigest, detectRepeatedMistakes, type LearningDigestInput } from "./digest.js";
import { generateLesson } from "./lessons.js";
import { updateCalibration } from "./calibration.js";
import { reviewRejectedTrade } from "./missed.js";
import { buildAgentProfile, buildModelProfile, buildSignalProfile, buildStrategyProfile } from "./profiles.js";
import { isoDaysAgo, makeMemory, makeRejected, makeReview, makeSeries, NOW } from "./testFixtures.js";

const good = buildStrategyProfile({ strategyId: "s", strategyKey: "momo", scope: null, mode: "all", entries: makeSeries({ n: 60, meanPct: 1, sdPct: 1, strategyKey: "momo" }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
const bad = buildStrategyProfile({ strategyId: "w", strategyKey: "weak", scope: null, mode: "all", entries: makeSeries({ n: 80, meanPct: 1, sdPct: 1.2, strategyKey: "weak", returnShift: (i, n) => (i >= n - 30 ? -3 : 0) }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW, options: { pauseDrawdownPct: 60 } });
const sig = buildSignalProfile("momentum_12_1", Array.from({ length: 40 }, (_, i) => ({ value: (i % 5) / 5 - 0.4, realizedReturnPct: ((i % 5) / 5 - 0.4) * 2, regime: "bull_trend", asOf: isoDaysAgo(40 - i) })), {}, NOW);

function reviewsWithMistakes() {
  const reviews = [
    ...Array.from({ length: 3 }, (_, i) => makeReview({ tradeId: `bt${i}`, classification: "bad_thesis", thesisCorrect: false, returnPct: -2 })),
    makeReview({ tradeId: "gw", classification: "good_win" }),
    makeReview({ tradeId: "bw", classification: "bad_win" }),
  ];
  const lessons = reviews.map((r) => generateLesson(r, makeMemory({ tradeId: r.tradeId }), "bull_trend", { breadth: 0.3 }, isoDaysAgo(1), { id: `l-${r.tradeId}` }));
  return { reviews, lessons };
}

describe("detectRepeatedMistakes", () => {
  it("groups bad-process reviews by classification and setup tags occurring >= 3 times", () => {
    const { reviews, lessons } = reviewsWithMistakes();
    const repeated = detectRepeatedMistakes(reviews, lessons);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ classification: "bad_thesis", strategyKey: "xs_momentum", regime: "bull_trend", count: 3 });
    expect(repeated[0]?.tags.breadth).toBe("weak");
    expect(repeated[0]?.description).toMatch(/bad thesis repeated 3 times for xs_momentum/);
    expect(detectRepeatedMistakes(reviews, lessons, 4)).toEqual([]);
    expect(detectRepeatedMistakes(reviews, [])[0]?.tags).toEqual({ regime: "bull_trend" });
  });
});

describe("buildLearningDigest", () => {
  function input(over: Partial<LearningDigestInput> = {}): LearningDigestInput {
    const { reviews, lessons } = reviewsWithMistakes();
    return {
      period: "weekly",
      since: isoDaysAgo(7),
      now: NOW,
      reviews,
      lessons,
      strategyProfiles: [{ before: { ...good, recent: { ...good.recent, expectancyPct: 0.2 } }, after: good }, { before: null, after: bad }],
      signalProfiles: [{ before: null, after: { ...sig, recentPredictiveValue: 0.9, historicalPredictiveValue: 0.5 } }, { before: null, after: { ...sig, signalKey: "vwap", recentPredictiveValue: 0.1, historicalPredictiveValue: 0.5 } }],
      calibrations: [updateCalibration(null, Array.from({ length: 60 }, (_, i) => ({ predicted: 0.9, success: i < 30 })), NOW, "momo")],
      modelProfiles: [buildModelProfile("claude", "v1", [{ predicted: 0.8, correct: true, latencyMs: 900, costUsd: 0.02, regime: "r", symbol: "A", strategy: "momo" }], {}, NOW)],
      agentProfiles: [buildAgentProfile("devils_advocate", [], NOW)],
      missedReviews: [reviewRejectedTrade(makeRejected(), { "5d": 110 }, 5), reviewRejectedTrade(makeRejected({ id: "k", reasons: ["kill_switch"] }), { "5d": 110 }, 5)],
      regimeInsights: ["momo fits bull_trend best"],
      executionStats: [{ key: "limit_at_mid:low", avgSlippageBps: 30, expectedSlippageBps: 10, fillRate: 0.7, samples: 50 }],
      ...over,
    };
  }

  it("writes plain-English sections", () => {
    const d = buildLearningDigest(input());
    expect(d.period).toBe("weekly");
    expect(d.tradesReviewed).toBe(5);
    expect(d.whatWeLearned[0]).toBe("5 trades were reviewed: 2 winners and 3 non-winners; 1 (20%) were good decisions regardless of outcome.");
    expect(d.whatWeLearned.join(" ")).toContain("bad thesis (3)");
    expect(d.whatWeLearned.join(" ")).toContain("1 strategy is improving");
    expect(d.whatWeLearned.join(" ")).toContain("1 strategy is deteriorating");
    expect(d.whatWeLearned.join(" ")).toContain("1 repeated mistake pattern");
    expect(d.whatWeLearned.join(" ")).toContain("research input and does not change any threshold");
    expect(d.whatWeLearned.join(" ")).toContain("Confidence is overstated for momo");
    expect(d.whatWeLearned[d.whatWeLearned.length - 1]).toContain("Nothing in this digest changes live logic");
    expect(d.strategiesImproving).toHaveLength(1);
    expect(d.strategiesImproving[0]).toMatch(/^momo: recent expectancy \+[\d.]+% \(was \+0\.20%\)/);
    expect(d.strategiesDeteriorating[0]).toMatch(/^weak: .*move to shadow/);
    expect(d.signalsImproving[0]).toMatch(/^momentum_12_1: recent IC 0\.900 vs historical 0\.500/);
    expect(d.signalsDeteriorating[0]).toMatch(/^vwap/);
    expect(d.calibrationSummary).toContain("momo: overconfident");
    expect(d.modelSummary).toContain("claude@v1: accuracy 100%");
    expect(d.agentSummary).toContain("devils_advocate: influenced 0 decisions, value added not measurable yet");
    expect(d.recentLessons).toHaveLength(5);
    expect(d.recentLessons[0]).toMatch(/^xs_momentum \/ bull_trend: /);
    expect(d.repeatedMistakes[0]).toContain("bad thesis repeated 3 times");
    expect(d.missedOpportunities[0]).toContain("MSFT: rejected for insufficient_confidence, returned +10.00% over 5d. Research evidence only.");
    expect(d.missedOpportunities[1]).toContain("1 rejections were policy controls");
    expect(d.regimeInsights).toEqual(["momo fits bull_trend best"]);
    expect(d.executionInsights[0]).toContain("slippage well above model");
  });

  it("handles an empty period", () => {
    const d = buildLearningDigest(input({ reviews: [], lessons: [], strategyProfiles: [], signalProfiles: [], calibrations: [], modelProfiles: [], agentProfiles: [], missedReviews: [], regimeInsights: [], executionStats: [] }));
    expect(d.whatWeLearned[0]).toBe("No trades closed in this weekly period.");
    expect(d.calibrationSummary).toBe("No calibration data for this period.");
    expect(d.modelSummary).toBe("No model evaluations this period.");
    expect(d.agentSummary).toBe("No agent evaluations this period.");
    expect(d.recentLessons).toEqual([]);
    expect(d.repeatedMistakes).toEqual([]);
  });

  it("only lists lessons created since the period start", () => {
    const { reviews, lessons } = reviewsWithMistakes();
    const old = lessons.map((l) => ({ ...l, createdAt: isoDaysAgo(30) }));
    expect(buildLearningDigest(input({ reviews, lessons: old })).recentLessons).toEqual([]);
  });
});
