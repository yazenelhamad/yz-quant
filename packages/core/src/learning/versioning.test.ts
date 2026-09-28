import { describe, expect, it } from "vitest";
import type { StrategyVersion } from "../types/index.js";
import { bumpVersion, compareVersions, createStrategyVersion, decisionProvenance, supersedeVersion, UNVERSIONED } from "./versioning.js";
import { NOW } from "./testFixtures.js";

describe("bumpVersion", () => {
  it("bumps minor and major", () => {
    expect(bumpVersion("1.4", "minor")).toBe("1.5");
    expect(bumpVersion("1.4", "major")).toBe("2.0");
    expect(bumpVersion("0.9", "minor")).toBe("0.10");
    expect(() => bumpVersion("1.4.2", "minor")).toThrow(/Invalid strategy version/);
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0", "1.99")).toBeGreaterThan(0);
  });
});

describe("createStrategyVersion", () => {
  const change = { kind: "minor" as const, parameters: { lookback: 20 }, changeSummary: "lookback 12 -> 20", changeReason: "walk-forward showed 20 more stable", proposedBy: { kind: "learning_engine" as const, id: "learn-1" } };

  it("creates 1.0 without a previous version and requires a strategy id", () => {
    const v = createStrategyVersion(null, { ...change, strategyId: "strat-1" }, NOW, () => "sv-1");
    expect(v).toMatchObject({ id: "sv-1", strategyId: "strat-1", version: "1.0", approvalStatus: "proposed", approvedBy: null, deployedAt: null, createdAt: NOW, backtestResultId: null });
    expect(() => createStrategyVersion(null, change, NOW, () => "x")).toThrow(/strategyId is required/);
  });

  it("bumps from the previous version without mutating it", () => {
    const prev: StrategyVersion = Object.freeze(createStrategyVersion(null, { ...change, strategyId: "strat-1" }, NOW, () => "sv-1"));
    const snapshot = JSON.stringify(prev);
    const next = createStrategyVersion(prev, { ...change, kind: "major", backtestResultId: "bt-9" }, NOW, () => "sv-2");
    expect(next.version).toBe("2.0");
    expect(next.strategyId).toBe("strat-1");
    expect(next.backtestResultId).toBe("bt-9");
    expect(next.parameters).not.toBe(change.parameters);
    expect(JSON.stringify(prev)).toBe(snapshot);
    expect(() => createStrategyVersion(prev, { ...change, strategyId: "other" }, NOW, () => "x")).toThrow(/mismatch/);
    const superseded = supersedeVersion(prev);
    expect(superseded.approvalStatus).toBe("superseded");
    expect(prev.approvalStatus).toBe("proposed");
  });
});

describe("decisionProvenance", () => {
  it("builds the versions record from a StrategyVersion, a string or null", () => {
    const sv = createStrategyVersion(null, { kind: "minor", strategyId: "s", parameters: {}, changeSummary: "", changeReason: "", proposedBy: { kind: "human", id: "u" } }, NOW, () => "sv-1");
    const base = { modelName: "claude", modelVersion: "2026-06", promptVersion: "p-3", featureVersion: "f-2", riskEngineVersion: "risk-1.0" };
    expect(decisionProvenance({ ...base, strategyVersion: sv })).toEqual({ ...base, strategyVersion: "1.0@sv-1" });
    expect(decisionProvenance({ ...base, strategyVersion: "1.4" }).strategyVersion).toBe("1.4");
    expect(decisionProvenance({ ...base, strategyVersion: null }).strategyVersion).toBe(UNVERSIONED);
  });
});
