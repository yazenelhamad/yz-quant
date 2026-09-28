import { describe, expect, it } from "vitest";
import { blendedWinProbability, cappedKelly, fullKelly, payoffFromExpectations } from "./kelly.js";

describe("fullKelly", () => {
  it("computes p - (1-p)/b", () => {
    expect(fullKelly(0.6, 2)).toBeCloseTo(0.6 - 0.4 / 2, 10);
    expect(fullKelly(0.55, 1)).toBeCloseTo(0.1, 10);
  });

  it("floors at zero and rejects degenerate inputs", () => {
    expect(fullKelly(0.3, 1)).toBe(0);
    expect(fullKelly(null, 2)).toBeNull();
    expect(fullKelly(0.6, 0)).toBeNull();
    expect(fullKelly(1, 2)).toBeNull();
    expect(fullKelly(0, 2)).toBeNull();
    expect(fullKelly(NaN, 2)).toBeNull();
  });
});

describe("payoffFromExpectations", () => {
  it("divides upside by downside", () => {
    expect(payoffFromExpectations(0.1, 0.05)).toBe(2);
    expect(payoffFromExpectations(null, 0.05)).toBeNull();
    expect(payoffFromExpectations(0.1, 0)).toBeNull();
    expect(payoffFromExpectations(-0.1, 0.05)).toBeNull();
  });
});

describe("cappedKelly", () => {
  it("never exceeds kellyFraction * fullKelly and caps the fraction at 0.5", () => {
    const k = cappedKelly(0.6, 2, 0.25);
    expect(k?.fullKelly).toBeCloseTo(0.4, 10);
    expect(k?.cappedKelly).toBeCloseTo(0.1, 10);
    expect(k?.fractionApplied).toBe(0.25);
    const over = cappedKelly(0.6, 2, 0.9);
    expect(over?.fractionApplied).toBe(0.5);
    expect(over?.cappedKelly).toBeCloseTo(0.2, 10);
    expect(cappedKelly(0.6, 2, 0)?.cappedKelly).toBe(0);
    expect(cappedKelly(1.2, 2, 0.25)).toBeNull();
  });
});

describe("blendedWinProbability", () => {
  it("returns the calibrated confidence when there is no history", () => {
    expect(blendedWinProbability({ calibratedConfidence: 0.7, strategyWinRate: null, strategyTrades: 0, regimeWinRate: null, regimeTrades: 0 }).probability).toBe(0.7);
  });

  it("pulls towards history proportionally to sample size", () => {
    const small = blendedWinProbability({ calibratedConfidence: 0.8, strategyWinRate: 0.4, strategyTrades: 3, regimeWinRate: null, regimeTrades: 0 });
    const large = blendedWinProbability({ calibratedConfidence: 0.8, strategyWinRate: 0.4, strategyTrades: 60, regimeWinRate: null, regimeTrades: 0 });
    expect(small.probability).toBeGreaterThan(large.probability);
    expect(large.probability).toBeCloseTo(0.6, 10); // 50% weight at full sample
    expect(large.notes.length).toBe(1);
  });

  it("applies regime history on top and stays inside (0,1)", () => {
    const r = blendedWinProbability({ calibratedConfidence: 0.99, strategyWinRate: 0.99, strategyTrades: 100, regimeWinRate: 0.2, regimeTrades: 100 });
    expect(r.probability).toBeLessThan(0.99);
    expect(r.probability).toBeGreaterThan(0);
    expect(r.notes.length).toBe(2);
  });
});
