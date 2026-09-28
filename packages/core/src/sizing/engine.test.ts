import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_SETTINGS } from "../types/index.js";
import { computeSize, type SizingInput } from "./engine.js";

const scope = { userId: "user-a", brokerAccountId: "acct-a" };

function base(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    scope,
    now: "2026-09-28T14:30:00Z",
    symbol: "NVDA",
    price: 100,
    totalValue: 100_000,
    buyingPower: 60_000,
    settings: DEFAULT_RISK_SETTINGS,
    strategyMaxPositionPct: null,
    strategyMaxLossPerTradePct: null,
    capitalAllocation: null,
    candidate: {
      confidence: 0.75,
      expectedEdge: 0.3,
      expectedUpsidePct: 0.12,
      expectedDownsidePct: 0.05,
      regimeFit: 0.9,
      liquidityScore: 0.9,
      annualizedVol: 0.35,
      atrPct: 0.03,
      adv: 50_000_000,
      correlationToPortfolio: 0.1,
      uncertainty: 0.2,
    },
    portfolio: { currentDrawdownPct: 0.01, existingPositionNotional: 0, deployedPct: 0.2, sizeMultiplier: 1 },
    strategyPerformance: { winRate: 0.6, payoffRatio: 1.8, trades: 40 },
    regimePerformance: { winRate: 0.62, payoffRatio: 1.9, trades: 15 },
    fractionalAllowed: false,
    orderType: "limit",
    ...overrides,
  };
}

describe("SizingEngine.computeSize: happy path", () => {
  it("produces a whole-share quantity, notional, rationale and binding constraint", () => {
    const r = computeSize(base());
    expect(r.quantity).toBeGreaterThan(0);
    expect(Number.isInteger(r.quantity)).toBe(true);
    expect(r.notional).toBeCloseTo(r.quantity * 100, 6);
    expect(r.rationale.length).toBeGreaterThan(2);
    expect(r.constraints.some((k) => k.name === r.bindingConstraint)).toBe(true);
    expect(r.kelly).not.toBeNull();
    expect(r.engineVersion).toBe("sizing-1.0.0");
    expect(r.decidedAt).toBe("2026-09-28T14:30:00Z");
  });

  it("never exceeds kellyFraction * fullKelly of equity", () => {
    const r = computeSize(base({ candidate: { ...base().candidate, expectedUpsidePct: 0.5, expectedDownsidePct: 0.02 } }));
    expect(r.kelly).not.toBeNull();
    expect(r.notional).toBeLessThanOrEqual(r.kelly!.fullKelly * DEFAULT_RISK_SETTINGS.kellyFraction * 100_000 + 1e-6);
    expect(r.kelly!.fractionApplied).toBeLessThanOrEqual(0.5);
  });

  it("never exceeds maxPositionPct, even with a huge edge and no other constraints", () => {
    const settings = { ...DEFAULT_RISK_SETTINGS, kellyFraction: 0.5, maxPositionPct: 0.05, maxLossPerTradePct: 1, maxCapitalDeployedPct: 1 };
    const r = computeSize(base({
      settings,
      candidate: { ...base().candidate, confidence: 0.99, expectedUpsidePct: 5, expectedDownsidePct: 0.01, annualizedVol: null, atrPct: null, adv: 1e12 },
      buyingPower: 1e9,
      strategyPerformance: null,
      regimePerformance: null,
    }));
    expect(r.notional).toBeLessThanOrEqual(0.05 * 100_000);
    expect(r.bindingConstraint).toBe("max_position_pct");
  });

  it("subtracts the existing position from the position cap", () => {
    const settings = { ...DEFAULT_RISK_SETTINGS, kellyFraction: 0.5, maxPositionPct: 0.05, maxLossPerTradePct: 1, maxCapitalDeployedPct: 1 };
    const cand = { ...base().candidate, confidence: 0.99, expectedUpsidePct: 5, expectedDownsidePct: 0.01, annualizedVol: null, atrPct: null, adv: 1e12 };
    const fresh = computeSize(base({ settings, candidate: cand, buyingPower: 1e9 }));
    const partial = computeSize(base({ settings, candidate: cand, buyingPower: 1e9, portfolio: { ...base().portfolio, existingPositionNotional: 4_000 } }));
    expect(partial.notional).toBeLessThanOrEqual(1_000);
    expect(partial.notional).toBeLessThan(fresh.notional);
  });

  it("caps at max ADV participation", () => {
    const r = computeSize(base({ candidate: { ...base().candidate, adv: 200_000 } }));
    expect(r.bindingConstraint).toBe("liquidity_adv");
    expect(r.notional).toBeLessThanOrEqual(2_000);
    const r2 = computeSize(base({ candidate: { ...base().candidate, adv: 200_000 }, maxAdvParticipation: 0.005 }));
    expect(r2.notional).toBeLessThanOrEqual(1_000);
  });

  it("caps at the loss-per-trade budget", () => {
    const settings = { ...DEFAULT_RISK_SETTINGS, maxLossPerTradePct: 0.005 };
    const r = computeSize(base({ settings, candidate: { ...base().candidate, expectedDownsidePct: 0.2, expectedUpsidePct: 0.6, atrPct: 0.01, annualizedVol: 0.1 } }));
    expect(r.notional).toBeLessThanOrEqual((0.005 * 100_000) / 0.2 + 1e-6);
  });

  it("caps at remaining deployable capital and buying power", () => {
    const deployed = computeSize(base({ portfolio: { ...base().portfolio, deployedPct: 0.59 } }));
    expect(deployed.bindingConstraint).toBe("capital_deployed");
    expect(deployed.notional).toBeLessThanOrEqual(1_000 + 1e-6);
    const bp = computeSize(base({ buyingPower: 350 }));
    expect(bp.bindingConstraint).toBe("buying_power");
    expect(bp.quantity).toBe(3);
  });

  it("honours per-strategy caps and allocation", () => {
    const r = computeSize(base({ strategyMaxPositionPct: 0.01 }));
    expect(r.notional).toBeLessThanOrEqual(1_000);
    const alloc = computeSize(base({ capitalAllocation: 0.02 }));
    expect(alloc.bindingConstraint).toBe("strategy_allocation");
    expect(alloc.notional).toBeLessThanOrEqual(0.02 * 0.6 * 100_000 + 1e-6);
  });

  it("allows fractional shares only for market orders when permitted", () => {
    const r = computeSize(base({ fractionalAllowed: true, orderType: "market", buyingPower: 150 }));
    expect(r.quantity).toBeCloseTo(1.5, 4);
    const limit = computeSize(base({ fractionalAllowed: true, orderType: "limit", buyingPower: 150 }));
    expect(limit.quantity).toBe(1);
  });

  it("is deterministic", () => {
    expect(computeSize(base())).toEqual(computeSize(base()));
  });
});

describe("SizingEngine.computeSize: scaling", () => {
  it("scales down as drawdown approaches the limit and zeroes at the limit", () => {
    const healthy = computeSize(base({ portfolio: { ...base().portfolio, currentDrawdownPct: 0 } }));
    const half = computeSize(base({ portfolio: { ...base().portfolio, currentDrawdownPct: 0.05 } }));
    const dead = computeSize(base({ portfolio: { ...base().portfolio, currentDrawdownPct: 0.1 } }));
    expect(half.scalingMultiplier).toBeLessThan(healthy.scalingMultiplier);
    expect(half.notional).toBeLessThanOrEqual(healthy.notional);
    expect(dead.quantity).toBe(0);
    expect(dead.bindingConstraint).toContain("drawdown_limit");
  });

  it("scales down with correlation, uncertainty, weak regime fit and portfolio multiplier", () => {
    const b = computeSize(base());
    const corr = computeSize(base({ candidate: { ...base().candidate, correlationToPortfolio: 0.9 } }));
    const unc = computeSize(base({ candidate: { ...base().candidate, uncertainty: 0.9 } }));
    const fit = computeSize(base({ candidate: { ...base().candidate, regimeFit: 0.1 } }));
    const pm = computeSize(base({ portfolio: { ...base().portfolio, sizeMultiplier: 0.3 } }));
    for (const r of [corr, unc, fit, pm]) expect(r.scalingMultiplier).toBeLessThan(b.scalingMultiplier);
    const zeroPm = computeSize(base({ portfolio: { ...base().portfolio, sizeMultiplier: 0 } }));
    expect(zeroPm.quantity).toBe(0);
  });

  it("scales down when the strategy performs poorly in this regime", () => {
    const b = computeSize(base());
    const weak = computeSize(base({ regimePerformance: { winRate: 0.3, payoffRatio: 1.2, trades: 20 } }));
    expect(weak.scalingMultiplier).toBeLessThan(b.scalingMultiplier);
    expect(weak.rationale.some((r) => r.includes("weak record"))).toBe(true);
  });

  it("haircuts unknown optional inputs (correlation, drawdown, regime fit)", () => {
    const b = computeSize(base());
    const unknown = computeSize(base({
      candidate: { ...base().candidate, correlationToPortfolio: null, regimeFit: null },
      portfolio: { ...base().portfolio, currentDrawdownPct: null },
    }));
    expect(unknown.scalingMultiplier).toBeLessThan(b.scalingMultiplier);
  });

  it("halves the Kelly target when volatility and ATR are both unknown", () => {
    const r = computeSize(base({ candidate: { ...base().candidate, annualizedVol: null, atrPct: null } }));
    expect(r.constraints.some((k) => k.name === "volatility_unknown")).toBe(true);
  });

  it("falls back to historical payoff when expected upside is missing", () => {
    const r = computeSize(base({ candidate: { ...base().candidate, expectedUpsidePct: null } }));
    expect(r.quantity).toBeGreaterThan(0);
    expect(r.rationale.some((x) => x.includes("taken from strategy history"))).toBe(true);
  });
});

describe("SizingEngine.computeSize: fail closed", () => {
  it("returns zero for price <= 0 or missing", () => {
    for (const price of [0, -5, null, NaN]) {
      const r = computeSize(base({ price }));
      expect(r.quantity).toBe(0);
      expect(r.notional).toBe(0);
      expect(r.bindingConstraint).toContain("invalid_price");
    }
  });

  it("returns zero when required inputs are missing", () => {
    expect(computeSize(base({ totalValue: null })).bindingConstraint).toContain("invalid_equity");
    expect(computeSize(base({ candidate: { ...base().candidate, confidence: null } })).bindingConstraint).toContain("missing_confidence");
    expect(computeSize(base({ candidate: { ...base().candidate, expectedDownsidePct: null } })).bindingConstraint).toContain("missing_downside");
    expect(computeSize(base({ candidate: { ...base().candidate, expectedDownsidePct: 0 } })).bindingConstraint).toContain("missing_downside");
    expect(computeSize(base({ candidate: { ...base().candidate, adv: null } })).bindingConstraint).toContain("liquidity_unknown");
    expect(computeSize(base({ buyingPower: null })).bindingConstraint).toContain("no_buying_power");
    expect(computeSize(base({ candidate: { ...base().candidate, expectedUpsidePct: null }, strategyPerformance: null })).bindingConstraint).toContain("missing_payoff");
  });

  it("returns zero when the edge is negative", () => {
    const r = computeSize(base({ candidate: { ...base().candidate, confidence: 0.3, expectedUpsidePct: 0.05, expectedDownsidePct: 0.05 }, strategyPerformance: null, regimePerformance: null }));
    expect(r.quantity).toBe(0);
    expect(r.bindingConstraint).toContain("negative_edge");
  });

  it("returns zero when the binding constraint buys less than one share", () => {
    const r = computeSize(base({ price: 5_000, buyingPower: 4_000 }));
    expect(r.quantity).toBe(0);
    expect(r.bindingConstraint).toContain("below_one_share");
  });

  it("returns zero when capital is fully deployed", () => {
    const r = computeSize(base({ portfolio: { ...base().portfolio, deployedPct: 0.6 } }));
    expect(r.quantity).toBe(0);
    expect(r.bindingConstraint).toContain("capital_deployed");
  });

  it("throws on invalid scope / timestamp", () => {
    expect(() => computeSize(base({ scope: { userId: "", brokerAccountId: "x" } }))).toThrow();
    expect(() => computeSize(base({ now: "nope" }))).toThrow();
  });
});
