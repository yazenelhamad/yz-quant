import { describe, expect, it } from "vitest";
import type { Bar, RegimeAssessment, RegimeLabel, StrategyFamily } from "../../types/index.js";
import type { StrategyContext, StrategyOutput } from "../contract.js";
import { FEATURE, FEATURE_VERSION, computeFeatures } from "../../features/compute.js";
import { lastBarTime, meanRevertingBars, syntheticBars, trendingBars } from "../../features/synthetic.js";
import { REGIME_LABELS } from "../../regime/engine.js";
import { STRATEGY_LIBRARY, getStrategy, listStrategyDescriptors, strategiesByFamily } from "../registry.js";
import { EXT_FEATURE, isAbstention } from "./helpers.js";

const START = "2024-01-02T00:00:00Z";

function fakeRegime(primary: RegimeLabel, bias: Partial<Record<StrategyFamily, number>> = {}, asOf = "2025-01-01T00:00:00Z", dataQuality: RegimeAssessment["dataQuality"] = "fresh"): RegimeAssessment {
  const probabilities: Partial<Record<RegimeLabel, number>> = {};
  for (const l of REGIME_LABELS) probabilities[l] = l === primary ? 0.45 : 0.05;
  return {
    asOf, primary, probabilities, confidence: 0.8, abnormality: 0.1,
    metrics: { spyTrend20: 0.02, spyTrend100: 0.05, realizedVol20: 0.15, vix: 15, breadthPctAbove50: 60, avgPairwiseCorrelation: 0.3, sectorDispersion: 0.03, momentumPersistence: 0.1, meanReversionScore: 0.2, volumeRatio: 1 },
    familyBias: { trend_momentum: 0, mean_reversion: 0, statistical: 0, event: 0, options_volatility: 0, fundamental_variant: 0, ...bias },
    explanation: ["test regime"], dataQuality,
  };
}

const BULL = fakeRegime("bull_trend", { trend_momentum: 0.6, mean_reversion: -0.5, statistical: 0.1, event: 0.2 });
const RANGE = fakeRegime("range_bound", { trend_momentum: -0.4, mean_reversion: 0.6, statistical: 0.4 });
const RISK_OFF = fakeRegime("risk_off", { trend_momentum: -0.6, mean_reversion: -0.3, event: -0.3 });

interface CtxOpts {
  bars: Bar[];
  asOf?: string;
  intradayBars?: Bar[];
  benchmarkBars?: Bar[];
  regime?: RegimeAssessment;
  features?: Record<string, number | null>;
  universe?: StrategyContext["universe"];
  sector?: StrategyContext["sector"];
  upcomingEvents?: StrategyContext["upcomingEvents"];
  position?: StrategyContext["position"];
  parameters?: StrategyContext["parameters"];
}

function makeCtx(o: CtxOpts): StrategyContext {
  const asOf = o.asOf ?? (o.intradayBars ? lastBarTime(o.intradayBars) : lastBarTime(o.bars));
  const fs = computeFeatures({ asOf, bars: o.bars, intradayBars: o.intradayBars, benchmarkBars: o.benchmarkBars });
  return {
    asOf, symbol: "TEST", bars: o.bars, intradayBars: o.intradayBars, quote: null,
    features: { ...fs.values, ...(o.features ?? {}) },
    regime: { ...(o.regime ?? BULL), asOf },
    universe: o.universe, sector: o.sector ?? null, upcomingEvents: o.upcomingEvents ?? [],
    position: o.position ?? null, parameters: o.parameters ?? {}, featureVersion: FEATURE_VERSION,
  };
}

function run(key: string, ctx: StrategyContext): StrategyOutput {
  const s = getStrategy(key);
  if (!s) throw new Error(`missing strategy ${key}`);
  return s.evaluate(ctx);
}

function expectLong(out: StrategyOutput): void {
  expect(out.view).not.toBeNull();
  expect(out.view!.direction).toBe("long");
  expect(out.view!.strength).toBeGreaterThan(0);
  expect(out.view!.confidence).toBeGreaterThan(0);
  expect(out.signals.length).toBeGreaterThan(0);
  for (const s of out.signals) {
    expect(s.value).toBeGreaterThanOrEqual(-1);
    expect(s.value).toBeLessThanOrEqual(1);
    expect(s.confidence).toBeGreaterThanOrEqual(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
    expect(s.inputFreshness).toBe("fresh");
  }
}

const UP = trendingBars("TEST", 320, 0.003, 9, START);
const FLAT = meanRevertingBars("TEST", 320, 100, 0.3, 0.6, 5, START);

function universeOf(n: number, self: Record<string, number>, seed = 3): NonNullable<StrategyContext["universe"]> {
  const out: NonNullable<StrategyContext["universe"]> = [];
  for (let i = 0; i < n; i += 1) {
    const x = ((i * 7919 + seed) % 97) / 97; // deterministic spread in [0,1)
    out.push({ symbol: `U${i}`, features: { [FEATURE.momentum12_1]: -0.2 + 0.5 * x, [FEATURE.ret5]: -0.05 + 0.1 * x, [FEATURE.realizedVol60]: 0.15 + 0.4 * x, [FEATURE.trendTStat60]: -3 + 6 * x } });
  }
  out.push({ symbol: "TEST", features: self });
  return out;
}

describe("registry", () => {
  it("exposes 23 strategies with unique keys and valid parameter ranges", () => {
    expect(STRATEGY_LIBRARY.length).toBe(23);
    const keys = new Set(STRATEGY_LIBRARY.map((s) => s.descriptor.key));
    expect(keys.size).toBe(23);
    for (const d of listStrategyDescriptors()) {
      expect(d.warmupBars).toBeGreaterThan(0);
      for (const [name, spec] of Object.entries(d.parameters)) {
        if (typeof spec.default === "number") {
          if (spec.min !== undefined) expect(spec.default, `${d.key}.${name}`).toBeGreaterThanOrEqual(spec.min);
          if (spec.max !== undefined) expect(spec.default, `${d.key}.${name}`).toBeLessThanOrEqual(spec.max);
        }
      }
    }
    expect(strategiesByFamily("trend_momentum").length).toBe(6);
    expect(strategiesByFamily("mean_reversion").length).toBe(5);
    expect(strategiesByFamily("statistical").length).toBe(5);
    expect(strategiesByFamily("event").length).toBe(6);
    expect(strategiesByFamily("options_volatility").length).toBe(1);
    expect(getStrategy("nope")).toBeUndefined();
  });
});

describe("fail-closed behaviour shared by every strategy", () => {
  const intraday = syntheticBars({ symbol: "TEST", bars: 40, interval: "5minute", start: `${lastBarTime(UP).slice(0, 10)}T14:30:00Z`, startPrice: UP[UP.length - 1]!.close, seed: 2 });

  it("abstains on stale data", () => {
    const staleAsOf = new Date(Date.parse(lastBarTime(UP)) + 30 * 86_400_000).toISOString();
    for (const s of STRATEGY_LIBRARY) {
      const ctx = makeCtx({ bars: UP, intradayBars: intraday, asOf: staleAsOf, universe: universeOf(30, { [FEATURE.momentum12_1]: 0.9 }) });
      const out = s.evaluate(ctx);
      expect(out.signals, s.descriptor.key).toEqual([]);
      expect(isAbstention(out), s.descriptor.key).toBe(true);
      expect(out.view?.explanation, s.descriptor.key).toMatch(/Abstained: input data is stale/);
    }
  });

  it("abstains with insufficient bars", () => {
    for (const s of STRATEGY_LIBRARY) {
      const ctx = makeCtx({ bars: UP.slice(0, 3), intradayBars: intraday.slice(0, 3), asOf: lastBarTime(UP) });
      const out = s.evaluate(ctx);
      expect(out.signals, s.descriptor.key).toEqual([]);
      expect(out.view?.explanation, s.descriptor.key).toMatch(/Abstained: insufficient/);
    }
  });

  it("never emits short entries and every signal is bounded", () => {
    for (const s of STRATEGY_LIBRARY) {
      const ctx = makeCtx({ bars: UP, intradayBars: intraday, universe: universeOf(30, { [FEATURE.momentum12_1]: 0.9 }) });
      const out = s.evaluate(ctx);
      if (out.view) expect(["long", "reduce", "exit", "flat"], s.descriptor.key).toContain(out.view.direction);
      if (out.view && !ctx.position) expect(out.view.direction, s.descriptor.key).not.toBe("reduce");
      for (const sig of out.signals) {
        expect(sig.strategyKey).toBe(s.descriptor.key);
        expect(Math.abs(sig.value)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never uses bars after asOf", () => {
    const asOf = UP[299]!.time;
    const full = run("time_series_momentum", makeCtx({ bars: UP, asOf }));
    const truncated = run("time_series_momentum", makeCtx({ bars: UP.slice(0, 300), asOf }));
    expect(full).toEqual(truncated);
  });
});

describe("trend / momentum strategies", () => {
  it("cross_sectional_momentum goes long a top-decile name and abstains without a universe", () => {
    const ctx = makeCtx({ bars: UP, universe: universeOf(30, { [FEATURE.momentum12_1]: 0.95 }), features: { [FEATURE.momentum12_1]: 0.95 } });
    expectLong(run("cross_sectional_momentum", ctx));
    const noUni = run("cross_sectional_momentum", makeCtx({ bars: UP }));
    expect(noUni.view?.explanation).toMatch(/universe required/);
    const bottom = run("cross_sectional_momentum", makeCtx({ bars: UP, universe: universeOf(30, { [FEATURE.momentum12_1]: -0.9 }), features: { [FEATURE.momentum12_1]: -0.9 }, position: { quantity: 10, averageCost: 100, openedAt: START, strategyKey: null } }));
    expect(["reduce", "exit"]).toContain(bottom.view?.direction);
  });

  it("time_series_momentum fires on a strong uptrend and stays flat on a range", () => {
    expectLong(run("time_series_momentum", makeCtx({ bars: UP })));
    const flat = run("time_series_momentum", makeCtx({ bars: FLAT }));
    expect(flat.view?.direction).toBe("flat");
    expect(flat.signals).toEqual([]);
    const hostile = run("time_series_momentum", makeCtx({ bars: UP, regime: RISK_OFF }));
    expect(hostile.view?.explanation).toMatch(/hostile|regime/);
    expect(hostile.signals).toEqual([]);
  });

  it("relative_strength fires when outperforming the sector", () => {
    const ctx = makeCtx({ bars: UP, sector: { name: "Tech", features: { [FEATURE.ret60]: 0.0 } } });
    expectLong(run("relative_strength", ctx));
    expect(run("relative_strength", makeCtx({ bars: UP })).view?.explanation).toMatch(/No setup/);
  });

  it("breakout_continuation fires on a volume-confirmed breakout with breadth support and flags failures", () => {
    const n = UP.length;
    const hh = Math.max(...UP.slice(n - 21, n - 1).map((b) => b.high));
    const breakout = UP.map((b, i) => (i === n - 1 ? { ...b, close: hh * 1.02, high: hh * 1.025, volume: b.volume * 3 } : b));
    const out = run("breakout_continuation", makeCtx({ bars: breakout }));
    expectLong(out);
    expect(out.view!.invalidationPrice!).toBeLessThan(out.view!.targetPrice!);
    const weakBreadth = { ...BULL, metrics: { ...BULL.metrics, breadthPctAbove50: 30 } };
    expect(run("breakout_continuation", makeCtx({ bars: breakout, regime: weakBreadth })).view?.explanation).toMatch(/breadth/);
    const noVolume = UP.map((b, i) => (i === n - 1 ? { ...b, close: hh * 1.02, high: hh * 1.025 } : b));
    expect(run("breakout_continuation", makeCtx({ bars: noVolume })).view?.explanation).toMatch(/volume/);
    const failed = run("breakout_continuation", makeCtx({ bars: UP, features: { [FEATURE.failedBreakout]: 1 }, position: { quantity: 5, averageCost: 100, openedAt: START, strategyKey: null } }));
    expect(["reduce", "exit"]).toContain(failed.view?.direction);
  });

  it("sector_momentum fires when sector and name agree", () => {
    expectLong(run("sector_momentum", makeCtx({ bars: UP, sector: { name: "Tech", features: { [FEATURE.ret60]: 0.12 } } })));
    expect(run("sector_momentum", makeCtx({ bars: UP, sector: { name: "Tech", features: { [FEATURE.ret60]: -0.12 } } })).view?.direction).toBe("flat");
  });

  it("multi_timeframe_confirmation needs intraday bars and agreement", () => {
    const day = lastBarTime(UP).slice(0, 10);
    const intraUp = syntheticBars({ symbol: "TEST", bars: 40, interval: "5minute", start: `${day}T14:30:00Z`, drift: 0.002, vol: 0.0005, startPrice: UP[UP.length - 1]!.close, seed: 4 });
    expectLong(run("multi_timeframe_confirmation", makeCtx({ bars: UP, intradayBars: intraUp })));
    const intraDown = syntheticBars({ symbol: "TEST", bars: 40, interval: "5minute", start: `${day}T14:30:00Z`, drift: -0.002, vol: 0.0005, startPrice: UP[UP.length - 1]!.close, seed: 4 });
    expect(run("multi_timeframe_confirmation", makeCtx({ bars: UP, intradayBars: intraDown })).view?.direction).toBe("flat");
    expect(run("multi_timeframe_confirmation", makeCtx({ bars: UP })).view?.explanation).toMatch(/intraday/);
  });
});

describe("mean-reversion strategies (regime-gated)", () => {
  it("intraday_mean_reversion buys a stretch below VWAP only in a mean-reverting regime", () => {
    const day = lastBarTime(FLAT).slice(0, 10);
    const base = syntheticBars({ symbol: "TEST", bars: 40, interval: "5minute", start: `${day}T14:30:00Z`, vol: 0.0003, startPrice: 100, seed: 6 });
    const intraday = base.map((b, i) => (i === base.length - 1 ? { ...b, open: 100, close: 97.5, low: 97.3, high: 100 } : b));
    const out = run("intraday_mean_reversion", makeCtx({ bars: FLAT, intradayBars: intraday, regime: RANGE }));
    expectLong(out);
    expect(out.view!.targetPrice!).toBeGreaterThan(97.5);
    const bull = run("intraday_mean_reversion", makeCtx({ bars: FLAT, intradayBars: intraday, regime: BULL }));
    expect(bull.signals).toEqual([]);
    expect(bull.view?.explanation).toMatch(/does not favour mean_reversion/);
  });

  it("short_term_oversold_recovery buys an oversold pullback in an uptrend", () => {
    const n = UP.length;
    // Rebuild the last 6 bars as a sharp -2.5%/day decline inside an intact uptrend.
    const pulled = [...UP];
    let px = UP[n - 7]!.close;
    for (let i = n - 6; i < n; i += 1) { px *= 0.975; pulled[i] = { ...UP[i]!, open: px / 0.975, close: px, high: px / 0.975, low: px * 0.99 }; }
    const out = run("short_term_oversold_recovery", makeCtx({ bars: pulled, regime: BULL }));
    expectLong(out);
    expect(run("short_term_oversold_recovery", makeCtx({ bars: UP, regime: BULL })).view?.direction).toBe("flat");
  });

  it("vwap_reversion buys below the anchored VWAP in a range", () => {
    const n = FLAT.length;
    const dipped = FLAT.map((b, i) => (i === n - 1 ? { ...b, close: 94, low: 93.8, open: 99 } : b));
    const out = run("vwap_reversion", makeCtx({ bars: dipped, regime: RANGE }));
    expectLong(out);
    expect(run("vwap_reversion", makeCtx({ bars: dipped, regime: BULL })).signals).toEqual([]);
  });

  it("gap_normalization fades a quiet down gap but not an event gap", () => {
    const n = FLAT.length;
    const prev = FLAT[n - 2]!.close;
    const gapped = FLAT.map((b, i) => (i === n - 1 ? { ...b, open: prev * 0.97, close: prev * 0.972, high: prev * 0.975, low: prev * 0.965 } : b));
    const out = run("gap_normalization", makeCtx({ bars: gapped, regime: RANGE }));
    expectLong(out);
    expect(out.view!.targetPrice).toBeCloseTo(prev, 3);
    const ev = run("gap_normalization", makeCtx({ bars: gapped, regime: RANGE, upcomingEvents: [{ kind: "earnings", at: lastBarTime(gapped), description: "Q3" }] }));
    expect(ev.view?.explanation).toMatch(/news-driven/);
    const heavy = run("gap_normalization", makeCtx({ bars: gapped, regime: RANGE, features: { [FEATURE.relativeVolume20]: 5 } }));
    expect(heavy.signals).toEqual([]);
  });

  it("extreme_deviation_reversion buys a statistical washout", () => {
    const n = FLAT.length;
    const crashed = FLAT.map((b, i) => (i === n - 1 ? { ...b, close: 92, low: 91.5, open: 99 } : b));
    const out = run("extreme_deviation_reversion", makeCtx({ bars: crashed, regime: RANGE }));
    expectLong(out);
    expect(run("extreme_deviation_reversion", makeCtx({ bars: FLAT, regime: RANGE })).signals).toEqual([]);
  });
});

describe("statistical strategies", () => {
  it("factor_residual buys a large negative residual", () => {
    const out = run("factor_residual", makeCtx({ bars: UP, features: { [FEATURE.residualRet20]: -0.12, [FEATURE.beta60]: 1.1, [FEATURE.realizedVol20]: 0.2 }, regime: RANGE }));
    expectLong(out);
    expect(run("factor_residual", makeCtx({ bars: UP, regime: RANGE })).view?.explanation).toMatch(/beta/);
  });

  it("correlation_dislocation buys a laggard versus a correlated sector", () => {
    const ctx = makeCtx({ bars: UP, regime: RANGE, features: { [FEATURE.ret20]: -0.08, [FEATURE.corr60]: 0.85, [FEATURE.realizedVol20]: 0.2 }, sector: { name: "Tech", features: { [FEATURE.ret20]: 0.06 } } });
    expectLong(run("correlation_dislocation", ctx));
    const lowCorr = makeCtx({ bars: UP, regime: RANGE, features: { [FEATURE.ret20]: -0.06, [FEATURE.corr60]: 0.2 }, sector: { name: "Tech", features: { [FEATURE.ret20]: 0.05 } } });
    expect(run("correlation_dislocation", lowCorr).view?.explanation).toMatch(/correlation/);
  });

  it("cross_sectional_ranking buys the top of the composite", () => {
    const self = { [FEATURE.momentum12_1]: 0.9, [FEATURE.ret5]: -0.06, [FEATURE.realizedVol60]: 0.1, [FEATURE.trendTStat60]: 4 };
    expectLong(run("cross_sectional_ranking", makeCtx({ bars: UP, universe: universeOf(40, self), features: self })));
  });

  it("volatility_adjusted_anomaly buys steady risk-adjusted performance", () => {
    const steady = syntheticBars({ symbol: "TEST", bars: 320, drift: 0.002, vol: 0.006, seed: 14, start: START });
    expectLong(run("volatility_adjusted_anomaly", makeCtx({ bars: steady, regime: RANGE })));
    const wild = syntheticBars({ symbol: "TEST", bars: 320, drift: 0.002, vol: 0.05, seed: 14, start: START });
    expect(run("volatility_adjusted_anomaly", makeCtx({ bars: wild, regime: RANGE })).view?.explanation).toMatch(/vol/);
  });

  it("relative_value uses supplied valuation features and abstains otherwise", () => {
    expectLong(run("relative_value", makeCtx({ bars: UP, features: { [EXT_FEATURE.evSales]: 2, [EXT_FEATURE.evSalesSectorMedian]: 4 } })));
    expect(run("relative_value", makeCtx({ bars: UP })).view?.explanation).toMatch(/not supplied/);
  });
});

describe("event strategies", () => {
  it("earnings_reaction buys a strong volume-confirmed reaction and abstains without event features", () => {
    expectLong(run("earnings_reaction", makeCtx({ bars: UP, features: { [EXT_FEATURE.earningsReactionPct]: 0.08, [EXT_FEATURE.earningsDaysSince]: 1, [FEATURE.relativeVolume20]: 3 } })));
    expect(run("earnings_reaction", makeCtx({ bars: UP })).view?.explanation).toMatch(/not supplied/);
    const late = run("earnings_reaction", makeCtx({ bars: UP, features: { [EXT_FEATURE.earningsReactionPct]: 0.08, [EXT_FEATURE.earningsDaysSince]: 9 } }));
    expect(late.signals).toEqual([]);
  });

  it("earnings_drift rides a positive surprise", () => {
    expectLong(run("earnings_drift", makeCtx({ bars: UP, features: { [EXT_FEATURE.earningsSurprisePct]: 0.12, [EXT_FEATURE.earningsDaysSince]: 5, [EXT_FEATURE.postEarningsReturn]: 0.03 } })));
    expect(run("earnings_drift", makeCtx({ bars: UP })).signals).toEqual([]);
  });

  it("analyst_change acts on the supplied score with long-only semantics", () => {
    expectLong(run("analyst_change", makeCtx({ bars: UP, features: { [EXT_FEATURE.analystRevisionScore]: 0.8 } })));
    const negNoPos = run("analyst_change", makeCtx({ bars: UP, features: { [EXT_FEATURE.analystRevisionScore]: -0.8 } }));
    expect(negNoPos.view?.direction).toBe("flat");
    expect(negNoPos.signals[0]?.direction).toBe("short");
    const negPos = run("analyst_change", makeCtx({ bars: UP, features: { [EXT_FEATURE.analystRevisionScore]: -0.8 }, position: { quantity: 3, averageCost: 90, openedAt: START, strategyKey: null } }));
    expect(negPos.view?.direction).toBe("exit");
    expect(run("analyst_change", makeCtx({ bars: UP })).view?.explanation).toMatch(/not supplied/);
  });

  it("corporate_announcement and sector_news abstain without their features", () => {
    expectLong(run("corporate_announcement", makeCtx({ bars: UP, features: { [EXT_FEATURE.catalystScore]: 0.8 } })));
    expect(run("corporate_announcement", makeCtx({ bars: UP })).signals).toEqual([]);
    expectLong(run("sector_news", makeCtx({ bars: UP, features: { [EXT_FEATURE.sectorNewsScore]: 0.7 } })));
    expect(run("sector_news", makeCtx({ bars: UP })).signals).toEqual([]);
  });

  it("macro_release waits into a release and trims in a hostile regime", () => {
    const at = new Date(Date.parse(lastBarTime(UP)) + 86_400_000).toISOString();
    const wait = run("macro_release", makeCtx({ bars: UP, upcomingEvents: [{ kind: "macro_cpi", at, description: "CPI" }] }));
    expect(wait.view?.direction).toBe("flat");
    expect(wait.view?.explanation).toMatch(/Waiting/);
    expect(wait.view?.confidence).toBeGreaterThan(0);
    const trim = run("macro_release", makeCtx({ bars: UP, regime: RISK_OFF, upcomingEvents: [{ kind: "fomc", at, description: "FOMC" }], position: { quantity: 3, averageCost: 90, openedAt: START, strategyKey: null } }));
    expect(trim.view?.direction).toBe("reduce");
    expect(run("macro_release", makeCtx({ bars: UP })).signals).toEqual([]);
  });
});

describe("options_volatility", () => {
  const allFeatures = { [EXT_FEATURE.ivPercentile]: 15, [EXT_FEATURE.expectedMove]: 0.1, [EXT_FEATURE.termStructureSlope]: 0.08, [EXT_FEATURE.skew]: -0.02 };

  it("forms a view only with all four IV inputs", () => {
    const out = run("options_volatility", makeCtx({ bars: UP, features: allFeatures }));
    expect(out.signals.length).toBe(4);
    expect(out.view?.direction).toBe("long");
    const missing = run("options_volatility", makeCtx({ bars: UP, features: { ...allFeatures, [EXT_FEATURE.skew]: null } }));
    expect(missing.signals).toEqual([]);
    expect(missing.view?.explanation).toMatch(/skew/);
    expect(missing.view?.explanation).toMatch(/never inferred/);
  });

  it("rich, stressed volatility yields a negative view expressed as flat / reduce", () => {
    const rich = { [EXT_FEATURE.ivPercentile]: 95, [EXT_FEATURE.expectedMove]: 0.6, [EXT_FEATURE.termStructureSlope]: -0.1, [EXT_FEATURE.skew]: 0.2 };
    const noPos = run("options_volatility", makeCtx({ bars: UP, features: rich }));
    expect(noPos.view?.direction).toBe("flat");
    expect(noPos.view!.strength).toBeLessThan(0);
    const withPos = run("options_volatility", makeCtx({ bars: UP, features: rich, position: { quantity: 3, averageCost: 90, openedAt: START, strategyKey: null } }));
    expect(["reduce", "exit"]).toContain(withPos.view?.direction);
  });
});
