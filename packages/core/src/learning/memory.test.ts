import { describe, expect, it } from "vitest";
import { CrossTenantError } from "../types/index.js";
import { buildMemoryEntry, buildNormalizer, findAnalogs, MEMORY_FEATURE_KEYS, summarizeAnalogs, vectorize, type VectorizedMemoryEntry } from "./memory.js";
import { makeMemory, makeOutcome, makeTrade, SCOPE_B } from "./testFixtures.js";

describe("buildMemoryEntry", () => {
  it("derives return, holding period, slippage and execution quality from the trade", () => {
    const e = buildMemoryEntry({
      trade: makeTrade(),
      thesis: { strategyKey: "xs_momentum", confidence: 0.7, expectedEdge: 0.3, expectedDownsidePct: 3, sector: "tech" },
      signals: { a: 1 },
      features: { momentum_20: 0.1 },
      regime: "bull_trend",
      executionOutcomes: [makeOutcome({ actualSlippageBps: 6, expectedSlippageBps: 5 }), makeOutcome({ side: "sell", actualSlippageBps: 20 })],
      positionPct: 0.04,
    });
    expect(e.actualReturnPct).toBeCloseTo(4);
    expect(e.holdingDays).toBeCloseTo(8);
    expect(e.slippageBps).toBe(6);
    expect(e.executionQuality).toBeCloseTo((0.9 + 0) / 2); // buy: 1 bps over on 5 expected; sell: 3x expected -> 0
    expect(e.scope).toEqual(makeTrade().scope);
    expect(e.positionPct).toBe(0.04);
    expect(e.reviewClassification).toBeNull();
  });

  it("leaves the return null for open trades and refuses cross-tenant outcomes", () => {
    const open = buildMemoryEntry({ trade: makeTrade({ state: "monitoring", closedAt: null, averageExitPrice: null }), thesis: { strategyKey: "k", confidence: 0.5, expectedEdge: 0.1, expectedDownsidePct: 2, sector: null }, signals: {}, features: {}, regime: "x" });
    expect(open.actualReturnPct).toBeNull();
    expect(() => buildMemoryEntry({ trade: makeTrade(), thesis: { strategyKey: "k", confidence: 0.5, expectedEdge: 0.1, expectedDownsidePct: 2, sector: null }, signals: {}, features: {}, regime: "x", executionOutcomes: [makeOutcome({ scope: SCOPE_B })] })).toThrow(CrossTenantError);
  });
});

describe("vectorize", () => {
  it("uses the fixed key order, standardises and clips", () => {
    const norm = buildNormalizer([{ features: { momentum_20: 0 } }, { features: { momentum_20: 2 } }]);
    expect(norm.momentum_20).toEqual({ mean: 1, std: Math.SQRT2 });
    const v = vectorize({ momentum_20: 100, rsi_14: 50 }, MEMORY_FEATURE_KEYS, norm);
    expect(v).toHaveLength(MEMORY_FEATURE_KEYS.length);
    expect(v[MEMORY_FEATURE_KEYS.indexOf("momentum_20")]).toBe(1); // clipped at +3 sd then scaled
    expect(v[MEMORY_FEATURE_KEYS.indexOf("rsi_14")]).toBeCloseTo(1); // std defaults to 1 with no data -> 50 clipped
    expect(v[MEMORY_FEATURE_KEYS.indexOf("breadth")]).toBe(0);
    expect(vectorize({ a: 1, b: null }, ["a", "b", "c"])).toEqual([1 / 3, 0, 0]);
  });
});

describe("findAnalogs", () => {
  const mem = (over: Partial<VectorizedMemoryEntry>): VectorizedMemoryEntry => ({ ...makeMemory(), vector: [1, 0, 0], ...over });
  const memory: VectorizedMemoryEntry[] = [
    mem({ tradeId: "same-all", vector: [1, 0, 0], actualReturnPct: 3, reviewClassification: "good_win", lessons: ["worked"] }),
    mem({ tradeId: "other-user-shadow", scope: SCOPE_B, mode: "shadow", vector: [1, 0.1, 0], actualReturnPct: -2, reviewClassification: "bad_thesis" }),
    mem({ tradeId: "other-strategy", strategyKey: "mean_rev", vector: [1, 0, 0], actualReturnPct: 1, reviewClassification: null }),
    mem({ tradeId: "orthogonal", vector: [0, 1, 0], actualReturnPct: 5 }),
    mem({ tradeId: "open", vector: [1, 0, 0], actualReturnPct: null }),
    mem({ tradeId: "self", vector: [1, 0, 0], actualReturnPct: 9 }),
  ];

  it("ranks by cosine similarity plus strategy/regime/sector bonuses and excludes open trades and self", () => {
    const analogs = findAnalogs({ vector: [1, 0, 0], strategyKey: "xs_momentum", regime: "bull_trend", symbol: "AAPL", sector: "tech", excludeTradeId: "self" }, memory, 10);
    expect(analogs.map((a) => a.tradeId)).toEqual(["same-all", "other-user-shadow", "other-strategy", "orthogonal"]);
    expect(analogs[0]?.similarity).toBeCloseTo(1);
    expect(analogs[0]?.thesisCorrect).toBe(true);
    expect(analogs[0]?.lesson).toBe("worked");
    expect(analogs[1]?.mode).toBe("shadow"); // other user's shadow memory is evidence
    expect(analogs[2]?.similarity).toBeCloseTo(0.85);
    for (const a of analogs) {
      expect(a.similarity).toBeGreaterThanOrEqual(0);
      expect(a.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("respects k and never mutates the memory", () => {
    const snapshot = JSON.stringify(memory);
    expect(findAnalogs({ vector: [1, 0, 0], strategyKey: "x", regime: "y", symbol: "z", sector: null }, memory, 2)).toHaveLength(2);
    expect(JSON.stringify(memory)).toBe(snapshot);
  });

  it("summarises analogs", () => {
    const analogs = findAnalogs({ vector: [1, 0, 0], strategyKey: "xs_momentum", regime: "bull_trend", symbol: "AAPL", sector: "tech", excludeTradeId: "self" }, memory, 3);
    const s = summarizeAnalogs(analogs);
    expect(s.analogs).toBe(3);
    expect(s.positive).toBe(2);
    expect(s.avgReturnPct).toBeCloseTo((3 - 2 + 1) / 3);
    expect(s.thesisCorrectRate).toBeCloseTo(0.5);
    expect(s.avgConfidenceError).toBeCloseTo((0.3 + 0.7 + 0.3) / 3);
    expect(summarizeAnalogs([])).toEqual({ analogs: 0, positive: 0, avgReturnPct: null, thesisCorrectRate: null, avgConfidenceError: null });
  });
});
