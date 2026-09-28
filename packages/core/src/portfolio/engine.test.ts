import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_SETTINGS, type RiskSettings } from "../types/index.js";
import { assess, computeRiskCapacity, type PortfolioAssessInput, type PortfolioPositionInput } from "./engine.js";

const scope = { userId: "user-a", brokerAccountId: "acct-a" };
const NOW = "2026-09-28T14:30:00Z";

function pos(symbol: string, sector: string, marketValue: number, extra: Partial<PortfolioPositionInput> = {}): PortfolioPositionInput {
  return { symbol, assetClass: "equity", sector, beta: 1, quantity: 10, marketValue, correlationToCandidate: null, earningsInDays: null, ...extra };
}

function base(overrides: Partial<PortfolioAssessInput> = {}): PortfolioAssessInput {
  return {
    scope,
    now: NOW,
    totalValue: 100_000,
    cash: 50_000,
    positions: [],
    peakValue: 100_000,
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    settings: DEFAULT_RISK_SETTINGS,
    candidate: null,
    ...overrides,
  };
}

describe("PortfolioEngine.assess: portfolio metrics", () => {
  it("computes exposure, cash, sector map, beta, HHI and drawdown", () => {
    const r = assess(base({
      positions: [pos("AAPL", "tech", 20_000, { beta: 1.2 }), pos("XOM", "energy", 10_000, { beta: 0.6 }), pos("MSFT", "tech", 20_000, { beta: 1.0 })],
      peakValue: 110_000,
    }));
    expect(r.complete).toBe(true);
    expect(r.exposurePct).toBeCloseTo(0.5, 10);
    expect(r.cashPct).toBeCloseTo(0.5, 10);
    expect(r.sectorExposure.tech).toBeCloseTo(0.4, 10);
    expect(r.sectorExposure.energy).toBeCloseTo(0.1, 10);
    expect(r.betaWeightedExposure).toBeCloseTo((1.2 * 20_000 + 0.6 * 10_000 + 20_000) / 100_000, 10);
    expect(r.concentrationHHI).toBeCloseTo((0.4 ** 2) * 2 + 0.2 ** 2, 10);
    expect(r.currentDrawdownPct).toBeCloseTo(10_000 / 110_000, 10);
    expect(r.positionCount).toBe(3);
    expect(r.engineVersion).toBe("portfolio-1.0.0");
  });

  it("uses the correlation matrix for average pairwise correlation", () => {
    const r = assess(base({
      positions: [pos("A", "x", 10_000), pos("B", "x", 10_000), pos("C", "y", 10_000)],
      correlationMatrix: { A: { B: 0.8, C: 0.2 }, B: { C: 0.5 } },
    }));
    expect(r.averagePairwiseCorrelation).toBeCloseTo((0.8 + 0.2 + 0.5) / 3, 10);
  });

  it("flags event exposure within the horizon", () => {
    const r = assess(base({ positions: [pos("NVDA", "tech", 10_000, { earningsInDays: 3 }), pos("XOM", "energy", 10_000, { earningsInDays: 20 })] }));
    expect(r.eventExposure.symbols).toEqual(["NVDA"]);
    expect(r.eventExposure.pct).toBeCloseTo(0.1, 10);
  });

  it("marks incomplete when a position has no market value and gives the candidate zero size", () => {
    const r = assess(base({
      positions: [pos("AAPL", "tech", 10_000), pos("GHOST", "tech", 10_000, { marketValue: null })],
      candidate: { symbol: "MSFT", assetClass: "equity", sector: "tech", beta: 1, proposedNotional: 5_000 },
    }));
    expect(r.complete).toBe(false);
    expect(r.warnings.some((w) => w.includes("GHOST"))).toBe(true);
    expect(r.candidate?.sizeMultiplier).toBe(0);
    expect(r.candidate?.fitScore).toBe(-1);
  });

  it("fails closed on unknown total value", () => {
    const r = assess(base({ totalValue: null, candidate: { symbol: "MSFT", assetClass: "equity", sector: "tech", beta: 1, proposedNotional: 5_000 } }));
    expect(r.complete).toBe(false);
    expect(r.candidate?.sizeMultiplier).toBe(0);
  });

  it("rejects invalid scope or timestamp", () => {
    expect(() => assess(base({ scope: { userId: "", brokerAccountId: "" } }))).toThrow();
    expect(() => assess(base({ now: "yesterday" }))).toThrow();
  });
});

describe("computeRiskCapacity", () => {
  const settings: RiskSettings = { ...DEFAULT_RISK_SETTINGS, maxDrawdownPct: 0.1, maxDailyLossPct: 0.02, maxWeeklyLossPct: 0.05 };

  it("is 1 when all budgets are untouched", () => {
    expect(computeRiskCapacity({ currentDrawdownPct: 0, dailyPnlPct: 0.01, weeklyPnlPct: 0.02, settings, warnings: [] })).toBe(1);
  });

  it("shrinks with drawdown and losses, taking the tightest budget", () => {
    expect(computeRiskCapacity({ currentDrawdownPct: 0.05, dailyPnlPct: 0, weeklyPnlPct: 0, settings, warnings: [] })).toBeCloseTo(0.5, 10);
    expect(computeRiskCapacity({ currentDrawdownPct: 0.02, dailyPnlPct: -0.015, weeklyPnlPct: 0, settings, warnings: [] })).toBeCloseTo(0.25, 10);
    expect(computeRiskCapacity({ currentDrawdownPct: 0.12, dailyPnlPct: 0, weeklyPnlPct: 0, settings, warnings: [] })).toBe(0);
  });

  it("haircuts unknown budgets instead of assuming them healthy", () => {
    const warnings: string[] = [];
    expect(computeRiskCapacity({ currentDrawdownPct: null, dailyPnlPct: null, weeklyPnlPct: 0, settings, warnings })).toBe(0.5);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("PortfolioEngine.assess: candidate fit", () => {
  const nvda = { symbol: "NVDA", assetClass: "equity" as const, sector: "tech", beta: 1.6, proposedNotional: 8_000 };

  it("same signal, different portfolios: tech-heavy user gets small size, light user gets full size", () => {
    const settings = { ...DEFAULT_RISK_SETTINGS, maxSectorPct: 0.3, maxPositionPct: 0.1 };
    const heavyTech = assess(base({
      settings,
      positions: [
        pos("AAPL", "tech", 10_000, { correlationToCandidate: 0.7 }),
        pos("MSFT", "tech", 9_000, { correlationToCandidate: 0.65 }),
        pos("AMD", "tech", 9_000, { correlationToCandidate: 0.85 }),
      ],
      candidate: nvda,
    }));
    const lightTech = assess(base({
      settings,
      positions: [
        pos("XOM", "energy", 10_000, { correlationToCandidate: 0.1 }),
        pos("JNJ", "health", 10_000, { correlationToCandidate: 0.05 }),
        pos("PG", "staples", 8_000, { correlationToCandidate: 0.0 }),
      ],
      candidate: nvda,
    }));
    expect(heavyTech.candidate).not.toBeNull();
    expect(lightTech.candidate).not.toBeNull();
    const a = heavyTech.candidate!;
    const b = lightTech.candidate!;
    expect(a.fitScore).toBeLessThan(b.fitScore);
    expect(a.sizeMultiplier).toBeLessThan(b.sizeMultiplier);
    // heavy tech: 28% in tech + 8% would breach 30% => headroom 2% => at most 0.25 of proposal
    expect(a.sizeMultiplier).toBeLessThanOrEqual(0.25);
    expect(a.adjustedNotional).toBeLessThanOrEqual(2_000);
    expect(b.sizeMultiplier).toBe(1);
    expect(b.adjustedNotional).toBe(8_000);
    expect(a.sectorPctAfter).toBeCloseTo(0.36, 10);
    expect(b.sectorPctAfter).toBeCloseTo(0.08, 10);
    expect(a.correlationToPortfolio).toBeGreaterThan(0.6);
    expect(b.correlationToPortfolio).toBeLessThan(0.15);
    expect(a.notes.some((n) => n.includes("above the 30.0% limit"))).toBe(true);
  });

  it("gives zero size when the sector is already at its limit", () => {
    const r = assess(base({
      settings: { ...DEFAULT_RISK_SETTINGS, maxSectorPct: 0.3 },
      positions: [pos("AAPL", "tech", 30_000)],
      candidate: nvda,
    }));
    expect(r.candidate?.sizeMultiplier).toBe(0);
    expect(r.candidate?.fitScore).toBeLessThan(0);
  });

  it("penalises duplicate exposure", () => {
    const withDup = assess(base({ positions: [pos("NVDA", "tech", 5_000, { correlationToCandidate: 1 })], candidate: nvda }));
    const without = assess(base({ positions: [pos("AAPL", "tech", 5_000, { correlationToCandidate: 0.3 })], candidate: nvda }));
    expect(withDup.candidate?.duplicateExposure).toBe(true);
    expect(withDup.candidate?.fitScore).toBeLessThan(without.candidate!.fitScore);
    expect(withDup.candidate?.positionPctAfter).toBeCloseTo(0.13, 10);
  });

  it("reports beta after and flags beta breaches", () => {
    const r = assess(base({
      settings: { ...DEFAULT_RISK_SETTINGS, maxPortfolioBeta: 1.0 },
      positions: [pos("TSLA", "auto", 50_000, { beta: 2.0 })],
      candidate: { ...nvda, proposedNotional: 5_000 },
    }));
    expect(r.candidate?.betaAfter).toBeCloseTo(1.0 + (1.6 * 5_000) / 100_000, 10);
    expect(r.candidate?.notes.some((n) => n.includes("portfolio beta"))).toBe(true);
  });

  it("scales size down as risk capacity is depleted", () => {
    const healthy = assess(base({ candidate: nvda }));
    const drawn = assess(base({ candidate: nvda, peakValue: 108_000, dailyPnlPct: -0.015 }));
    const dead = assess(base({ candidate: nvda, peakValue: 120_000 }));
    expect(healthy.candidate!.sizeMultiplier).toBeGreaterThan(drawn.candidate!.sizeMultiplier);
    expect(dead.riskCapacity).toBe(0);
    expect(dead.candidate!.sizeMultiplier).toBe(0);
  });

  it("uses a supplied correlationToPortfolio and penalises unknown correlation", () => {
    const known = assess(base({ positions: [pos("XOM", "energy", 10_000)], candidate: { ...nvda, correlationToPortfolio: 0.0 } }));
    const unknown = assess(base({ positions: [pos("XOM", "energy", 10_000)], candidate: nvda }));
    expect(known.candidate?.correlationToPortfolio).toBe(0);
    expect(unknown.candidate?.correlationToPortfolio).toBeNull();
    expect(unknown.candidate!.fitScore).toBeLessThan(known.candidate!.fitScore);
  });

  it("penalises a shared factor with one holding even when the book-wide average reads low", () => {
    const diversified = assess(base({ positions: [pos("XOM", "energy", 10_000)], candidate: { ...nvda, correlationToPortfolio: 0.22 } }));
    const twin = assess(base({ positions: [pos("XOM", "energy", 10_000)], candidate: { ...nvda, correlationToPortfolio: 0.22, maxCorrelation: { symbol: "AMAT", r: 0.74 } } }));
    expect(diversified.candidate!.notes.some((n) => /low correlation/.test(n))).toBe(true);
    expect(twin.candidate!.fitScore).toBeLessThan(diversified.candidate!.fitScore);
    expect(twin.candidate!.notes.some((n) => /shares a factor with AMAT/.test(n))).toBe(true);
  });

  it("penalises event risk on the candidate", () => {
    const noEvent = assess(base({ candidate: nvda }));
    const event = assess(base({ candidate: { ...nvda, earningsInDays: 2 } }));
    expect(event.candidate!.fitScore).toBeLessThan(noEvent.candidate!.fitScore);
  });

  it("keeps fitScore in [-1,1] and sizeMultiplier in [0,1]", () => {
    const r = assess(base({
      settings: { ...DEFAULT_RISK_SETTINGS, maxSectorPct: 0.1 },
      positions: [pos("NVDA", "tech", 30_000, { correlationToCandidate: 1 }), pos("AMD", "tech", 30_000, { correlationToCandidate: 0.9 })],
      peakValue: 150_000,
      candidate: { ...nvda, earningsInDays: 1 },
    }));
    expect(r.candidate!.fitScore).toBeGreaterThanOrEqual(-1);
    expect(r.candidate!.sizeMultiplier).toBe(0);
  });

  it("is deterministic", () => {
    const input = base({ positions: [pos("AAPL", "tech", 10_000, { correlationToCandidate: 0.5 })], candidate: nvda });
    expect(assess(input)).toEqual(assess(input));
  });
});
