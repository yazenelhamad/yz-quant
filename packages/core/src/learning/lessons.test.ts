import { describe, expect, it } from "vitest";
import { CONFIDENCE_IMPACT_BOUNDS, generateLesson, lessonSignature, mergeLessons, retrieveLessons } from "./lessons.js";
import { makeMemory, makeReview, NOW, SCOPE_B } from "./testFixtures.js";

const features = { breadth: 0.3, realized_vol_20: 0.35, momentum_20: 0.04 };

describe("generateLesson", () => {
  it("produces setup/expected/actual/lesson/action, tags and a bounded confidence impact", () => {
    const l = generateLesson(makeReview(), makeMemory(), "bull_trend", features, NOW);
    expect(l.scope).toEqual(makeReview().scope);
    expect(l.tradeId).toBe("trade-1");
    expect(l.tags).toMatchObject({ setup: "xs_momentum", regime: "bull_trend", breadth: "weak", vol: "high", momentum: "positive", classification: "good_win", polarity: "positive", confidence: "0.7-0.8", holding: "medium" });
    expect(l.setup).toContain("xs_momentum");
    expect(l.expected).toContain("70%");
    expect(l.actual).toContain("+4.00%");
    expect(l.lesson.length).toBeGreaterThan(10);
    expect(l.action.length).toBeGreaterThan(10);
    expect(l.confidenceImpact).toBeGreaterThanOrEqual(CONFIDENCE_IMPACT_BOUNDS.min);
    expect(l.confidenceImpact).toBeLessThanOrEqual(CONFIDENCE_IMPACT_BOUNDS.max);
    expect(l.timesConfirmed).toBe(0);
  });

  it("bounds the impact even for the worst cases and lowers it for bad theses", () => {
    const bad = generateLesson(makeReview({ classification: "bad_thesis", thesisCorrect: false, initialConfidence: 0.95, returnPct: -4 }), makeMemory(), "bull_trend", {}, NOW);
    expect(bad.confidenceImpact).toBeGreaterThanOrEqual(0.85);
    expect(bad.confidenceImpact).toBeLessThan(1);
    expect(bad.tags.polarity).toBe("negative");
    const good = generateLesson(makeReview({ classification: "good_win", thesisCorrect: true, initialConfidence: 0.2 }), makeMemory(), "bull_trend", {}, NOW);
    expect(good.confidenceImpact).toBeLessThanOrEqual(1.15);
    expect(good.confidenceImpact).toBeGreaterThan(1);
  });

  it("can be forced to be shared (scope null)", () => {
    expect(generateLesson(makeReview(), makeMemory(), "bull_trend", {}, NOW, { shared: true }).scope).toBeNull();
  });
});

describe("mergeLessons", () => {
  const base = generateLesson(makeReview(), makeMemory(), "bull_trend", features, NOW);

  it("confirms an existing lesson with the same signature and polarity instead of duplicating", () => {
    const again = generateLesson(makeReview({ tradeId: "trade-2" }), makeMemory({ tradeId: "trade-2" }), "bull_trend", features, NOW, { id: "l2" });
    const merged = mergeLessons([base], [again]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.timesConfirmed).toBe(1);
    expect(merged[0]?.timesContradicted).toBe(0);
    expect(base.timesConfirmed).toBe(0); // input untouched
  });

  it("contradicts when the polarity differs and appends when the signature differs", () => {
    const contra = generateLesson(makeReview({ tradeId: "t3", classification: "bad_thesis", thesisCorrect: false, returnPct: -3 }), makeMemory({ tradeId: "t3" }), "bull_trend", features, NOW, { id: "l3" });
    expect(lessonSignature(contra)).toBe(lessonSignature(base));
    const other = generateLesson(makeReview({ tradeId: "t4" }), makeMemory({ tradeId: "t4" }), "risk_off", features, NOW, { id: "l4" });
    const merged = mergeLessons([base], [contra, other]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.timesContradicted).toBe(1);
    expect(merged[1]?.id).toBe("l4");
  });

  it("keeps lessons from different scopes separate", () => {
    const otherUser = { ...base, id: "lb", scope: SCOPE_B };
    expect(mergeLessons([base], [otherUser])).toHaveLength(2);
  });
});

describe("retrieveLessons", () => {
  const l1 = generateLesson(makeReview(), makeMemory(), "bull_trend", features, NOW, { id: "l1" });
  const l2 = { ...generateLesson(makeReview({ tradeId: "t2" }), makeMemory({ tradeId: "t2", strategyKey: "mean_rev" }), "bull_trend", features, NOW, { id: "l2" }), timesConfirmed: 5 };
  const l3 = { ...l1, id: "l3", timesConfirmed: 0, timesContradicted: 6 };

  it("ranks by tag overlap, strategy/regime match and confirmation ratio", () => {
    const ranked = retrieveLessons([l1, l2, l3], { strategyKey: "xs_momentum", regime: "bull_trend", tags: { breadth: "weak", vol: "high" } });
    expect(ranked.map((r) => r.lesson.id)).toEqual(["l1", "l2", "l3"]);
    expect(ranked[0]?.matchedTags).toEqual(["breadth", "vol"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("drops irrelevant lessons and honours the limit", () => {
    expect(retrieveLessons([l1, l2], { strategyKey: "other", tags: { breadth: "strong" } })).toHaveLength(0);
    expect(retrieveLessons([l1, l2, l3], { regime: "bull_trend" }, 2)).toHaveLength(2);
  });
});
