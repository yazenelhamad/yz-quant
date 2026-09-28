import type { Bar, Freshness, IsoTimestamp, Quote } from "../types/index.js";
import { barFreshness, quoteFreshness, usableBars, worstFreshness } from "./freshness.js";
import {
  adx, atr, averageDollarVolume, bollingerZ, breakoutFlag, closes, ema, failedBreakoutFlag, gapPct,
  highestHigh, liquidityScore, lowestLow, macd, maxDrawdown, meanReversionZ, momentum12_1, nearestLevels,
  pivotLevels, realizedVol, realizedVolDaily, relativeVolume, returnOver, rsi, simpleReturns, sma,
  spreadBpsFromQuote, trendSlope, trendTStat, vwap,
} from "./indicators.js";
import { autocorrelation, beta, clamp, correlation, sign, varianceRatio } from "./math.js";

export const FEATURE_VERSION = "feat-1.0.0";

/**
 * Canonical feature keys. Strategies read `ctx.features[FEATURE.xxx]`, so the keys are shared
 * constants rather than free strings.
 */
export const FEATURE = {
  close: "close",
  barsCount: "bars_count",
  lastBarAgeWeekdays: "last_bar_age_weekdays",
  sma20: "sma_20",
  sma50: "sma_50",
  sma200: "sma_200",
  ema12: "ema_12",
  ema26: "ema_26",
  ret1: "ret_1",
  ret5: "ret_5",
  ret20: "ret_20",
  ret60: "ret_60",
  ret120: "ret_120",
  ret252: "ret_252",
  momentum12_1: "momentum_12_1",
  rsi14: "rsi_14",
  macd: "macd",
  macdSignal: "macd_signal",
  macdHist: "macd_hist",
  atr14: "atr_14",
  atrPct: "atr_pct",
  bollingerZ20: "bollinger_z_20",
  realizedVol20: "realized_vol_20",
  realizedVol60: "realized_vol_60",
  realizedVolDaily20: "realized_vol_daily_20",
  vwapIntraday: "vwap_intraday",
  vwapDeviationPct: "vwap_deviation_pct",
  vwapAnchored20: "vwap_anchored_20",
  vwapAnchoredDeviationPct: "vwap_anchored_deviation_pct",
  relativeVolume20: "relative_volume_20",
  gapPct: "gap_pct",
  high52wDistancePct: "high_52w_distance_pct",
  low52wDistancePct: "low_52w_distance_pct",
  breakout20: "breakout_20",
  breakout55: "breakout_55",
  failedBreakout: "failed_breakout",
  supportLevel: "support_level",
  resistanceLevel: "resistance_level",
  supportDistancePct: "support_distance_pct",
  resistanceDistancePct: "resistance_distance_pct",
  adx14: "adx_14",
  trendTStat20: "trend_tstat_20",
  trendTStat60: "trend_tstat_60",
  trendSlope20: "trend_slope_20",
  trendSlope100: "trend_slope_100",
  mtfAlignment: "mtf_alignment",
  intradayTrendTStat: "intraday_trend_tstat",
  avgDollarVolume20: "avg_dollar_volume_20",
  spreadBps: "spread_bps",
  liquidityScore: "liquidity_score",
  zscore5: "zscore_5",
  zscore10: "zscore_10",
  varianceRatio5: "variance_ratio_5",
  autocorr1: "autocorr_1_60",
  persistence: "persistence",
  maxDrawdown60: "max_drawdown_60",
  beta60: "beta_60",
  corr60: "corr_60",
  residualRet20: "residual_ret_20",
  quoteLast: "quote_last",
  quoteVsClosePct: "quote_vs_close_pct",
} as const;

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE];

export interface FeatureInput {
  /** Decision time; bars after this instant are ignored. */
  asOf: IsoTimestamp;
  /** Primary (normally daily) bars, any order; interpolated bars are dropped. */
  bars: Bar[];
  /** Optional finer bars for the current session (e.g. 5-minute). */
  intradayBars?: Bar[] | null;
  quote?: Quote | null;
  /** Benchmark (e.g. SPY) bars aligned to the same interval, for beta / residual features. */
  benchmarkBars?: Bar[] | null;
}

export interface FeatureSet {
  values: Record<string, number | null>;
  freshness: Freshness;
  featureVersion: string;
  warnings: string[];
  asOf: IsoTimestamp;
  symbol: string | null;
}

function finiteOrNull(x: number | null | undefined): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : x;
}

/** Same UTC calendar day. */
function sameUtcDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

/**
 * Compute the full feature set for one symbol at `asOf`. Pure and deterministic; never reads
 * the clock. Missing inputs produce null values plus a warning, never a guess.
 */
export function computeFeatures(input: FeatureInput): FeatureSet {
  const warnings: string[] = [];
  const bars = usableBars(input.bars, input.asOf);
  const dropped = (input.bars?.length ?? 0) - bars.length;
  if (dropped > 0) warnings.push(`${dropped} bar(s) dropped (interpolated, malformed or after asOf)`);
  const values: Record<string, number | null> = {};
  const set = (k: string, v: number | null | undefined): void => { values[k] = finiteOrNull(v); };
  const symbol = bars.length > 0 ? (bars[0] as Bar).symbol : (input.quote?.symbol ?? null);

  const freshnessBars = barFreshness(bars, input.asOf);
  if (bars.length === 0) {
    warnings.push("no usable bars at or before asOf");
    return { values, freshness: "unknown", featureVersion: FEATURE_VERSION, warnings, asOf: input.asOf, symbol };
  }

  const c = closes(bars);
  const lastBar = bars[bars.length - 1] as Bar;
  const lastClose = lastBar.close;
  set(FEATURE.close, lastClose);
  set(FEATURE.barsCount, bars.length);

  // Moving averages
  set(FEATURE.sma20, sma(c, 20));
  set(FEATURE.sma50, sma(c, 50));
  set(FEATURE.sma200, sma(c, 200));
  set(FEATURE.ema12, ema(c, 12));
  set(FEATURE.ema26, ema(c, 26));

  // Returns and momentum
  set(FEATURE.ret1, returnOver(c, 1));
  set(FEATURE.ret5, returnOver(c, 5));
  set(FEATURE.ret20, returnOver(c, 20));
  set(FEATURE.ret60, returnOver(c, 60));
  set(FEATURE.ret120, returnOver(c, 120));
  set(FEATURE.ret252, returnOver(c, 252));
  set(FEATURE.momentum12_1, momentum12_1(c));

  // Oscillators
  set(FEATURE.rsi14, rsi(c, 14));
  const m = macd(c);
  set(FEATURE.macd, m?.macd);
  set(FEATURE.macdSignal, m?.signal);
  set(FEATURE.macdHist, m?.histogram);

  // Volatility
  const a14 = atr(bars, 14);
  set(FEATURE.atr14, a14);
  set(FEATURE.atrPct, a14 === null ? null : a14 / lastClose);
  set(FEATURE.bollingerZ20, bollingerZ(c, 20));
  set(FEATURE.realizedVol20, realizedVol(c, 20));
  set(FEATURE.realizedVol60, realizedVol(c, 60));
  set(FEATURE.realizedVolDaily20, realizedVolDaily(c, 20));

  // Volume / gaps
  set(FEATURE.relativeVolume20, relativeVolume(bars, 20));
  set(FEATURE.gapPct, gapPct(bars));
  set(FEATURE.avgDollarVolume20, averageDollarVolume(bars, 20));

  // 52-week distance (uses last 252 bars including current)
  const hh52 = highestHigh(bars, Math.min(252, bars.length), false);
  const ll52 = lowestLow(bars, Math.min(252, bars.length), false);
  set(FEATURE.high52wDistancePct, hh52 === null || hh52 <= 0 ? null : lastClose / hh52 - 1);
  set(FEATURE.low52wDistancePct, ll52 === null || ll52 <= 0 ? null : lastClose / ll52 - 1);

  // Breakouts
  set(FEATURE.breakout20, breakoutFlag(bars, 20));
  set(FEATURE.breakout55, breakoutFlag(bars, 55));
  set(FEATURE.failedBreakout, failedBreakoutFlag(bars, 20, 5));

  // Support / resistance
  if (bars.length >= 20) {
    const levels = pivotLevels(bars.slice(Math.max(0, bars.length - 120)));
    const { support, resistance } = nearestLevels(levels, lastClose);
    set(FEATURE.supportLevel, support);
    set(FEATURE.resistanceLevel, resistance);
    set(FEATURE.supportDistancePct, support === null ? null : lastClose / support - 1);
    set(FEATURE.resistanceDistancePct, resistance === null ? null : resistance / lastClose - 1);
  } else {
    set(FEATURE.supportLevel, null); set(FEATURE.resistanceLevel, null);
    set(FEATURE.supportDistancePct, null); set(FEATURE.resistanceDistancePct, null);
  }

  // Trend strength
  set(FEATURE.adx14, adx(bars, 14));
  set(FEATURE.trendTStat20, trendTStat(c, 20));
  set(FEATURE.trendTStat60, trendTStat(c, 60));
  set(FEATURE.trendSlope20, trendSlope(c, 20));
  set(FEATURE.trendSlope100, trendSlope(c, 100));

  // Mean reversion / persistence
  set(FEATURE.zscore5, meanReversionZ(c, 5));
  set(FEATURE.zscore10, meanReversionZ(c, 10));
  const rets = simpleReturns(c);
  const vr = varianceRatio(rets.slice(Math.max(0, rets.length - 120)), 5);
  set(FEATURE.varianceRatio5, vr);
  set(FEATURE.autocorr1, autocorrelation(rets.slice(Math.max(0, rets.length - 60)), 1));
  set(FEATURE.persistence, vr === null ? null : clamp(vr - 1, -1, 1));
  set(FEATURE.maxDrawdown60, maxDrawdown(c, 60));

  // Benchmark-relative
  const benchBars = usableBars(input.benchmarkBars ?? null, input.asOf);
  if (benchBars.length >= 21 && bars.length >= 21) {
    const aligned = alignByTime(bars, benchBars);
    const ar = simpleReturns(aligned.a.map((b) => b.close));
    const br = simpleReturns(aligned.b.map((b) => b.close));
    const win = 60;
    const aw = ar.slice(Math.max(0, ar.length - win));
    const bw = br.slice(Math.max(0, br.length - win));
    const b60 = beta(aw, bw);
    set(FEATURE.beta60, b60);
    set(FEATURE.corr60, correlation(aw, bw));
    const aRet20 = returnOver(aligned.a.map((b) => b.close), 20);
    const bRet20 = returnOver(aligned.b.map((b) => b.close), 20);
    set(FEATURE.residualRet20, b60 === null || aRet20 === null || bRet20 === null ? null : aRet20 - b60 * bRet20);
    if (aligned.a.length < 21) warnings.push("benchmark bars overlap fewer than 21 sessions; beta not computed");
  } else {
    set(FEATURE.beta60, null); set(FEATURE.corr60, null); set(FEATURE.residualRet20, null);
    if (input.benchmarkBars && input.benchmarkBars.length > 0) warnings.push("insufficient benchmark bars for beta");
  }

  // Quote-derived
  const quote = input.quote ?? null;
  let quoteFresh: Freshness = "unknown";
  if (quote) {
    const sb = spreadBpsFromQuote(quote.bid, quote.ask);
    set(FEATURE.spreadBps, sb);
    set(FEATURE.quoteLast, quote.last);
    set(FEATURE.quoteVsClosePct, quote.last > 0 && lastClose > 0 ? quote.last / lastClose - 1 : null);
    quoteFresh = quoteFreshness(quote.lastTradeAt, input.asOf, quote.session);
    if (sb === null) warnings.push("quote has no usable bid/ask; spread unknown");
  } else {
    set(FEATURE.spreadBps, null); set(FEATURE.quoteLast, null); set(FEATURE.quoteVsClosePct, null);
  }
  set(FEATURE.liquidityScore, liquidityScore(values[FEATURE.avgDollarVolume20] ?? null, values[FEATURE.spreadBps] ?? null));

  // Intraday
  const intraday = usableBars(input.intradayBars ?? null, input.asOf).filter((b) => b.interval !== "day" && b.interval !== "week" && b.interval !== "month");
  const lastIntraday = intraday.length > 0 ? intraday[intraday.length - 1] : undefined;
  const session = lastIntraday ? intraday.filter((b) => sameUtcDay(b.time, lastIntraday.time)) : [];
  if (session.length > 0) {
    const v = vwap(session);
    const px = (session[session.length - 1] as Bar).close;
    set(FEATURE.vwapIntraday, v);
    set(FEATURE.vwapDeviationPct, v === null || v <= 0 ? null : px / v - 1);
    set(FEATURE.intradayTrendTStat, trendTStat(session.map((b) => b.close), Math.min(session.length, 24)));
  } else {
    set(FEATURE.vwapIntraday, null); set(FEATURE.vwapDeviationPct, null); set(FEATURE.intradayTrendTStat, null);
  }
  const anchored = vwap(bars.slice(Math.max(0, bars.length - 20)));
  set(FEATURE.vwapAnchored20, anchored);
  set(FEATURE.vwapAnchoredDeviationPct, anchored === null || anchored <= 0 ? null : lastClose / anchored - 1);

  // Multi-timeframe alignment: +1 both up, -1 both down, 0 disagreement / unknown.
  const dailyT = values[FEATURE.trendTStat20] ?? null;
  const intraT = values[FEATURE.intradayTrendTStat] ?? null;
  if (dailyT !== null && intraT !== null) {
    const ds = sign(dailyT);
    const is = sign(intraT);
    set(FEATURE.mtfAlignment, ds !== 0 && ds === is ? ds : 0);
  } else {
    set(FEATURE.mtfAlignment, null);
  }

  // Freshness: bars drive it; a stale quote degrades it; intraday freshness only when present.
  let freshness: Freshness = freshnessBars;
  if (quote) freshness = worstFreshness(freshness, quoteFresh === "unknown" ? freshness : quoteFresh);
  if (intraday.length > 0) {
    const f = barFreshness(intraday, input.asOf);
    if (f === "stale") warnings.push("intraday bars are stale relative to asOf");
  }
  if (freshness === "stale" || freshness === "unknown") warnings.push(`bar data is ${freshness} at asOf`);
  set(FEATURE.lastBarAgeWeekdays, weekdayAge(lastBar.time, input.asOf));

  return { values, freshness, featureVersion: FEATURE_VERSION, warnings, asOf: input.asOf, symbol };
}

function weekdayAge(lastBarTime: string, asOf: string): number | null {
  const a = Date.parse(lastBarTime);
  const b = Date.parse(asOf);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  let count = 0;
  const startDay = Date.UTC(new Date(a).getUTCFullYear(), new Date(a).getUTCMonth(), new Date(a).getUTCDate());
  const endDay = Date.UTC(new Date(b).getUTCFullYear(), new Date(b).getUTCMonth(), new Date(b).getUTCDate());
  for (let d = startDay + 86_400_000; d <= endDay; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/** Inner-join two bar series on their time label. */
export function alignByTime(a: readonly Bar[], b: readonly Bar[]): { a: Bar[]; b: Bar[] } {
  const bByTime = new Map<string, Bar>();
  for (const bar of b) bByTime.set(bar.time, bar);
  const outA: Bar[] = [];
  const outB: Bar[] = [];
  for (const bar of a) {
    const match = bByTime.get(bar.time);
    if (match) { outA.push(bar); outB.push(match); }
  }
  return { a: outA, b: outB };
}
