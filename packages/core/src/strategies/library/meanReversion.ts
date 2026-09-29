import type { StrategyDescriptor } from "../contract.js";
import { adx as adxOf } from "../../features/indicators.js";
import { EXT_FEATURE, FEATURE, clamp, defineStrategy, eventWithin, fmtSigned, makeSignal, makeView, noSetup, partialTarget, pct, prepare, recentEvent, regimeAllows, type Prepared } from "./helpers.js";
import type { StrategyContext } from "../contract.js";

/** Days after an earnings report in which a selloff is treated as information, not noise. */
const POST_EARNINGS_DAYS = 15;
/** 20-day return t-stat at or below which a decline is a steady slide (a falling knife), not a stretch. */
const FALLING_KNIFE_T = -2;

/**
 * Guards every daily mean-reversion entry shares. Reversion works on noise-driven stretches; it
 * fails on information-driven moves. So no entry around earnings (the report inside the horizon,
 * or one in the last 15 days whose repricing may still be running) and none in a statistically
 * steady decline. Returns the reason to stand aside, or null.
 */
function reversionGuard(ctx: StrategyContext, prep: Prepared, horizon: number): string | null {
  if (eventWithin(ctx, horizon, ["earnings"])) return "earnings inside the horizon";
  const past = recentEvent(ctx, POST_EARNINGS_DAYS, ["earnings"]);
  const sinceFeature = prep.f(EXT_FEATURE.earningsDaysSince);
  if (past) return `earnings ${past.daysAgo.toFixed(0)} day(s) ago: a post-earnings move is repricing, not noise`;
  if (sinceFeature !== null && sinceFeature >= 0 && sinceFeature <= POST_EARNINGS_DAYS) return `earnings ${sinceFeature.toFixed(0)} day(s) ago: a post-earnings move is repricing, not noise`;
  const t20 = prep.f(FEATURE.trendTStat20);
  if (t20 !== null && t20 <= FALLING_KNIFE_T) return `steady decline (20d return t-stat ${t20.toFixed(1)}): a falling knife, not a stretch`;
  return null;
}

/**
 * Mean-reversion strategies only fire when the regime favours mean reversion: range-bound,
 * low-volatility or explicitly mean-reverting markets. They use the strict regime gate.
 */
const MR_REGIMES: StrategyDescriptor["supportedRegimes"] = ["range_bound", "low_volatility", "mean_reversion"];

/* ------------------------------------------------------------------------------------------ */
/* intraday_mean_reversion                                                                    */
/* ------------------------------------------------------------------------------------------ */
export const intradayMeanReversion = defineStrategy(
  {
    key: "intraday_mean_reversion",
    name: "Intraday Mean Reversion to VWAP",
    family: "mean_reversion",
    description: "Long when price is stretched well below intraday VWAP in a calm, range-bound market and the daily trend is not falling; stretched above VWAP reduces a held position.",
    supportedRegimes: MR_REGIMES,
    parameters: {
      entryDeviationPct: { default: 0.01, min: 0.003, max: 0.05, step: 0.001, description: "Minimum shortfall below intraday VWAP (fraction)" },
      exitDeviationPct: { default: 0.015, min: 0.005, max: 0.08, step: 0.001, description: "Excess above VWAP that reduces a position (fraction)" },
      maxDailyDowntrendT: { default: -1, min: -4, max: 0, step: 0.25, description: "Abstain when the daily 20d t-stat is below this" },
      horizonDays: { default: 1, min: 1, max: 3, step: 1, description: "Holding horizon" },
    },
    warmupBars: 25,
    interval: "5minute",
    needsUniverse: false,
  },
  (ctx) => {
    const d = intradayMeanReversion.descriptor;
    const r = prepare(ctx, d, { needsIntraday: true });
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "strict");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const dev = prep.f(FEATURE.vwapDeviationPct);
    const dailyT = prep.f(FEATURE.trendTStat20);
    if (dev === null) return noSetup("intraday VWAP deviation unavailable", horizon);
    if (dailyT !== null && dailyT < prep.p("maxDailyDowntrendT")) return noSetup(`daily trend is falling (t=${dailyT.toFixed(1)}); not fading weakness`, horizon);
    if (eventWithin(ctx, 1, ["earnings"])) return noSetup("earnings within a day", horizon);
    const pastEarnings = recentEvent(ctx, POST_EARNINGS_DAYS, ["earnings"]);
    if (pastEarnings) return noSetup(`earnings ${pastEarnings.daysAgo.toFixed(0)} day(s) ago: a post-earnings move is repricing, not noise`, horizon);
    const entry = prep.p("entryDeviationPct");
    if (dev <= -entry) {
      const strength = clamp((-dev) / (3 * entry), 0.3, 1);
      const confidence = clamp(0.45 + 0.2 * clamp((-dev - entry) / (2 * entry), 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Price is ${fmtSigned(dev * 100, 2)}% versus intraday VWAP in a ${ctx.regime.primary} regime; expecting a reversion toward VWAP.`;
      const vw = prep.f(FEATURE.vwapIntraday);
      return {
        signals: [makeSignal(ctx, prep, "vwap_zscore_intraday", strength, confidence, horizon, explanation)],
        view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation, targetPrice: vw, upside: -dev, downside: Math.max(entry, -dev) }),
      };
    }
    if (dev >= prep.p("exitDeviationPct")) {
      const strength = -clamp(dev / (3 * entry), 0.3, 1);
      const explanation = `Price is ${fmtSigned(dev * 100, 2)}% above intraday VWAP; stretched.`;
      return { signals: [makeSignal(ctx, prep, "vwap_zscore_intraday", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`VWAP deviation ${fmtSigned(dev * 100, 2)}% inside the ±${pct(entry, 1)} band`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* short_term_oversold_recovery                                                               */
/* ------------------------------------------------------------------------------------------ */
export const shortTermOversoldRecovery = defineStrategy(
  {
    key: "short_term_oversold_recovery",
    name: "Short-Term Oversold Recovery",
    family: "mean_reversion",
    description: "Buys short-term oversold conditions (RSI or 5-day z-score) in names that remain above their 200-day average.",
    supportedRegimes: [...MR_REGIMES, "bull_trend"],
    parameters: {
      rsiThreshold: { default: 30, min: 15, max: 40, step: 1, description: "RSI(14) at or below which the name is oversold" },
      zThreshold: { default: -2, min: -4, max: -1, step: 0.1, description: "5-day z-score at or below which the name is oversold" },
      reversionFraction: { default: 0.6, min: 0.3, max: 1, step: 0.05, description: "Share of the gap to the 20-day average targeted (reversion rarely completes)" },
      horizonDays: { default: 5, min: 2, max: 15, step: 1, description: "Holding horizon" },
    },
    warmupBars: 201,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = shortTermOversoldRecovery.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "strict");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const rsi = prep.f(FEATURE.rsi14);
    const z5 = prep.f(FEATURE.zscore5);
    const sma200 = prep.f(FEATURE.sma200);
    if (rsi === null || z5 === null || sma200 === null) return noSetup("RSI, z-score or 200d average unavailable", horizon);
    if (prep.lastClose < sma200) return noSetup("price below its 200d average: not an uptrend pullback", horizon);
    const guard = reversionGuard(ctx, prep, horizon);
    if (guard) return noSetup(guard, horizon);
    const rsiOk = rsi <= prep.p("rsiThreshold");
    const zOk = z5 <= prep.p("zThreshold");
    if (!rsiOk && !zOk) return noSetup(`RSI ${rsi.toFixed(0)} and 5d z-score ${z5.toFixed(2)} are not oversold`, horizon);
    const rsiStrength = clamp((prep.p("rsiThreshold") - rsi) / 15, 0, 1);
    const zStrength = clamp((prep.p("zThreshold") - z5) / 1.5, 0, 1);
    const strength = clamp(0.4 + 0.3 * rsiStrength + 0.3 * zStrength + (rsiOk && zOk ? 0.1 : 0), 0, 1);
    const confidence = clamp(0.45 + 0.15 * (rsiOk && zOk ? 1 : 0.5) + 0.15 * prep.regimeFit, 0, 1);
    const explanation = `Oversold in an uptrend: RSI(14) ${rsi.toFixed(0)}, 5d z-score ${z5.toFixed(2)}, price above its 200d average (${sma200.toFixed(2)}).`;
    return {
      signals: [
        makeSignal(ctx, prep, "rsi_oversold", rsiOk ? clamp(0.3 + rsiStrength, 0, 1) : 0, confidence, horizon, `RSI(14) ${rsi.toFixed(1)}`),
        makeSignal(ctx, prep, "zscore_5_oversold", zOk ? clamp(0.3 + zStrength, 0, 1) : 0, confidence, horizon, `5d z-score ${z5.toFixed(2)}`),
      ],
      view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation, targetPrice: partialTarget(prep.lastClose, prep.f(FEATURE.sma20), prep.p("reversionFraction")) }),
    };
  },
);

/* ------------------------------------------------------------------------------------------ */
/* vwap_reversion                                                                             */
/* ------------------------------------------------------------------------------------------ */
export const vwapReversion = defineStrategy(
  {
    key: "vwap_reversion",
    name: "Anchored VWAP Reversion",
    family: "mean_reversion",
    description: "Long when price sits well below the 20-day anchored VWAP in a non-trending market; far above it reduces a held position.",
    supportedRegimes: MR_REGIMES,
    parameters: {
      entryDeviationPct: { default: 0.03, min: 0.01, max: 0.1, step: 0.005, description: "Shortfall below anchored VWAP (fraction)" },
      maxAdx: { default: 25, min: 15, max: 40, step: 1, description: "Abstain when ADX(14) exceeds this (trending)" },
      calmAdx: { default: 20, min: 10, max: 30, step: 1, description: "Above this ADX(14), entry only while ADX is falling (the trend is fading)" },
      reversionFraction: { default: 0.6, min: 0.3, max: 1, step: 0.05, description: "Share of the gap to anchored VWAP targeted (reversion rarely completes)" },
      horizonDays: { default: 5, min: 2, max: 15, step: 1, description: "Holding horizon" },
    },
    warmupBars: 40,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = vwapReversion.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "strict");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const dev = prep.f(FEATURE.vwapAnchoredDeviationPct);
    const adx = prep.f(FEATURE.adx14);
    if (dev === null) return noSetup("anchored VWAP unavailable", horizon);
    if (adx !== null && adx > prep.p("maxAdx")) return noSetup(`ADX ${adx.toFixed(0)} indicates a trend; not fading it`, horizon);
    const entry = prep.p("entryDeviationPct");
    const vw = prep.f(FEATURE.vwapAnchored20);
    if (dev <= -entry) {
      const guard = reversionGuard(ctx, prep, horizon);
      if (guard) return noSetup(guard, horizon);
      if (adx !== null && adx > prep.p("calmAdx")) {
        const earlier = prep.bars.length > 40 ? adxOf(prep.bars.slice(0, -5), 14) : null;
        if (earlier === null || adx >= earlier) return noSetup(`ADX ${adx.toFixed(0)} above ${prep.p("calmAdx")} and ${earlier === null ? "its direction unknown" : `rising from ${earlier.toFixed(0)}`}: a strengthening trend, not a stretch`, horizon);
      }
      const strength = clamp(-dev / (2 * entry), 0.3, 1);
      const confidence = clamp(0.45 + 0.15 * clamp((-dev - entry) / entry, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Price is ${fmtSigned(dev * 100, 1)}% below the 20-day anchored VWAP${adx === null ? "" : ` with ADX ${adx.toFixed(0)}`}; expecting reversion.`;
      const target = partialTarget(prep.lastClose, vw, prep.p("reversionFraction"));
      return { signals: [makeSignal(ctx, prep, "vwap_anchored_zscore", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation: `${explanation.replace(/\.$/, "")}, targeting ${pct(prep.p("reversionFraction"), 0)} of the gap.`, targetPrice: target }) };
    }
    if (dev >= 1.5 * entry) {
      const strength = -clamp(dev / (2 * entry), 0.3, 1);
      const explanation = `Price is ${fmtSigned(dev * 100, 1)}% above the 20-day anchored VWAP; stretched.`;
      return { signals: [makeSignal(ctx, prep, "vwap_anchored_zscore", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`anchored VWAP deviation ${fmtSigned(dev * 100, 1)}% inside the band`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* gap_normalization                                                                          */
/* ------------------------------------------------------------------------------------------ */
export const gapNormalization = defineStrategy(
  {
    key: "gap_normalization",
    name: "Gap Normalisation",
    family: "mean_reversion",
    description: "Fades down gaps that are not news-driven (no scheduled event, ordinary volume) in calm markets, expecting the gap to fill.",
    supportedRegimes: MR_REGIMES,
    parameters: {
      minGapPct: { default: 0.02, min: 0.005, max: 0.1, step: 0.005, description: "Minimum down-gap size (fraction)" },
      maxRelativeVolume: { default: 3, min: 1.5, max: 6, step: 0.25, description: "Above this volume multiple the gap is treated as news-driven" },
      horizonDays: { default: 2, min: 1, max: 5, step: 1, description: "Holding horizon" },
    },
    warmupBars: 25,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = gapNormalization.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "strict");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const gap = prep.f(FEATURE.gapPct);
    const rv = prep.f(FEATURE.relativeVolume20);
    if (gap === null) return noSetup("gap unavailable", horizon);
    const ev = eventWithin(ctx, 1);
    if (ev) return noSetup(`scheduled event (${ev.kind}) makes the gap news-driven`, horizon);
    if (rv !== null && rv > prep.p("maxRelativeVolume")) return noSetup(`relative volume ${rv.toFixed(1)}x suggests a news-driven gap`, horizon);
    const minGap = prep.p("minGapPct");
    if (gap <= -minGap) {
      const strength = clamp(-gap / (3 * minGap), 0.3, 1);
      const confidence = clamp(0.4 + 0.15 * clamp((-gap - minGap) / minGap, 0, 1) + 0.15 * prep.regimeFit, 0, 1);
      const prevClose = prep.bars.length >= 2 ? (prep.bars[prep.bars.length - 2]?.close ?? null) : null;
      const explanation = `Opened ${fmtSigned(gap * 100, 1)}% below the prior close on ${rv === null ? "unknown" : `${rv.toFixed(1)}x`} volume with no scheduled catalyst; expecting the gap to fill.`;
      return { signals: [makeSignal(ctx, prep, "gap_down_fade", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation, targetPrice: prevClose, upside: prevClose === null ? undefined : Math.max(0, prevClose / prep.lastClose - 1) }) };
    }
    if (gap >= 1.5 * minGap) {
      const strength = -clamp(gap / (3 * minGap), 0.3, 1);
      const explanation = `Opened ${fmtSigned(gap * 100, 1)}% above the prior close without a catalyst; up-gaps in calm markets tend to fade.`;
      return { signals: [makeSignal(ctx, prep, "gap_up_fade", strength, 0.45, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.45, horizonDays: horizon, explanation }) };
    }
    return noSetup(`gap ${fmtSigned(gap * 100, 2)}% is inside the band`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* extreme_deviation_reversion                                                                */
/* ------------------------------------------------------------------------------------------ */
export const extremeDeviationReversion = defineStrategy(
  {
    key: "extreme_deviation_reversion",
    name: "Extreme Deviation Reversion",
    family: "mean_reversion",
    description: "Buys statistically extreme selloffs (Bollinger z < -2.5 and 10-day z < -2) when volatility is not exploding; extreme rallies reduce a held position.",
    supportedRegimes: MR_REGIMES,
    parameters: {
      bollingerZ: { default: -2.5, min: -4, max: -1.5, step: 0.1, description: "Bollinger(20) z-score threshold" },
      z10: { default: -2, min: -4, max: -1, step: 0.1, description: "10-day z-score threshold" },
      maxAtrPct: { default: 0.05, min: 0.01, max: 0.15, step: 0.005, description: "Abstain when ATR% exceeds this (disorderly market)" },
      reversionFraction: { default: 0.6, min: 0.3, max: 1, step: 0.05, description: "Share of the gap to the 20-day mean targeted (reversion rarely completes)" },
      horizonDays: { default: 5, min: 2, max: 15, step: 1, description: "Holding horizon" },
    },
    warmupBars: 30,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = extremeDeviationReversion.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const gate = regimeAllows(ctx, d, prep, "strict");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const bz = prep.f(FEATURE.bollingerZ20);
    const z10 = prep.f(FEATURE.zscore10);
    const atrPct = prep.f(FEATURE.atrPct);
    if (bz === null || z10 === null) return noSetup("z-scores unavailable", horizon);
    if (atrPct !== null && atrPct > prep.p("maxAtrPct")) return noSetup(`ATR ${pct(atrPct, 1)} of price: too disorderly to fade`, horizon);
    if (bz <= prep.p("bollingerZ") && z10 <= prep.p("z10")) {
      const guard = reversionGuard(ctx, prep, horizon);
      if (guard) return noSetup(guard, horizon);
      const depth = clamp((prep.p("bollingerZ") - bz) / 1.5, 0, 1);
      const strength = clamp(0.5 + 0.5 * depth, 0, 1);
      const confidence = clamp(0.45 + 0.15 * depth + 0.15 * prep.regimeFit, 0, 1);
      const explanation = `Extreme deviation: Bollinger z ${bz.toFixed(2)}, 10d z ${z10.toFixed(2)}${atrPct === null ? "" : `, ATR ${pct(atrPct, 1)}`}; expecting reversion to the 20d mean.`;
      return { signals: [makeSignal(ctx, prep, "bollinger_z_extreme", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation, targetPrice: partialTarget(prep.lastClose, prep.f(FEATURE.sma20), prep.p("reversionFraction")) }) };
    }
    if (bz >= -prep.p("bollingerZ") && z10 >= -prep.p("z10")) {
      const strength = -clamp(0.5 + 0.5 * clamp((bz + prep.p("bollingerZ")) / 1.5, 0, 1), 0, 1);
      const explanation = `Extreme rally: Bollinger z ${bz.toFixed(2)}, 10d z ${z10.toFixed(2)}; stretched.`;
      return { signals: [makeSignal(ctx, prep, "bollinger_z_extreme", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`Bollinger z ${bz.toFixed(2)} / 10d z ${z10.toFixed(2)} not extreme`, horizon);
  },
);

export const MEAN_REVERSION_STRATEGIES = [intradayMeanReversion, shortTermOversoldRecovery, vwapReversion, gapNormalization, extremeDeviationReversion];
