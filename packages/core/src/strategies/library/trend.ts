import type { StrategyDescriptor } from "../contract.js";
import { FEATURE, clamp, defineStrategy, eventWithin, fmtSigned, hasPosition, makeSignal, makeView, noSetup, pct, prepare, regimeAllows, universeRank } from "./helpers.js";
import { highestHigh } from "../../features/indicators.js";

const TREND_REGIMES: StrategyDescriptor["supportedRegimes"] = ["bull_trend", "momentum", "risk_on", "low_volatility", "sector_rotation"];

/* ------------------------------------------------------------------------------------------ */
/* cross_sectional_momentum                                                                   */
/* ------------------------------------------------------------------------------------------ */
export const crossSectionalMomentum = defineStrategy(
  {
    key: "cross_sectional_momentum",
    name: "Cross-Sectional Momentum",
    family: "trend_momentum",
    description: "Ranks the universe on 12-1 month momentum and goes long names in the top decile; names in the bottom decile are reduced when held.",
    supportedRegimes: TREND_REGIMES,
    parameters: {
      lookbackKey: { default: FEATURE.momentum12_1, description: "Feature used for ranking" },
      topFraction: { default: 0.9, min: 0.7, max: 0.98, step: 0.02, description: "Percentile above which a name is a long candidate" },
      bottomFraction: { default: 0.1, min: 0.02, max: 0.3, step: 0.02, description: "Percentile below which a held name is reduced" },
      minUniverse: { default: 20, min: 10, max: 500, step: 5, description: "Minimum universe size for a meaningful rank" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 253,
    interval: "day",
    needsUniverse: true,
  },
  (ctx) => {
    const d = crossSectionalMomentum.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const key = String(ctx.parameters["lookbackKey"] ?? FEATURE.momentum12_1);
    const rk = universeRank(ctx, key, prep.p("minUniverse"));
    if (!rk) return noSetup(`universe rank unavailable for ${key} (need ${prep.p("minUniverse")} names with values)`, horizon);
    const top = prep.p("topFraction");
    const bottom = prep.p("bottomFraction");
    const mom = prep.f(key) ?? 0;
    if (rk.rank >= top && mom > 0) {
      const depth = (rk.rank - top) / Math.max(1e-9, 1 - top);
      const strength = clamp(0.5 + 0.5 * depth, 0, 1);
      const confidence = clamp(0.5 + 0.25 * depth + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `${ctx.symbol} ranks in the ${pct(rk.rank, 0)} percentile of ${rk.size} names on 12-1 momentum (${fmtSigned(mom * 100, 1)}%); ${gate.reason}.`;
      return {
        signals: [makeSignal(ctx, prep, "xs_momentum_rank", strength, confidence, horizon, explanation)],
        view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }),
      };
    }
    if (rk.rank <= bottom) {
      const strength = -clamp(0.4 + 0.6 * (bottom - rk.rank) / Math.max(bottom, 1e-9), 0, 1);
      const explanation = `${ctx.symbol} ranks in the bottom ${pct(bottom, 0)} of the universe on 12-1 momentum (${fmtSigned(mom * 100, 1)}%)${hasPosition(ctx) ? "; held position should be reduced" : ""}.`;
      return {
        signals: [makeSignal(ctx, prep, "xs_momentum_rank", strength, 0.5, horizon, explanation)],
        view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }),
      };
    }
    return noSetup(`rank ${pct(rk.rank, 0)} is not in a tail decile`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* time_series_momentum                                                                       */
/* ------------------------------------------------------------------------------------------ */
export const timeSeriesMomentum = defineStrategy(
  {
    key: "time_series_momentum",
    name: "Time-Series Momentum",
    family: "trend_momentum",
    description: "Long when the symbol's own 12-1 momentum is positive, the 60-day trend is statistically significant and price is above its 200-day average.",
    supportedRegimes: TREND_REGIMES,
    parameters: {
      minMomentum: { default: 0.05, min: 0, max: 0.3, step: 0.01, description: "Minimum 12-1 return to act" },
      minTStat: { default: 2, min: 1, max: 4, step: 0.25, description: "Minimum 60-day slope t-statistic" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 253,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = timeSeriesMomentum.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "soft");
    const mom = prep.f(FEATURE.momentum12_1);
    const t = prep.f(FEATURE.trendTStat60);
    const sma200 = prep.f(FEATURE.sma200);
    if (mom === null || t === null || sma200 === null) return noSetup("momentum, trend t-stat or 200d average unavailable", horizon);
    const aboveSma = prep.lastClose > sma200;
    const minMom = prep.p("minMomentum");
    const minT = prep.p("minTStat");
    if (mom >= minMom && t >= minT && aboveSma) {
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      const strength = clamp(mom / 0.3, 0, 1) * clamp(t / (2 * minT), 0.5, 1);
      const confidence = clamp(0.45 + 0.2 * clamp(t / 4, 0, 1) + 0.2 * prep.regimeFit, 0, 1);
      const explanation = `12-1 momentum ${fmtSigned(mom * 100, 1)}% with 60d trend t-stat ${t.toFixed(1)} and price above its 200d average.`;
      const signals = [
        makeSignal(ctx, prep, "ts_momentum_12_1", clamp(mom / 0.3, -1, 1), confidence, horizon, `12-1 momentum ${fmtSigned(mom * 100, 1)}%`),
        makeSignal(ctx, prep, "trend_tstat_60", clamp(t / 4, -1, 1), confidence, horizon, `60d slope t-stat ${t.toFixed(2)}`),
      ];
      return { signals, view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation, invalidationPrice: sma200 }) };
    }
    if (mom <= -minMom && !aboveSma && t <= -minT) {
      const strength = -clamp(-mom / 0.3, 0.3, 1);
      const explanation = `Negative time-series momentum (${fmtSigned(mom * 100, 1)}%), price below its 200d average, trend t-stat ${t.toFixed(1)}.`;
      return {
        signals: [makeSignal(ctx, prep, "ts_momentum_12_1", clamp(mom / 0.3, -1, 1), 0.5, horizon, explanation)],
        view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }),
      };
    }
    return noSetup(`momentum ${fmtSigned(mom * 100, 1)}%, t-stat ${t.toFixed(1)}, ${aboveSma ? "above" : "below"} 200d average: conditions not met`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* relative_strength                                                                          */
/* ------------------------------------------------------------------------------------------ */
export const relativeStrength = defineStrategy(
  {
    key: "relative_strength",
    name: "Relative Strength vs Sector / Market",
    family: "trend_momentum",
    description: "Long names outperforming their sector ETF (or the market when no sector is known) over 60 days while their own trend is positive.",
    supportedRegimes: [...TREND_REGIMES, "range_bound"],
    parameters: {
      minRelative: { default: 0.05, min: 0.01, max: 0.3, step: 0.01, description: "Minimum 60d outperformance versus the benchmark" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 61,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = relativeStrength.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const own = prep.f(FEATURE.ret60);
    const benchRet = ctx.sector?.features[FEATURE.ret60] ?? null;
    let relative: number | null = null;
    let benchName = "";
    if (own !== null && benchRet !== null && Number.isFinite(benchRet)) {
      relative = own - benchRet; benchName = `sector ${ctx.sector?.name ?? ""}`;
    } else if (own !== null && prep.f(FEATURE.beta60) !== null && prep.f(FEATURE.residualRet20) !== null) {
      relative = (prep.f(FEATURE.residualRet20) as number) * 3; benchName = "market (beta-adjusted, 20d scaled)";
    }
    if (own === null || relative === null) return noSetup("no sector or market benchmark return available", horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    const minRel = prep.p("minRelative");
    if (relative >= minRel && own > 0) {
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      const strength = clamp(relative / 0.2, 0.2, 1);
      const confidence = clamp(0.45 + 0.2 * clamp(relative / 0.2, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `${ctx.symbol} outperformed the ${benchName} by ${fmtSigned(relative * 100, 1)}% over 60 days (own return ${fmtSigned(own * 100, 1)}%).`;
      return { signals: [makeSignal(ctx, prep, "relative_strength_60", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (relative <= -minRel && own < 0) {
      const strength = -clamp(-relative / 0.2, 0.2, 1);
      const explanation = `${ctx.symbol} underperformed the ${benchName} by ${fmtSigned(relative * 100, 1)}% over 60 days.`;
      return { signals: [makeSignal(ctx, prep, "relative_strength_60", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`relative performance ${fmtSigned(relative * 100, 1)}% within the ±${pct(minRel, 0)} band`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* breakout_continuation                                                                      */
/* ------------------------------------------------------------------------------------------ */
export const breakoutContinuation = defineStrategy(
  {
    key: "breakout_continuation",
    name: "Volume-Confirmed Breakout",
    family: "trend_momentum",
    description: "Long on a close above the prior 20/55-day range with volume confirmation, trend strength and market breadth support; failed breakouts are reduced.",
    supportedRegimes: ["bull_trend", "momentum", "risk_on"],
    parameters: {
      minRelativeVolume: { default: 1.5, min: 1, max: 4, step: 0.1, description: "Volume multiple of the 20d average required" },
      minAdx: { default: 20, min: 10, max: 40, step: 1, description: "Minimum ADX(14) for trend strength" },
      minBreadth: { default: 45, min: 20, max: 80, step: 5, description: "Minimum % of stocks above their 50d average (when breadth is known)" },
      horizonDays: { default: 10, min: 3, max: 30, step: 1, description: "Holding horizon" },
    },
    warmupBars: 60,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = breakoutContinuation.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const failed = prep.f(FEATURE.failedBreakout);
    if (failed === 1) {
      const explanation = "Recent breakout above the 20-day high failed: price closed back inside the range.";
      const strength = -0.6;
      return { signals: [makeSignal(ctx, prep, "failed_breakout", strength, 0.55, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.55, horizonDays: horizon, explanation }) };
    }
    const hh20 = highestHigh(prep.bars, 20);
    const hh55 = highestHigh(prep.bars, 55);
    const rv = prep.f(FEATURE.relativeVolume20);
    const adx = prep.f(FEATURE.adx14);
    if (hh20 === null || rv === null) return noSetup("range high or volume features unavailable", horizon);
    const b20 = prep.lastClose > hh20 ? 1 : 0;
    const b55 = hh55 !== null && prep.lastClose > hh55 ? 1 : 0;
    if (b20 !== 1 && b55 !== 1) return noSetup("no close above the prior 20/55-day high", horizon);
    if (rv < prep.p("minRelativeVolume")) return noSetup(`relative volume ${rv.toFixed(2)}x below the ${prep.p("minRelativeVolume")}x confirmation threshold`, horizon);
    if (adx !== null && adx < prep.p("minAdx")) return noSetup(`ADX ${adx.toFixed(0)} below ${prep.p("minAdx")}: no trend strength behind the breakout`, horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const breadth = ctx.regime.metrics.breadthPctAbove50;
    if (breadth !== null && breadth < prep.p("minBreadth")) return noSetup(`market breadth ${breadth.toFixed(0)}% below ${prep.p("minBreadth")}%`, horizon);
    const level = (b55 === 1 ? hh55 : hh20) ?? prep.lastClose;
    const atr = prep.f(FEATURE.atr14) ?? prep.lastClose * 0.02;
    const strength = clamp(0.5 + 0.2 * (b55 === 1 ? 1 : 0) + 0.3 * clamp((rv - 1.5) / 1.5, 0, 1), 0, 1);
    const confidence = clamp(0.45 + 0.15 * clamp((rv - 1.5) / 2, 0, 1) + 0.1 * (adx !== null ? clamp((adx - 20) / 20, 0, 1) : 0) + 0.15 * prep.regimeFit, 0, 1);
    const explanation = `Close ${prep.lastClose.toFixed(2)} broke above the prior ${b55 === 1 ? "55" : "20"}-day high ${level.toFixed(2)} on ${rv.toFixed(1)}x volume${adx === null ? "" : `, ADX ${adx.toFixed(0)}`}${breadth === null ? "" : `, breadth ${breadth.toFixed(0)}%`}.`;
    return {
      signals: [
        makeSignal(ctx, prep, b55 === 1 ? "breakout_55" : "breakout_20", strength, confidence, horizon, explanation),
        makeSignal(ctx, prep, "volume_confirmation", clamp((rv - 1) / 3, 0, 1), confidence, horizon, `Relative volume ${rv.toFixed(2)}x`),
      ],
      // Stop one ATR under the breakout level; the target is the larger of a two-ATR measured
      // move and 1.5x the stop distance, so an extended breakout is not bought at a poor reward/risk.
      view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation, invalidationPrice: level - atr, targetPrice: prep.lastClose + Math.max(2 * atr, 1.5 * (prep.lastClose - (level - atr))) }),
    };
  },
);

/* ------------------------------------------------------------------------------------------ */
/* sector_momentum                                                                            */
/* ------------------------------------------------------------------------------------------ */
export const sectorMomentum = defineStrategy(
  {
    key: "sector_momentum",
    name: "Sector Momentum",
    family: "trend_momentum",
    description: "Long names in sectors with strong 60-day momentum when the name itself confirms with positive momentum.",
    supportedRegimes: [...TREND_REGIMES],
    parameters: {
      minSectorReturn: { default: 0.04, min: 0, max: 0.2, step: 0.01, description: "Minimum sector 60d return" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 61,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = sectorMomentum.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const sector = ctx.sector;
    const sectorRet = sector?.features[FEATURE.ret60] ?? null;
    if (!sector || sectorRet === null || !Number.isFinite(sectorRet)) return noSetup("sector benchmark features unavailable", horizon);
    const own = prep.f(FEATURE.ret60);
    if (own === null) return noSetup("own 60d return unavailable", horizon);
    const minSector = prep.p("minSectorReturn");
    if (sectorRet >= minSector && own > 0) {
      const gate = regimeAllows(ctx, d, prep, "soft");
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      const strength = clamp(sectorRet / 0.15, 0.2, 1) * clamp(0.5 + own / 0.2, 0.5, 1);
      const confidence = clamp(0.45 + 0.2 * clamp(sectorRet / 0.15, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Sector ${sector.name} returned ${fmtSigned(sectorRet * 100, 1)}% over 60 days and ${ctx.symbol} confirms with ${fmtSigned(own * 100, 1)}%.`;
      return { signals: [makeSignal(ctx, prep, "sector_momentum_60", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (sectorRet <= -minSector && own < 0) {
      const strength = -clamp(-sectorRet / 0.15, 0.2, 1);
      const explanation = `Sector ${sector.name} is weak (${fmtSigned(sectorRet * 100, 1)}% over 60 days) and ${ctx.symbol} is following.`;
      return { signals: [makeSignal(ctx, prep, "sector_momentum_60", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`sector return ${fmtSigned(sectorRet * 100, 1)}% / own ${fmtSigned(own * 100, 1)}% do not line up`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* multi_timeframe_confirmation                                                               */
/* ------------------------------------------------------------------------------------------ */
export const multiTimeframeConfirmation = defineStrategy(
  {
    key: "multi_timeframe_confirmation",
    name: "Multi-Timeframe Confirmation",
    family: "trend_momentum",
    description: "Long when the daily trend, the intraday trend and price versus intraday VWAP all agree; disagreement produces no entry.",
    supportedRegimes: [...TREND_REGIMES],
    parameters: {
      minDailyTStat: { default: 2, min: 1, max: 4, step: 0.25, description: "Minimum daily 20d slope t-stat" },
      minIntradayTStat: { default: 1.5, min: 0.5, max: 4, step: 0.25, description: "Minimum intraday slope t-stat" },
      maxVwapDeviationPct: { default: 0.5, min: 0.1, max: 2, step: 0.1, description: "No entry when price is further above intraday VWAP than this (%): buying an extended intraday run is chasing" },
      horizonDays: { default: 5, min: 1, max: 20, step: 1, description: "Holding horizon" },
    },
    warmupBars: 30,
    interval: "5minute",
    needsUniverse: false,
  },
  (ctx) => {
    const d = multiTimeframeConfirmation.descriptor;
    const r = prepare(ctx, d, { needsIntraday: true });
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const align = prep.f(FEATURE.mtfAlignment);
    const dt = prep.f(FEATURE.trendTStat20);
    const it = prep.f(FEATURE.intradayTrendTStat);
    const vdev = prep.f(FEATURE.vwapDeviationPct);
    if (align === null || dt === null || it === null) return noSetup("timeframe alignment features unavailable", horizon);
    if (eventWithin(ctx, horizon, ["earnings"])) return noSetup("earnings inside the horizon", horizon);
    if (align === 1 && dt >= prep.p("minDailyTStat") && it >= prep.p("minIntradayTStat") && (vdev === null || vdev >= 0)) {
      if (vdev !== null && vdev * 100 > prep.p("maxVwapDeviationPct")) return noSetup(`price ${fmtSigned(vdev * 100, 2)}% above intraday VWAP: extended, entry would chase the run`, horizon);
      const gate = regimeAllows(ctx, d, prep, "soft");
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      const strength = clamp(0.4 + 0.3 * clamp(dt / 4, 0, 1) + 0.3 * clamp(it / 4, 0, 1), 0, 1);
      const confidence = clamp(0.5 + 0.15 * clamp(dt / 4, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Daily trend (t=${dt.toFixed(1)}) and intraday trend (t=${it.toFixed(1)}) agree and price is ${vdev === null ? "at" : `${fmtSigned(vdev * 100, 2)}% versus`} intraday VWAP.`;
      return {
        signals: [
          makeSignal(ctx, prep, "mtf_alignment", strength, confidence, horizon, explanation),
          makeSignal(ctx, prep, "trend_tstat_20", clamp(dt / 4, -1, 1), confidence, horizon, `Daily 20d t-stat ${dt.toFixed(2)}`),
        ],
        view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }),
      };
    }
    if (align === -1 && dt <= -prep.p("minDailyTStat") && it <= -prep.p("minIntradayTStat")) {
      const strength = -clamp(0.4 + 0.3 * clamp(-dt / 4, 0, 1), 0, 1);
      const explanation = `Daily and intraday trends both point down (t=${dt.toFixed(1)} / ${it.toFixed(1)}).`;
      return { signals: [makeSignal(ctx, prep, "mtf_alignment", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`timeframes disagree or are weak (daily t=${dt.toFixed(1)}, intraday t=${it.toFixed(1)}, alignment ${align})`, horizon);
  },
);

export const TREND_STRATEGIES = [crossSectionalMomentum, timeSeriesMomentum, relativeStrength, breakoutContinuation, sectorMomentum, multiTimeframeConfirmation];
