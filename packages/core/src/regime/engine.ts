import type { Bar, Freshness, IsoTimestamp, RegimeAssessment, RegimeLabel, StrategyFamily } from "../types/index.js";
import { barFreshness, usableBars, worstFreshness } from "../features/freshness.js";
import { closes, realizedVol, returnOver, simpleReturns, trendSlope } from "../features/indicators.js";
import { autocorrelation, clamp, correlation, fmtSigned, logistic, mean, pct, percentileRank, softmax, stddev, varianceRatio, zScore } from "../features/math.js";

export const REGIME_ENGINE_VERSION = "regime-1.0.0";

export const REGIME_LABELS: readonly RegimeLabel[] = [
  "bull_trend", "bear_trend", "range_bound", "high_volatility", "low_volatility", "risk_on", "risk_off",
  "liquidity_shock", "event_driven", "sector_rotation", "momentum", "mean_reversion",
];

export const STRATEGY_FAMILIES: readonly StrategyFamily[] = [
  "trend_momentum", "mean_reversion", "statistical", "event", "options_volatility", "fundamental_variant",
];

export interface RegimeInput {
  asOf: IsoTimestamp;
  spy: Bar[];
  qqq: Bar[];
  vix?: Bar[] | null;
  /** Sector ETF bars keyed by ETF symbol (XLK, XLF, ...). */
  sectorEtfs?: Record<string, Bar[]>;
  breadth?: { pctAbove50: number | null; pctAbove200: number | null } | null;
  /** Daily return series per universe symbol (aligned, most recent last) for average pairwise correlation. */
  universeReturns?: Record<string, number[]> | null;
  /** Recent volume / normal volume (e.g. 5d avg over 20d avg). Derived from SPY when omitted. */
  volumeRatio?: number | null;
  /** True when a major scheduled macro / market-wide event dominates the horizon (FOMC, CPI, ...). */
  eventDriven?: boolean;
  /** Softmax sharpness for the label distribution. Higher = more peaked. */
  temperature?: number;
}

/** Diagnostics exposed alongside the assessment for tests and dashboards. */
export interface RegimeDiagnostics {
  scores: Record<RegimeLabel, number>;
  volPercentile: number | null;
  relativeStrengthQqqSpy20: number | null;
  zScores: Record<string, number | null>;
  smaStructure: { above50: boolean | null; above200: boolean | null; sma50Above200: boolean | null };
  volSpike: number | null;
}

export interface RegimeResult {
  assessment: RegimeAssessment;
  diagnostics: RegimeDiagnostics;
}

const SOFTMAX_GAIN = 6;

/** Pairwise mean correlation of aligned return series (last `window` observations). */
export function averagePairwiseCorrelation(series: Record<string, number[]>, window = 60): number | null {
  const keys = Object.keys(series).filter((k) => (series[k]?.length ?? 0) >= 10);
  if (keys.length < 2) return null;
  const cors: number[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = series[keys[i] as string] as number[];
      const b = series[keys[j] as string] as number[];
      const c = correlation(a.slice(Math.max(0, a.length - window)), b.slice(Math.max(0, b.length - window)));
      if (c !== null) cors.push(c);
    }
  }
  return mean(cors);
}

function rollingRealizedVol(c: readonly number[], period: number): number[] {
  const out: number[] = [];
  for (let end = period + 1; end <= c.length; end += 1) {
    const v = realizedVol(c.slice(0, end), period);
    if (v !== null) out.push(v);
  }
  return out;
}

function rollingSlope(c: readonly number[], period: number, step = 5): number[] {
  const out: number[] = [];
  for (let end = period; end <= c.length; end += step) {
    const s = trendSlope(c.slice(0, end), period);
    if (s !== null) out.push(s);
  }
  return out;
}

export function assessRegimeDetailed(input: RegimeInput): RegimeResult {
  const asOf = input.asOf;
  const spy = usableBars(input.spy, asOf);
  const qqq = usableBars(input.qqq, asOf);
  const vixBars = usableBars(input.vix ?? null, asOf);
  const explanation: string[] = [];

  const freshSpy = barFreshness(spy, asOf);
  const freshQqq = qqq.length > 0 ? barFreshness(qqq, asOf) : "unknown";
  let dataQuality: Freshness = worstFreshness(freshSpy, freshQqq);
  if (qqq.length === 0) dataQuality = worstFreshness(freshSpy, "aging");

  const spyC = closes(spy);
  const qqqC = closes(qqq);
  const spyRets = simpleReturns(spyC);

  // --- Metrics -------------------------------------------------------------------------
  const spyTrend20 = trendSlope(spyC, 20);
  const spyTrend100 = trendSlope(spyC, 100);
  const realizedVol20 = realizedVol(spyC, 20);
  const volHistory = rollingRealizedVol(spyC.slice(Math.max(0, spyC.length - 272)), 20);
  const volPercentile = realizedVol20 === null || volHistory.length < 30 ? null : percentileRank(volHistory.slice(0, -1), realizedVol20);
  const vixLast = vixBars.length > 0 ? (vixBars[vixBars.length - 1] as Bar).close : null;
  const vixHist = closes(vixBars).slice(Math.max(0, vixBars.length - 252));
  const breadth50 = input.breadth?.pctAbove50 ?? null;
  const breadth200 = input.breadth?.pctAbove200 ?? null;

  let avgCorr: number | null = null;
  if (input.universeReturns && Object.keys(input.universeReturns).length >= 2) {
    avgCorr = averagePairwiseCorrelation(input.universeReturns, 60);
  } else if (input.sectorEtfs) {
    const ser: Record<string, number[]> = {};
    for (const [k, bars] of Object.entries(input.sectorEtfs)) ser[k] = simpleReturns(closes(usableBars(bars, asOf)));
    if (Object.keys(ser).length >= 2) avgCorr = averagePairwiseCorrelation(ser, 60);
  }

  let sectorDispersion: number | null = null;
  const sectorRet20: number[] = [];
  if (input.sectorEtfs) {
    for (const bars of Object.values(input.sectorEtfs)) {
      const r = returnOver(closes(usableBars(bars, asOf)), 20);
      if (r !== null) sectorRet20.push(r);
    }
    if (sectorRet20.length >= 3) sectorDispersion = stddev(sectorRet20);
  }

  const recentRets = spyRets.slice(Math.max(0, spyRets.length - 120));
  const vr5 = varianceRatio(recentRets, 5);
  const ac1 = autocorrelation(spyRets.slice(Math.max(0, spyRets.length - 60)), 1);
  const momentumPersistence = vr5 === null ? null : clamp(vr5 - 1, -1, 1);
  const meanReversionScore = vr5 === null && ac1 === null ? null : clamp(0.5 * Math.max(0, 1 - (vr5 ?? 1)) * 2 + 0.5 * Math.max(0, -(ac1 ?? 0)) * 2, 0, 1);

  let volumeRatio = input.volumeRatio ?? null;
  if (volumeRatio === null && spy.length >= 25) {
    const v5 = mean(spy.slice(-5).map((b) => b.volume));
    const v20 = mean(spy.slice(-25, -5).map((b) => b.volume));
    volumeRatio = v5 !== null && v20 !== null && v20 > 0 ? v5 / v20 : null;
  }

  const relStrength = qqqC.length >= 21 && spyC.length >= 21 ? (returnOver(qqqC, 20) ?? 0) - (returnOver(spyC, 20) ?? 0) : null;
  const sma50 = spyC.length >= 50 ? mean(spyC.slice(-50)) : null;
  const sma200 = spyC.length >= 200 ? mean(spyC.slice(-200)) : null;
  const lastClose = spyC.length > 0 ? (spyC[spyC.length - 1] as number) : null;
  const smaStructure = {
    above50: sma50 !== null && lastClose !== null ? lastClose > sma50 : null,
    above200: sma200 !== null && lastClose !== null ? lastClose > sma200 : null,
    sma50Above200: sma50 !== null && sma200 !== null ? sma50 > sma200 : null,
  };
  const vol5 = realizedVol(spyC, 5);
  const volSpike = vol5 !== null && realizedVol20 !== null && realizedVol20 > 0 ? vol5 / realizedVol20 : null;

  // --- Scores (each in [0,1], transparent) ---------------------------------------------
  const s: Record<RegimeLabel, number> = {
    bull_trend: 0, bear_trend: 0, range_bound: 0, high_volatility: 0, low_volatility: 0, risk_on: 0, risk_off: 0,
    liquidity_shock: 0, event_driven: 0, sector_rotation: 0, momentum: 0, mean_reversion: 0,
  };

  // Trend: 20d and 100d log slope (as total change over the window) plus MA structure.
  const t20 = spyTrend20 ?? 0;
  const t100 = spyTrend100 ?? 0;
  const maBull = (smaStructure.above50 ? 0.5 : 0) + (smaStructure.above200 ? 0.25 : 0) + (smaStructure.sma50Above200 ? 0.25 : 0);
  const maBear = (smaStructure.above50 === false ? 0.5 : 0) + (smaStructure.above200 === false ? 0.25 : 0) + (smaStructure.sma50Above200 === false ? 0.25 : 0);
  const trendStrength = 0.5 * logistic(t20 / 0.02) + 0.5 * logistic(t100 / 0.06); // 0.5 neutral
  s.bull_trend = clamp(0.6 * (trendStrength - 0.5) * 2 + 0.4 * maBull, 0, 1);
  s.bear_trend = clamp(0.6 * (0.5 - trendStrength) * 2 + 0.4 * maBear, 0, 1);
  const trendMagnitude = Math.abs(trendStrength - 0.5) * 2; // 0 flat, 1 strong
  s.range_bound = clamp((1 - trendMagnitude) * (1 - (volPercentile ?? 0.5)) * 1.2 + 0.25 * (vr5 !== null && vr5 < 1 ? 1 - vr5 : 0), 0, 1);

  // Volatility: realized vol percentile and VIX level.
  const vixScore = vixLast === null ? null : clamp((vixLast - 15) / 20, 0, 1); // 15 → 0, 35 → 1
  const volPct = volPercentile ?? (realizedVol20 === null ? 0.5 : clamp((realizedVol20 - 0.1) / 0.3, 0, 1));
  const volLevel = vixScore === null ? volPct : 0.6 * volPct + 0.4 * vixScore;
  s.high_volatility = clamp(volLevel * 1.1 - 0.1, 0, 1);
  s.low_volatility = clamp((1 - volLevel) * 1.1 - 0.1, 0, 1);

  // Risk-on/off: QQQ vs SPY relative strength, breadth, correlation.
  const rsScore = relStrength === null ? 0 : clamp(relStrength / 0.04, -1, 1);
  const breadthParts = [breadth50, breadth200].filter((b): b is number => b !== null).map((b) => clamp((b - 50) / 30, -1, 1));
  const breadthScore = breadthParts.length === 0 ? 0 : (breadthParts.reduce((a, b) => a + b, 0) / breadthParts.length);
  const corrPenalty = avgCorr === null ? 0 : clamp((avgCorr - 0.4) / 0.4, 0, 1);
  const riskAppetite = 0.4 * rsScore + 0.4 * breadthScore + 0.2 * (trendStrength - 0.5) * 2 - 0.3 * corrPenalty;
  s.risk_on = clamp(0.5 + riskAppetite, 0, 1) * (1 - 0.5 * s.high_volatility);
  s.risk_off = clamp(0.5 - riskAppetite, 0, 1) * (0.5 + 0.5 * s.high_volatility);

  // Liquidity shock: vol spike + correlation spike + volume surge together.
  const spike = volSpike === null ? 0 : clamp((volSpike - 1.2) / 1.3, 0, 1);
  const corrSpike = avgCorr === null ? 0 : clamp((avgCorr - 0.5) / 0.3, 0, 1);
  const volumeSurge = volumeRatio === null ? 0 : clamp((volumeRatio - 1.2) / 0.8, 0, 1);
  s.liquidity_shock = clamp(0.5 * spike + 0.3 * corrSpike + 0.2 * volumeSurge, 0, 1) * (0.5 + 0.5 * s.high_volatility);

  // Event-driven: explicit flag, mildly supported by a volume surge.
  s.event_driven = input.eventDriven ? clamp(0.7 + 0.3 * volumeSurge, 0, 1) : 0.15 * volumeSurge;

  // Sector rotation: cross-sectional dispersion of sector ETF 20d returns.
  s.sector_rotation = sectorDispersion === null ? 0 : clamp((sectorDispersion - 0.02) / 0.05, 0, 1) * (1 - 0.5 * corrPenalty);

  // Momentum vs mean reversion: variance ratio and autocorrelation of SPY returns.
  const persistence = 0.6 * clamp(((vr5 ?? 1) - 1) / 0.4, -1, 1) + 0.4 * clamp((ac1 ?? 0) / 0.2, -1, 1);
  s.momentum = clamp(0.5 + persistence, 0, 1) * (0.5 + 0.5 * trendMagnitude);
  s.mean_reversion = clamp(0.5 - persistence, 0, 1) * (0.6 + 0.4 * (1 - trendMagnitude)) * (1 - 0.5 * s.liquidity_shock);

  // Fail closed: with too little data the engine has no opinion.
  const insufficient = spyC.length < 60;
  if (insufficient) {
    for (const k of REGIME_LABELS) s[k] = 0;
    explanation.push(`Insufficient SPY history (${spyC.length} bars, need 60): no regime opinion.`);
  }

  // --- Probabilities ---------------------------------------------------------------------
  const scoreList = REGIME_LABELS.map((k) => s[k]);
  const probs = insufficient ? REGIME_LABELS.map(() => 1 / REGIME_LABELS.length) : softmax(scoreList, 1 / ((input.temperature ?? 1) * SOFTMAX_GAIN));
  const probabilities: Partial<Record<RegimeLabel, number>> = {};
  REGIME_LABELS.forEach((k, i) => { probabilities[k] = round6(probs[i] as number); });
  const ranked = REGIME_LABELS.map((k, i) => ({ k, p: probs[i] as number })).sort((a, b) => b.p - a.p);
  const top = ranked[0] as { k: RegimeLabel; p: number };
  const second = ranked[1] as { k: RegimeLabel; p: number };
  const primary: RegimeLabel = insufficient ? "range_bound" : top.k;
  const confidence = insufficient ? 0 : clamp((top.p - second.p) / Math.max(top.p, 1e-9), 0, 1);

  // --- Abnormality: z-scores of current metrics vs their own rolling history --------------
  const zScores: Record<string, number | null> = {
    realizedVol20: realizedVol20 !== null && volHistory.length >= 30 ? zScore(volHistory.slice(0, -1), realizedVol20) : null,
    spyTrend20: spyTrend20 !== null && spyC.length >= 120 ? zScore(rollingSlope(spyC.slice(0, -1), 20), spyTrend20) : null,
    vix: vixLast !== null && vixHist.length >= 30 ? zScore(vixHist.slice(0, -1), vixLast) : null,
    ret1: spyRets.length >= 60 ? zScore(spyRets.slice(-61, -1), spyRets[spyRets.length - 1] as number) : null,
    volumeRatio: volumeRatio !== null && spy.length >= 60 ? zScore(spy.slice(-61, -1).map((b) => b.volume), (spy[spy.length - 1] as Bar).volume) : null,
  };
  const zs = Object.values(zScores).filter((z): z is number => z !== null).map((z) => Math.abs(z));
  const abnormality = zs.length === 0 ? 0 : clamp((mean(zs) as number) / 3, 0, 1);

  // --- Family bias -----------------------------------------------------------------------
  const p = (k: RegimeLabel): number => probabilities[k] ?? 0;
  const norm = (x: number): number => clamp(x, -1, 1);
  const scale = 3; // probabilities are spread across 12 labels; scale so strong regimes reach +/-1
  const familyBias: Record<string, number> = {
    trend_momentum: norm(scale * (p("bull_trend") + p("momentum") + 0.5 * p("risk_on") - p("range_bound") - p("mean_reversion") - p("liquidity_shock") - 0.5 * p("bear_trend"))),
    mean_reversion: norm(scale * (p("range_bound") + p("mean_reversion") + 0.5 * p("low_volatility") - p("momentum") - p("liquidity_shock") - 0.5 * p("bull_trend") - 0.5 * p("bear_trend"))),
    statistical: norm(scale * (p("range_bound") + p("sector_rotation") + 0.5 * p("low_volatility") + 0.3 * p("mean_reversion") - p("liquidity_shock") - 0.5 * p("high_volatility") - 0.5 * p("event_driven"))),
    event: norm(scale * (p("event_driven") + 0.5 * p("risk_on") + 0.3 * p("sector_rotation") - p("liquidity_shock") - 0.5 * p("risk_off"))),
    options_volatility: norm(scale * (p("high_volatility") + p("event_driven") + 0.5 * p("liquidity_shock") - p("low_volatility") - 0.3 * p("range_bound"))),
    fundamental_variant: norm(scale * (p("range_bound") + p("sector_rotation") + 0.5 * p("risk_on") + 0.3 * p("bull_trend") - p("liquidity_shock") - 0.5 * p("high_volatility"))),
  };
  if (insufficient) for (const f of STRATEGY_FAMILIES) familyBias[f] = 0;

  // --- Explanation -----------------------------------------------------------------------
  if (!insufficient) {
    explanation.push(`Primary regime ${primary} (p=${pct(top.p)}) ahead of ${second.k} (p=${pct(second.p)}); confidence ${pct(confidence)}.`);
    explanation.push(`SPY 20d trend ${fmtSigned((spyTrend20 ?? 0) * 100, 1)}%, 100d trend ${fmtSigned((spyTrend100 ?? 0) * 100, 1)}%; price ${smaStructure.above50 ? "above" : "below"} 50d and ${smaStructure.above200 === null ? "unknown vs" : smaStructure.above200 ? "above" : "below"} 200d average.`);
    explanation.push(`Realised vol ${realizedVol20 === null ? "n/a" : pct(realizedVol20)} (${volPercentile === null ? "no percentile" : `${pct(volPercentile, 0)} percentile`})${vixLast === null ? "" : `, VIX ${vixLast.toFixed(1)}`}.`);
    if (relStrength !== null) explanation.push(`QQQ vs SPY 20d relative strength ${fmtSigned(relStrength * 100, 1)}%${breadth50 === null ? "" : `, ${breadth50.toFixed(0)}% of stocks above 50d`}${avgCorr === null ? "" : `, average pairwise correlation ${avgCorr.toFixed(2)}`}.`);
    if (vr5 !== null) explanation.push(`Variance ratio(5) ${vr5.toFixed(2)} and lag-1 autocorrelation ${(ac1 ?? 0).toFixed(2)} favour ${persistence >= 0 ? "momentum" : "mean reversion"}.`);
    if (s.liquidity_shock > 0.4) explanation.push(`Liquidity-shock signature: vol spike ${(volSpike ?? 0).toFixed(2)}x, volume ratio ${(volumeRatio ?? 0).toFixed(2)}x.`);
    if (sectorDispersion !== null) explanation.push(`Sector dispersion of 20d returns ${pct(sectorDispersion)}.`);
    if (input.eventDriven) explanation.push("Scheduled market-wide event flagged for the horizon.");
    if (abnormality > 0.5) explanation.push(`Current behaviour is unusual versus history (abnormality ${pct(abnormality, 0)}).`);
  }
  if (dataQuality !== "fresh") explanation.push(`Index data is ${dataQuality} at asOf; treat the assessment with caution.`);

  const assessment: RegimeAssessment = {
    asOf,
    primary,
    probabilities,
    confidence: round6(confidence),
    abnormality: round6(abnormality),
    metrics: {
      spyTrend20, spyTrend100, realizedVol20, vix: vixLast, breadthPctAbove50: breadth50,
      avgPairwiseCorrelation: avgCorr, sectorDispersion, momentumPersistence, meanReversionScore, volumeRatio,
    },
    familyBias,
    explanation,
    dataQuality,
  };
  return {
    assessment,
    diagnostics: { scores: s, volPercentile, relativeStrengthQqqSpy20: relStrength, zScores, smaStructure, volSpike },
  };
}

export function assessRegime(input: RegimeInput): RegimeAssessment {
  return assessRegimeDetailed(input).assessment;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Sum of probabilities of the given labels; 1 when the list is empty (no restriction). */
export function regimeSupport(assessment: RegimeAssessment, labels: readonly RegimeLabel[]): number {
  if (labels.length === 0) return 1;
  let total = 0;
  for (const l of labels) total += assessment.probabilities[l] ?? 0;
  return clamp(total, 0, 1);
}

/** Convenience: a neutral assessment for contexts with no regime information (fails closed). */
export function unknownRegime(asOf: IsoTimestamp): RegimeAssessment {
  const probabilities: Partial<Record<RegimeLabel, number>> = {};
  for (const l of REGIME_LABELS) probabilities[l] = 1 / REGIME_LABELS.length;
  const familyBias: Record<string, number> = {};
  for (const f of STRATEGY_FAMILIES) familyBias[f] = 0;
  return {
    asOf, primary: "range_bound", probabilities, confidence: 0, abnormality: 0,
    metrics: { spyTrend20: null, spyTrend100: null, realizedVol20: null, vix: null, breadthPctAbove50: null, avgPairwiseCorrelation: null, sectorDispersion: null, momentumPersistence: null, meanReversionScore: null, volumeRatio: null },
    familyBias, explanation: ["No regime data available."], dataQuality: "unknown",
  };
}
