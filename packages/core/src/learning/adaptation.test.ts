import { describe, expect, it } from "vitest";
import { CrossTenantError, ScopeError } from "../types/index.js";
import type { AdaptationProposal } from "../types/index.js";
import { AdaptationBoundsError, applyProposals, clampProposal, proposeAdaptations, type ProposeAdaptationsInput } from "./adaptation.js";
import { updateCalibration } from "./calibration.js";
import { buildSignalProfile, buildStrategyProfile } from "./profiles.js";
import { isoDaysAgo, makeSeries, NOW, rng, SCOPE_A, SCOPE_B } from "./testFixtures.js";

const strong = buildStrategyProfile({ strategyId: "s", strategyKey: "momo", scope: null, mode: "all", entries: makeSeries({ n: 120, meanPct: 1.2, sdPct: 1, strategyKey: "momo", confidence: 0.65 }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
const weak = buildStrategyProfile({ strategyId: "w", strategyKey: "weak", scope: null, mode: "all", entries: makeSeries({ n: 80, meanPct: 1, sdPct: 1.2, strategyKey: "weak", returnShift: (i, n) => (i >= n - 30 ? -3 : 0) }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });

function signalProfile(recentSlope: number) {
  const r = rng(5);
  const obs = Array.from({ length: 100 }, (_, i) => {
    const v = r() * 2 - 1;
    const slope = i >= 50 ? recentSlope : 2;
    return { value: v, realizedReturnPct: slope * v + (r() - 0.5) * 0.3, regime: "bull_trend", asOf: isoDaysAgo(100 - i) };
  });
  return buildSignalProfile("momentum_12_1", obs, {}, NOW, { weightBounds: { min: 0.1, max: 2 } });
}

function baseInput(over: Partial<ProposeAdaptationsInput> = {}): ProposeAdaptationsInput {
  return {
    scope: SCOPE_A,
    strategyProfiles: [strong, weak],
    signalProfiles: [signalProfile(-2)],
    calibrations: [updateCalibration(null, Array.from({ length: 100 }, (_, i) => ({ predicted: 0.9, success: i < 50 })), NOW, "momo")],
    executionStats: [{ key: "limit_at_mid:low", avgSlippageBps: 30, expectedSlippageBps: 10, fillRate: 0.7, samples: 50 }],
    currentValues: { "strategy_allocation:momo": 0.2, "strategy_allocation:weak": 0.2, "signal_weight:momentum_12_1": 1, "confidence_calibration:momo": 1, "execution_preference:limit_at_mid:low": 0.5, "strategy_ranking:weak": 0.5 },
    bounds: { strategy_allocation: { min: 0, max: 0.4, maxStepPerDay: 0.1 }, signal_weight: { min: 0.1, max: 2, maxStepPerDay: 0.1 }, confidence_calibration: { min: 0.6, max: 1.1, maxStepPerDay: 0.2 }, execution_preference: { min: 0, max: 1, maxStepPerDay: 0.02 }, strategy_ranking: { min: 0, max: 1, maxStepPerDay: 0.05 } },
    tier: {},
    now: NOW,
    ...over,
  };
}

describe("proposeAdaptations", () => {
  it("produces bounded, step-clamped proposals carrying the caller's scope", () => {
    const proposals = proposeAdaptations(baseInput());
    expect(proposals.length).toBeGreaterThanOrEqual(5);
    for (const p of proposals) {
      expect(p.scope).toEqual(SCOPE_A);
      expect(p.proposedValue).toBeGreaterThanOrEqual(p.bounds.min);
      expect(p.proposedValue).toBeLessThanOrEqual(p.bounds.max);
      expect(Math.abs(p.proposedValue - p.currentValue)).toBeLessThanOrEqual(p.bounds.maxStepPerDay + 1e-9);
      expect(p.autoApplicable).toBe(true);
      expect(p.requiresValidationPipeline).toBe(false);
      expect(p.appliedAt).toBeNull();
      expect(p.evidence.length).toBeGreaterThan(10);
    }
    const momo = proposals.find((p) => p.target === "strategy_allocation" && p.key === "momo")!;
    expect(momo.proposedValue).toBeGreaterThan(0.2);
    expect(momo.proposedValue - momo.currentValue).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(momo.bounds.maxStepPerDay).toBe(0.05); // allocation step capped even when bounds allow 0.1
    const weakAlloc = proposals.find((p) => p.target === "strategy_allocation" && p.key === "weak")!;
    expect(weakAlloc.proposedValue).toBeCloseTo(0.15);
    const signal = proposals.find((p) => p.target === "signal_weight")!;
    expect(signal.proposedValue).toBeCloseTo(0.9); // desired 0.8 clamped by the 0.1 daily step
    expect(signal.evidence).toContain("clamped");
    const calib = proposals.find((p) => p.target === "confidence_calibration")!;
    expect(calib.proposedValue).toBeCloseTo(0.8); // adjustment 0.6 clamped by step 0.2
    const exec = proposals.find((p) => p.target === "execution_preference")!;
    expect(exec.proposedValue).toBeCloseTo(0.48);
    const ranking = proposals.find((p) => p.target === "strategy_ranking")!;
    expect(ranking.proposedValue).toBeCloseTo(0.45);
  });

  it("marks slow-tier keys as requiring the validation pipeline and never auto-applicable", () => {
    const proposals = proposeAdaptations(baseInput({ tier: { "strategy_allocation:momo": "slow", signal_weight: "slow" } }));
    const momo = proposals.find((p) => p.target === "strategy_allocation" && p.key === "momo")!;
    expect(momo.autoApplicable).toBe(false);
    expect(momo.requiresValidationPipeline).toBe(true);
    expect(momo.evidence).toContain("validation pipeline");
    const signal = proposals.find((p) => p.target === "signal_weight")!;
    expect(signal.autoApplicable).toBe(false);
    expect(signal.requiresValidationPipeline).toBe(true);
    const other = proposals.find((p) => p.target === "strategy_allocation" && p.key === "weak")!;
    expect(other.autoApplicable).toBe(true);
  });

  it("makes no proposal without bounds or without a current value, and none when nothing changes", () => {
    const none = proposeAdaptations(baseInput({ bounds: {} }));
    expect(none).toEqual([]);
    const onlyKnown = proposeAdaptations(baseInput({ currentValues: { "strategy_allocation:momo": 0.2 } }));
    expect(onlyKnown.map((p) => p.key)).toEqual(["momo"]);
    const noChange = proposeAdaptations(baseInput({ currentValues: { "strategy_allocation:momo": 0.4 } }));
    expect(noChange).toEqual([]);
  });

  it("does not let a small recent hot streak drive a large allocation increase", () => {
    const hot = buildStrategyProfile({ strategyId: "h", strategyKey: "hot", scope: null, mode: "all", entries: makeSeries({ n: 25, meanPct: 4, sdPct: 0.5, strategyKey: "hot", confidence: 0.6 }), executionOutcomes: [], correlations: {}, theoreticalEdgePct: null, now: NOW });
    const proposals = proposeAdaptations(baseInput({ strategyProfiles: [hot], signalProfiles: [], calibrations: [], executionStats: [], currentValues: { "strategy_allocation:hot": 0.1 } }));
    const p = proposals.find((x) => x.key === "hot");
    expect(p).toBeDefined();
    expect(p!.proposedValue - p!.currentValue).toBeLessThanOrEqual(0.0125 + 1e-9);
  });

  it("shared (null-scope) proposals ignore user-specific profiles; foreign scoped profiles throw", () => {
    const scopedA = { ...strong, scope: SCOPE_A };
    const shared = proposeAdaptations(baseInput({ scope: null, strategyProfiles: [scopedA], signalProfiles: [], calibrations: [], executionStats: [] }));
    expect(shared.filter((p) => p.target === "strategy_allocation")).toEqual([]);
    expect(() => proposeAdaptations(baseInput({ strategyProfiles: [{ ...strong, scope: SCOPE_B }] }))).toThrow(CrossTenantError);
  });
});

describe("applyProposals", () => {
  const proposals = proposeAdaptations(baseInput());
  const current = baseInput().currentValues;

  it("applies auto-applicable proposals purely and returns the new values", () => {
    const before = JSON.stringify(current);
    const res = applyProposals(current, proposals, SCOPE_A, NOW);
    expect(JSON.stringify(current)).toBe(before);
    expect(res.applied).toHaveLength(proposals.length);
    for (const p of proposals) expect(res.values[`${p.target}:${p.key}`]).toBeCloseTo(p.proposedValue);
    for (const a of res.applied) expect(a.appliedAt).toBe(NOW);
    for (const p of proposals) expect(p.appliedAt).toBeNull();
  });

  it("throws CrossTenantError / ScopeError for proposals from another scope", () => {
    expect(() => applyProposals(current, proposals, SCOPE_B)).toThrow(CrossTenantError);
    expect(() => applyProposals(current, proposals, null)).toThrow(ScopeError);
    const shared: AdaptationProposal = { ...proposals[0]!, scope: null };
    expect(() => applyProposals(current, [shared], SCOPE_A)).toThrow(ScopeError);
  });

  it("refuses out-of-bounds or over-step proposals", () => {
    const p = proposals.find((x) => x.target === "strategy_allocation" && x.key === "momo")!;
    expect(() => applyProposals(current, [{ ...p, proposedValue: 0.9 }], SCOPE_A)).toThrow(AdaptationBoundsError);
    expect(() => applyProposals(current, [{ ...p, proposedValue: p.currentValue + 0.06, bounds: { ...p.bounds, maxStepPerDay: 0.5 } }], SCOPE_A)).toThrow(AdaptationBoundsError);
  });

  it("skips non-auto, validation-required, stale and already-applied proposals", () => {
    const p = proposals[0]!;
    const res = applyProposals({ ...current, [`${p.target}:${p.key}`]: p.currentValue + 0.001 }, [
      { ...p, autoApplicable: false },
      { ...p, requiresValidationPipeline: true },
      { ...p, appliedAt: NOW },
      p,
    ], SCOPE_A);
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(["not_auto_applicable", "requires_validation", "already_applied", "stale_current_value"]);
  });

  it("clampProposal respects both bounds and step", () => {
    expect(clampProposal(0.5, 0.9, { min: 0, max: 1, maxStepPerDay: 0.1 })).toBeCloseTo(0.6);
    expect(clampProposal(0.95, 1.5, { min: 0, max: 1, maxStepPerDay: 0.1 })).toBeCloseTo(1);
    expect(clampProposal(0.5, -1, { min: 0.45, max: 1, maxStepPerDay: 0.1 })).toBeCloseTo(0.45);
  });
});
