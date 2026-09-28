import type { StrategyDescriptor } from "../contract.js";
import { EXT_FEATURE, FEATURE, clamp, defineStrategy, eventWithin, fmtSigned, makeSignal, makeView, noSetup, pct, prepare, regimeAllows, universeRank } from "./helpers.js";

const STAT_REGIMES: StrategyDescriptor["supportedRegimes"] = ["range_bound", "low_volatility", "mean_reversion", "sector_rotation", "bull_trend", "risk_on"];

/** Horizon-scaled volatility of a 20-day return from annualised vol. */
function vol20(prepVol: number | null): number {
  return prepVol === null || prepVol <= 0 ? 0.08 : prepVol * Math.sqrt(20 / 252);
}

/* ------------------------------------------------------------------------------------------ */
/* factor_residual                                                                            */
/* ------------------------------------------------------------------------------------------ */
export const factorResidual = defineStrategy(
  {
    key: "factor_residual",
    name: "Factor Residual Reversion",
    family: "statistical",
    description: "Trades the residual of the 20-day return after removing beta × benchmark: a large negative residual is bought, a large positive residual reduces a held position.",
    supportedRegimes: STAT_REGIMES,
    parameters: {
      entryZ: { default: 1.5, min: 1, max: 3, step: 0.1, description: "Residual in units of expected 20d vol required to act" },
      horizonDays: { default: 10, min: 3, max: 30, step: 1, description: "Holding horizon" },
    },
    warmupBars: 81,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = factorResidual.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const resid = prep.f(FEATURE.residualRet20);
    const b = prep.f(FEATURE.beta60);
    if (resid === null || b === null) return noSetup("benchmark beta / residual unavailable", horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    if (eventWithin(ctx, horizon, ["earnings"])) return noSetup("earnings inside the horizon", horizon);
    const z = resid / vol20(prep.f(FEATURE.realizedVol20));
    const entry = prep.p("entryZ");
    if (z <= -entry) {
      const strength = clamp((-z - entry) / entry + 0.4, 0.3, 1);
      const confidence = clamp(0.45 + 0.15 * clamp((-z - entry) / entry, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `20d residual return ${fmtSigned(resid * 100, 1)}% (beta ${b.toFixed(2)}) is ${z.toFixed(1)} vol-units below expectation; expecting the idiosyncratic move to partly revert.`;
      return { signals: [makeSignal(ctx, prep, "factor_residual_z", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (z >= entry) {
      const strength = -clamp((z - entry) / entry + 0.4, 0.3, 1);
      const explanation = `20d residual return ${fmtSigned(resid * 100, 1)}% is ${z.toFixed(1)} vol-units above expectation.`;
      return { signals: [makeSignal(ctx, prep, "factor_residual_z", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`residual z ${z.toFixed(2)} inside ±${entry}`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* correlation_dislocation                                                                    */
/* ------------------------------------------------------------------------------------------ */
export const correlationDislocation = defineStrategy(
  {
    key: "correlation_dislocation",
    name: "Correlation Dislocation vs Sector",
    family: "statistical",
    description: "Pair-like trade against the sector ETF: when a historically correlated name lags its sector by more than two expected deviations it is bought; when it leads by as much a held position is reduced.",
    supportedRegimes: STAT_REGIMES,
    parameters: {
      minCorrelation: { default: 0.6, min: 0.3, max: 0.95, step: 0.05, description: "Minimum 60d correlation with the benchmark for the pair to be meaningful" },
      entryZ: { default: 2, min: 1, max: 4, step: 0.1, description: "Spread in units of expected 20d vol required to act" },
      horizonDays: { default: 10, min: 3, max: 30, step: 1, description: "Holding horizon" },
    },
    warmupBars: 81,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = correlationDislocation.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const sectorRet = ctx.sector?.features[FEATURE.ret20] ?? null;
    const own = prep.f(FEATURE.ret20);
    const corr = prep.f(FEATURE.corr60);
    if (!ctx.sector || sectorRet === null || !Number.isFinite(sectorRet) || own === null) return noSetup("sector 20d return unavailable", horizon);
    if (corr !== null && corr < prep.p("minCorrelation")) return noSetup(`60d correlation ${corr.toFixed(2)} too low for a pair relationship`, horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    if (eventWithin(ctx, horizon, ["earnings"])) return noSetup("earnings inside the horizon", horizon);
    const spread = own - sectorRet;
    const z = spread / vol20(prep.f(FEATURE.realizedVol20));
    const entry = prep.p("entryZ");
    if (z <= -entry) {
      const strength = clamp((-z - entry) / entry + 0.4, 0.3, 1);
      const confidence = clamp(0.45 + 0.15 * clamp((-z - entry) / entry, 0, 1) + 0.1 * (corr ?? 0.6) + 0.1 * prep.regimeFit, 0, 1);
      const explanation = `${ctx.symbol} lags sector ${ctx.sector.name} by ${fmtSigned(spread * 100, 1)}% over 20 days (${z.toFixed(1)} vol-units) despite 60d correlation ${(corr ?? NaN).toFixed(2)}; expecting convergence.`;
      return { signals: [makeSignal(ctx, prep, "sector_spread_z", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (z >= entry) {
      const strength = -clamp((z - entry) / entry + 0.4, 0.3, 1);
      const explanation = `${ctx.symbol} leads sector ${ctx.sector.name} by ${fmtSigned(spread * 100, 1)}% over 20 days (${z.toFixed(1)} vol-units).`;
      return { signals: [makeSignal(ctx, prep, "sector_spread_z", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`sector spread z ${z.toFixed(2)} inside ±${entry}`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* cross_sectional_ranking                                                                    */
/* ------------------------------------------------------------------------------------------ */
export const crossSectionalRanking = defineStrategy(
  {
    key: "cross_sectional_ranking",
    name: "Composite Cross-Sectional Ranking",
    family: "statistical",
    description: "Composite rank of momentum, short-term reversal, low volatility and trend quality across the universe; top quintile is bought, bottom quintile reduced when held.",
    supportedRegimes: STAT_REGIMES,
    parameters: {
      topFraction: { default: 0.8, min: 0.6, max: 0.95, step: 0.05, description: "Composite percentile above which a name is bought" },
      bottomFraction: { default: 0.2, min: 0.05, max: 0.4, step: 0.05, description: "Composite percentile below which a held name is reduced" },
      minUniverse: { default: 20, min: 10, max: 500, step: 5, description: "Minimum universe size" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 253,
    interval: "day",
    needsUniverse: true,
  },
  (ctx) => {
    const d = crossSectionalRanking.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const min = prep.p("minUniverse");
    const mom = universeRank(ctx, FEATURE.momentum12_1, min);
    const rev = universeRank(ctx, FEATURE.ret5, min);
    const vol = universeRank(ctx, FEATURE.realizedVol60, min);
    const trend = universeRank(ctx, FEATURE.trendTStat60, min);
    if (!mom) return noSetup("universe momentum ranks unavailable", horizon);
    const composite = 0.4 * mom.rank + 0.2 * (rev ? 1 - rev.rank : 0.5) + 0.2 * (vol ? 1 - vol.rank : 0.5) + 0.2 * (trend ? trend.rank : 0.5);
    const top = prep.p("topFraction");
    const bottom = prep.p("bottomFraction");
    if (composite >= top) {
      const depth = (composite - top) / Math.max(1e-9, 1 - top);
      const strength = clamp(0.5 + 0.5 * depth, 0, 1);
      const confidence = clamp(0.45 + 0.2 * depth + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Composite rank ${pct(composite, 0)} of ${mom.size} names (momentum ${pct(mom.rank, 0)}, reversal ${rev ? pct(1 - rev.rank, 0) : "n/a"}, low-vol ${vol ? pct(1 - vol.rank, 0) : "n/a"}, trend ${trend ? pct(trend.rank, 0) : "n/a"}).`;
      return { signals: [makeSignal(ctx, prep, "composite_rank", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (composite <= bottom) {
      const strength = -clamp(0.4 + 0.6 * (bottom - composite) / Math.max(bottom, 1e-9), 0, 1);
      const explanation = `Composite rank ${pct(composite, 0)} of ${mom.size} names: bottom quintile.`;
      return { signals: [makeSignal(ctx, prep, "composite_rank", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`composite rank ${pct(composite, 0)} is mid-pack`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* volatility_adjusted_anomaly                                                                */
/* ------------------------------------------------------------------------------------------ */
export const volatilityAdjustedAnomaly = defineStrategy(
  {
    key: "volatility_adjusted_anomaly",
    name: "Low-Volatility Risk-Adjusted Momentum",
    family: "statistical",
    description: "Buys names with a high risk-adjusted 60-day return (return / annualised vol) and moderate volatility; the low-vol anomaly.",
    supportedRegimes: STAT_REGIMES,
    parameters: {
      minRiskAdjusted: { default: 0.5, min: 0.1, max: 2, step: 0.05, description: "Minimum 60d return divided by annualised 60d vol" },
      maxVol: { default: 0.35, min: 0.1, max: 0.8, step: 0.05, description: "Maximum annualised 60d vol" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 61,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = volatilityAdjustedAnomaly.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const ret = prep.f(FEATURE.ret60);
    const vol = prep.f(FEATURE.realizedVol60);
    if (ret === null || vol === null || vol <= 0) return noSetup("60d return or vol unavailable", horizon);
    const ra = ret / vol;
    if (vol > prep.p("maxVol")) return noSetup(`annualised vol ${pct(vol, 0)} above the ${pct(prep.p("maxVol"), 0)} cap`, horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (ra >= prep.p("minRiskAdjusted")) {
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      const strength = clamp(ra / (2 * prep.p("minRiskAdjusted")), 0.3, 1) * clamp(1 - vol / prep.p("maxVol") + 0.5, 0.5, 1);
      const confidence = clamp(0.45 + 0.15 * clamp(ra / 1.5, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Risk-adjusted 60d return ${ra.toFixed(2)} (${fmtSigned(ret * 100, 1)}% on ${pct(vol, 0)} vol): quiet, steady outperformance.`;
      return { signals: [makeSignal(ctx, prep, "risk_adjusted_return_60", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (ra <= -prep.p("minRiskAdjusted")) {
      const strength = -clamp(-ra / (2 * prep.p("minRiskAdjusted")), 0.3, 1);
      const explanation = `Risk-adjusted 60d return ${ra.toFixed(2)}: steady underperformance.`;
      return { signals: [makeSignal(ctx, prep, "risk_adjusted_return_60", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`risk-adjusted return ${ra.toFixed(2)} below threshold`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* relative_value                                                                             */
/* ------------------------------------------------------------------------------------------ */
export const relativeValue = defineStrategy(
  {
    key: "relative_value",
    name: "Sector-Relative Valuation",
    family: "statistical",
    description: "Buys names trading at a clear EV/Sales discount to their sector median when their trend is not broken; abstains unless valuation features are supplied.",
    supportedRegimes: ["range_bound", "low_volatility", "sector_rotation", "bull_trend", "risk_on", "mean_reversion"],
    parameters: {
      minDiscount: { default: 0.25, min: 0.05, max: 0.6, step: 0.05, description: "Minimum discount to the sector median EV/Sales (fraction)" },
      horizonDays: { default: 40, min: 10, max: 120, step: 5, description: "Holding horizon" },
    },
    warmupBars: 60,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = relativeValue.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const ev = prep.f(EXT_FEATURE.evSales);
    const median = prep.f(EXT_FEATURE.evSalesSectorMedian) ?? ctx.sector?.features[EXT_FEATURE.evSales] ?? null;
    if (ev === null || median === null || !Number.isFinite(median) || median <= 0 || ev <= 0) return noSetup(`valuation features (${EXT_FEATURE.evSales}, ${EXT_FEATURE.evSalesSectorMedian}) not supplied; nothing invented`, horizon);
    const discount = 1 - ev / median;
    const t = prep.f(FEATURE.trendTStat60);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (discount >= prep.p("minDiscount")) {
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      if (t !== null && t < -2) return noSetup(`cheap (${pct(discount, 0)} discount) but the trend is broken (t=${t.toFixed(1)}); avoiding a value trap`, horizon);
      const strength = clamp(discount / (2 * prep.p("minDiscount")), 0.3, 1);
      const confidence = clamp(0.4 + 0.15 * clamp(discount / 0.5, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `EV/Sales ${ev.toFixed(2)} versus sector median ${median.toFixed(2)}: ${pct(discount, 0)} discount with an intact trend.`;
      return { signals: [makeSignal(ctx, prep, "ev_sales_discount", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (discount <= -prep.p("minDiscount") * 2) {
      const strength = -clamp(-discount / 1, 0.3, 1);
      const explanation = `EV/Sales ${ev.toFixed(2)} is ${pct(-discount, 0)} above the sector median ${median.toFixed(2)}.`;
      return { signals: [makeSignal(ctx, prep, "ev_sales_discount", strength, 0.45, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.45, horizonDays: horizon, explanation }) };
    }
    return noSetup(`valuation ${fmtSigned(discount * 100, 0)}% versus sector median is unremarkable`, horizon);
  },
);

export const STATISTICAL_STRATEGIES = [factorResidual, correlationDislocation, crossSectionalRanking, volatilityAdjustedAnomaly, relativeValue];
