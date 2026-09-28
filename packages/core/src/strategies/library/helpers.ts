import type { Bar, Freshness, RegimeLabel, Signal } from "../../types/index.js";
import type { Strategy, StrategyContext, StrategyDescriptor, StrategyOutput } from "../contract.js";
import { FEATURE } from "../../features/compute.js";
import { barFreshness, freshnessFactor, quoteFreshness, usableBars, worstFreshness } from "../../features/freshness.js";
import { clamp, fmtSigned, pct } from "../../features/math.js";
import { regimeSupport } from "../../regime/engine.js";
import { GEOMETRY, reconcileGeometry } from "../geometry.js";

/**
 * Feature keys that are not produced by the bar-based feature engine but may be supplied by
 * upstream engines (fundamental, events, news, options). Strategies that depend on them abstain
 * when the key is absent: nothing is ever invented.
 */
export const EXT_FEATURE = {
  earningsReactionPct: "earnings_reaction_pct",
  earningsDaysSince: "earnings_days_since",
  earningsSurprisePct: "earnings_surprise_pct",
  postEarningsReturn: "post_earnings_return",
  analystRevisionScore: "analyst_revision_score",
  catalystScore: "catalyst_score",
  catalystDirection: "catalyst_direction",
  sectorNewsScore: "sector_news_score",
  evSales: "ev_sales",
  evSalesSectorMedian: "ev_sales_sector_median",
  ivPercentile: "iv_percentile",
  expectedMove: "expected_move",
  termStructureSlope: "term_structure_slope",
  skew: "skew",
} as const;

export type View = NonNullable<StrategyOutput["view"]>;

export interface Prepared {
  bars: Bar[];
  freshness: Freshness;
  lastClose: number;
  /** Feature getter: null when missing or non-finite. */
  f: (key: string) => number | null;
  /** Numeric parameter with descriptor default fallback. */
  p: (key: string) => number;
  /** Sum of regime probabilities over the strategy's supported regimes (1 if unrestricted). */
  regimeFit: number;
  familyBias: number;
  strategyKey: string;
}

export type PrepareResult = { ok: true; prep: Prepared } | { ok: false; output: StrategyOutput };

/** Abstention: no signals, a zero-strength flat view carrying the reason (never null so the reason survives). */
export function abstain(reason: string, horizonDays = 0): StrategyOutput {
  return {
    signals: [],
    view: {
      direction: "flat", strength: 0, confidence: 0, horizonDays, expectedUpsidePct: 0, expectedDownsidePct: 0,
      invalidationPrice: null, targetPrice: null, explanation: `Abstained: ${reason}`,
    },
  };
}

export function isAbstention(output: StrategyOutput): boolean {
  return output.signals.length === 0 && (output.view === null || (output.view.confidence === 0 && output.view.strength === 0));
}

function numberOrNull(x: number | null | undefined): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : x;
}

/**
 * Common guard for every strategy: look-ahead filtering, warm-up, freshness (fail closed),
 * intraday requirements and parameter access. Returns an abstention output when the strategy
 * must not produce signals.
 */
export function prepare(ctx: StrategyContext, descriptor: StrategyDescriptor, opts: { needsIntraday?: boolean; needsQuote?: boolean } = {}): PrepareResult {
  const bars = usableBars(ctx.bars, ctx.asOf);
  if (bars.length < descriptor.warmupBars) {
    return { ok: false, output: abstain(`insufficient bars (${bars.length} < warm-up ${descriptor.warmupBars})`) };
  }
  let freshness = barFreshness(bars, ctx.asOf);
  if (ctx.quote) {
    const qf = quoteFreshness(ctx.quote.lastTradeAt, ctx.asOf, ctx.quote.session);
    if (qf !== "unknown") freshness = worstFreshness(freshness, qf);
  } else if (opts.needsQuote) {
    return { ok: false, output: abstain("quote required but missing") };
  }
  let intradayLast: Bar | null = null;
  if (opts.needsIntraday) {
    const intra = usableBars(ctx.intradayBars ?? null, ctx.asOf);
    if (intra.length < 12) return { ok: false, output: abstain(`insufficient intraday bars (${intra.length} < 12)`) };
    freshness = worstFreshness(freshness, barFreshness(intra, ctx.asOf));
    intradayLast = intra[intra.length - 1] ?? null;
  }
  if (freshness === "stale" || freshness === "unknown") {
    return { ok: false, output: abstain(`input data is ${freshness} at asOf`) };
  }
  if (descriptor.needsUniverse && (!ctx.universe || ctx.universe.length === 0)) {
    return { ok: false, output: abstain("cross-sectional universe required but missing") };
  }
  // Levels are anchored to the latest price the strategy can see: the last intraday close for
  // intraday strategies (the daily close may be a session old), otherwise the last daily close.
  const lastDaily = bars[bars.length - 1] as Bar;
  const lastClose = intradayLast && Date.parse(intradayLast.time) >= Date.parse(lastDaily.time) ? intradayLast.close : lastDaily.close;
  const f = (key: string): number | null => numberOrNull(ctx.features[key]);
  const p = (key: string): number => {
    const v = ctx.parameters[key];
    const def = descriptor.parameters[key]?.default;
    const raw = typeof v === "number" ? v : typeof def === "number" ? def : NaN;
    const spec = descriptor.parameters[key];
    if (!Number.isFinite(raw)) throw new Error(`Strategy ${descriptor.key}: parameter ${key} has no numeric default`);
    const lo = spec?.min ?? -Infinity;
    const hi = spec?.max ?? Infinity;
    return clamp(raw, lo, hi);
  };
  const regimeFit = regimeSupport(ctx.regime, descriptor.supportedRegimes);
  const familyBias = ctx.regime.familyBias[descriptor.family] ?? 0;
  return { ok: true, prep: { bars, freshness, lastClose, f, p, regimeFit, familyBias, strategyKey: descriptor.key } };
}

/**
 * Regime gate. `strict` (used by mean-reversion strategies) requires the primary regime to be
 * supported or a positive family bias. `soft` only refuses when the regime is clearly hostile.
 */
export function regimeAllows(ctx: StrategyContext, descriptor: StrategyDescriptor, prep: Prepared, mode: "strict" | "soft"): { allowed: boolean; reason: string } {
  const primary = ctx.regime.primary;
  const supported = descriptor.supportedRegimes;
  if (ctx.regime.dataQuality === "stale" || ctx.regime.dataQuality === "unknown") {
    return { allowed: false, reason: `regime data is ${ctx.regime.dataQuality}` };
  }
  if (supported.length === 0) return { allowed: true, reason: "strategy is regime-agnostic" };
  const inSupported = supported.includes(primary);
  if (mode === "strict") {
    const ok = inSupported || prep.familyBias > 0;
    return { allowed: ok, reason: ok ? `regime ${primary} supports the strategy (fit ${pct(prep.regimeFit, 0)})` : `regime ${primary} does not favour ${descriptor.family} (bias ${fmtSigned(prep.familyBias)})` };
  }
  const ok = inSupported || prep.regimeFit >= 0.3 || prep.familyBias > 0.15;
  return { allowed: ok, reason: ok ? `regime ${primary} acceptable (fit ${pct(prep.regimeFit, 0)})` : `regime ${primary} hostile to ${descriptor.family} (fit ${pct(prep.regimeFit, 0)}, bias ${fmtSigned(prep.familyBias)})` };
}

export function makeSignal(ctx: StrategyContext, prep: Prepared, key: string, value: number, confidence: number, horizonDays: number, explanation: string): Signal {
  const v = clamp(value, -1, 1);
  return {
    key, strategyKey: prep.strategyKey, symbol: ctx.symbol,
    direction: v > 0 ? "long" : v < 0 ? "short" : "flat",
    value: round4(v), confidence: round4(clamp(confidence * freshnessFactor(prep.freshness), 0, 1)), horizonDays, asOf: ctx.asOf,
    featureVersion: ctx.featureVersion, explanation, inputFreshness: prep.freshness,
  };
}

/** Expected absolute move (fraction) over a horizon from ATR% or realised vol. */
export function expectedMove(prep: Prepared, horizonDays: number): number {
  const atrPct = prep.f(FEATURE.atrPct);
  const vol = prep.f(FEATURE.realizedVol20);
  const h = Math.max(1, horizonDays);
  if (vol !== null && vol > 0) return (vol / Math.sqrt(252)) * Math.sqrt(h);
  if (atrPct !== null && atrPct > 0) return atrPct * Math.sqrt(h);
  return 0.02 * Math.sqrt(h);
}

export interface ViewSpec {
  strength: number;
  confidence: number;
  horizonDays: number;
  explanation: string;
  /** Expected upside/downside as fractions; default from expected move and strength. */
  upside?: number;
  downside?: number;
  invalidationPrice?: number | null;
  targetPrice?: number | null;
}

/**
 * Build the long-only view. Positive strength => "long". Negative strength => "reduce"
 * (or "exit" when strong) only when a position exists, otherwise "flat" (no short entries).
 */
export function makeView(ctx: StrategyContext, prep: Prepared, spec: ViewSpec): View {
  const strength = clamp(spec.strength, -1, 1);
  const confidence = clamp(spec.confidence * freshnessFactor(prep.freshness), 0, 1);
  const move = expectedMove(prep, spec.horizonDays);
  let direction: View["direction"];
  if (strength > 0) direction = "long";
  else if (strength < 0 && ctx.position && ctx.position.quantity > 0) direction = strength <= -0.6 ? "exit" : "reduce";
  else direction = "flat";

  if (direction === "long") {
    // One consistent geometry: the stop, the target and the stated upside/downside are derived
    // from each other and from the symbol's volatility over the horizon. A structural level the
    // strategy names (e.g. the 200-day average) stays the thesis level, but the risk stop can
    // never sit further than 2σ away, and a target can never sit beyond what the horizon can reach.
    const g = reconcileGeometry({
      price: prep.lastClose, sigmaHorizon: move, strength,
      structuralStop: spec.invalidationPrice ?? null, structuralTarget: spec.targetPrice ?? null,
      ...(spec.upside !== undefined ? { upside: spec.upside } : {}), ...(spec.downside !== undefined ? { downside: spec.downside } : {}),
    });
    if (!g.viable) {
      return {
        direction: "flat", strength: 0, confidence: 0, horizonDays: spec.horizonDays, expectedUpsidePct: round4(g.upsidePct * 100), expectedDownsidePct: round4(g.downsidePct * 100),
        invalidationPrice: g.invalidationPrice, targetPrice: g.targetPrice, rewardRisk: g.rewardRisk, stopSigma: g.stopSigma, targetSigma: g.targetSigma, geometryNotes: g.notes,
        explanation: `No setup: ${spec.explanation} Reward/risk ${g.rewardRisk.toFixed(2)} (target +${(g.upsidePct * 100).toFixed(1)}% vs stop -${(g.downsidePct * 100).toFixed(1)}%) is below the ${GEOMETRY.minRewardRisk} minimum.`,
      };
    }
    return {
      direction, strength: round4(strength), confidence: round4(confidence), horizonDays: spec.horizonDays,
      expectedUpsidePct: round4(g.upsidePct * 100), expectedDownsidePct: round4(g.downsidePct * 100),
      invalidationPrice: g.invalidationPrice, targetPrice: g.targetPrice,
      rewardRisk: g.rewardRisk, stopSigma: g.stopSigma, targetSigma: g.targetSigma, structuralInvalidationPrice: g.structuralInvalidationPrice, geometryNotes: g.notes,
      explanation: spec.explanation,
    };
  }

  const upside = spec.upside ?? move * 0.5;
  const downside = spec.downside ?? move * (1 + Math.abs(strength));
  const suffix = direction === "flat" && strength < 0 ? " Negative view expressed as flat: no position to reduce and short entries are not permitted." : "";
  return {
    direction, strength: round4(strength), confidence: round4(confidence), horizonDays: spec.horizonDays,
    expectedUpsidePct: round4(upside * 100), expectedDownsidePct: round4(downside * 100),
    invalidationPrice: spec.invalidationPrice ?? null, targetPrice: spec.targetPrice ?? null,
    explanation: spec.explanation + suffix,
  };
}

/** Flat view with no opinion but a reason (used when a setup is simply absent). */
export function noSetup(reason: string, horizonDays: number): StrategyOutput {
  return { signals: [], view: { direction: "flat", strength: 0, confidence: 0, horizonDays, expectedUpsidePct: 0, expectedDownsidePct: 0, invalidationPrice: null, targetPrice: null, explanation: `No setup: ${reason}` } };
}

export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export function hasPosition(ctx: StrategyContext): boolean {
  return ctx.position !== null && ctx.position.quantity > 0;
}

/** Percentile rank (0..1) of `symbol` within the universe on `featureKey`; null if unavailable. */
export function universeRank(ctx: StrategyContext, featureKey: string, minUniverse: number): { rank: number; size: number } | null {
  const uni = ctx.universe ?? [];
  const values = uni.map((u) => ({ symbol: u.symbol, value: numberOrNull(u.features[featureKey]) })).filter((u): u is { symbol: string; value: number } => u.value !== null);
  const self = numberOrNull(ctx.features[featureKey]);
  if (self === null) return null;
  if (!values.some((v) => v.symbol === ctx.symbol)) values.push({ symbol: ctx.symbol, value: self });
  if (values.length < minUniverse) return null;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const idx = sorted.findIndex((v) => v.symbol === ctx.symbol);
  return { rank: sorted.length === 1 ? 0.5 : idx / (sorted.length - 1), size: sorted.length };
}

/** True when an upcoming event of the given kinds falls within `days` of asOf. */
export function eventWithin(ctx: StrategyContext, days: number, kinds?: readonly string[]): { kind: string; at: string; description: string } | null {
  const asOf = Date.parse(ctx.asOf);
  if (!Number.isFinite(asOf)) return null;
  for (const e of ctx.upcomingEvents) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const diffDays = (t - asOf) / 86_400_000;
    if (diffDays < -0.5 || diffDays > days) continue;
    if (kinds && !kinds.some((k) => e.kind.toLowerCase().includes(k))) continue;
    return e;
  }
  return null;
}

export function defineStrategy(descriptor: StrategyDescriptor, evaluate: (ctx: StrategyContext) => StrategyOutput): Strategy {
  return {
    descriptor,
    evaluate(ctx: StrategyContext): StrategyOutput {
      const out = evaluate(ctx);
      // Normalise strategyKey on all signals so callers never see a mismatch.
      return { signals: out.signals.map((s) => ({ ...s, strategyKey: descriptor.key })), view: out.view };
    },
  };
}

/** Empty list = strategy runs in every regime. */
export const ALL_REGIMES: readonly RegimeLabel[] = [];

export { FEATURE, clamp, fmtSigned, pct };
