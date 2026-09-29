import { describe, expect, it } from "vitest";
import type { ModelIntelligenceProfile } from "@yz/core";
import { Budget } from "./budget.js";
import { routeTask, type TaskKind } from "./modelRouter.js";

function profile(modelName: string, patch: Partial<ModelIntelligenceProfile>): ModelIntelligenceProfile {
  return {
    modelName,
    modelVersion: "v",
    accuracy: null,
    calibration: { key: modelName, buckets: [], brierScore: null, expectedCalibrationError: null, overconfidenceRatio: null, sampleSize: 0, updatedAt: "t" },
    byRegime: {},
    byAsset: {},
    byStrategy: {},
    latencyMsP50: null,
    failureRate: null,
    costUsd: 0,
    valueAdded: null,
    agreementWithOthers: {},
    routingWeight: 1,
    updatedAt: "t",
    ...patch,
  };
}

describe("routeTask", () => {
  it("never routes risk or accounting to a model, whatever the inputs", () => {
    for (const kind of ["risk", "accounting"] as TaskKind[]) {
      for (const urgency of ["low", "normal", "high", "critical"] as const) {
        const d = routeTask({ kind, urgency, budgetUsd: 1000 });
        expect(d.handler).toBe("deterministic");
        expect(d.role).toBeUndefined();
      }
    }
  });

  it("routes fast decisions deterministically, with llm verification only when flagged and advisory", () => {
    expect(routeTask({ kind: "fast_decision", urgency: "critical" })).toMatchObject({ handler: "deterministic" });
    const flagged = routeTask({ kind: "fast_decision", urgency: "high", flagged: true });
    expect(flagged).toMatchObject({ handler: "llm", role: "fast", advisoryOnly: true });
    expect(flagged.reason).toContain("deterministic fast brain decides");
  });

  // Distinct models per role, so the fallback between roles is observable.
  const M = { models: { slow_brain: "claude-fable-5-1", research: "claude-opus-5-5", fast: "claude-haiku-4-5-20251001" } };

  it("routes numeric to statistical, pattern to ml, and reasoning tasks to llm roles", () => {
    expect(routeTask({ kind: "numeric_forecast", urgency: "normal" }, M).handler).toBe("statistical");
    expect(routeTask({ kind: "pattern_detection", urgency: "normal" }, M).handler).toBe("ml");
    expect(routeTask({ kind: "thesis", urgency: "normal" }, M)).toMatchObject({ handler: "llm", role: "slow_brain", model: "claude-fable-5-1" });
    expect(routeTask({ kind: "unusual_situation", urgency: "high" }, M)).toMatchObject({ handler: "llm", role: "slow_brain" });
    expect(routeTask({ kind: "research", urgency: "low" }, M)).toMatchObject({ handler: "llm", role: "research", model: "claude-opus-5-5" });
    expect(routeTask({ kind: "news_interpretation", urgency: "normal" }, M)).toMatchObject({ handler: "llm", role: "research" });
    expect(routeTask({ kind: "post_trade_review", urgency: "low" }, M)).toMatchObject({ handler: "llm", role: "research" });
  });

  it("avoids models with negative value-add or high failure rate, with a reason", () => {
    const profiles = [profile("claude-fable-5-1", { valueAdded: -0.1 })];
    const d = routeTask({ kind: "thesis", urgency: "normal", modelProfiles: profiles }, M);
    expect(d).toMatchObject({ handler: "llm", role: "research", model: "claude-opus-5-5" });
    expect(d.reason).toContain("valueAdded -0.100 < 0");

    const both = [profile("claude-fable-5-1", { valueAdded: -0.1 }), profile("claude-opus-5-5", { failureRate: 0.6 })];
    const degraded = routeTask({ kind: "thesis", urgency: "normal", modelProfiles: both }, M);
    expect(degraded).toMatchObject({ handler: "llm", role: "slow_brain", degraded: true });
    expect(degraded.reason).toContain("failureRate 0.60");

    const flaggedFast = routeTask({ kind: "fast_decision", urgency: "high", flagged: true, modelProfiles: [profile("claude-haiku-4-5-20251001", { failureRate: 0.9 })] }, M);
    expect(flaggedFast).toMatchObject({ handler: "llm", role: "research", advisoryOnly: true });
  });

  it("enforces the daily budget and per-task budget", () => {
    let now = new Date("2026-09-28T10:00:00Z");
    const budget = new Budget({ dailyLimitUsd: 1, now: () => now });
    expect(routeTask({ kind: "thesis", urgency: "normal" }, { budget }).handler).toBe("llm");
    budget.record(0.9);
    expect(budget.spentTodayUsd()).toBeCloseTo(0.9);
    const blocked = routeTask({ kind: "thesis", urgency: "normal" }, { budget });
    expect(blocked).toMatchObject({ handler: "deterministic", degraded: true });
    expect(blocked.reason).toContain("daily model budget exhausted");
    // next day resets
    now = new Date("2026-09-29T10:00:00Z");
    expect(budget.spentTodayUsd()).toBe(0);
    expect(routeTask({ kind: "thesis", urgency: "normal" }, { budget }).handler).toBe("llm");
    expect(routeTask({ kind: "research", urgency: "low", budgetUsd: 0.01 }).handler).toBe("deterministic");
    // budget never opens the door for risk
    expect(routeTask({ kind: "risk", urgency: "critical", budgetUsd: 100 }, { budget }).handler).toBe("deterministic");
  });
});
