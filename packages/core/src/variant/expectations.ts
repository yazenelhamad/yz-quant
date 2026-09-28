import { ConsensusModelSchema } from "../types/index.js";
import type { ConsensusModel, Freshness } from "../types/index.js";
import { clamp01, finiteValues, isNum, mean, minMax, pctDiff, round, stdDev } from "./math.js";

/**
 * Consensus model construction: turns raw, possibly incomplete inputs about what the market
 * expects into a validated `ConsensusModel`. Nothing is invented: missing inputs stay null and
 * are listed in `positioningProxy.notes` / returned notes.
 */

export interface PositioningInputs {
  shortInterestPct?: number | null;
  putCallRatio?: number | null;
  volumeVsAvg?: number | null;
}

export interface PriceActionInputs {
  return5dPct?: number | null;
  return20dPct?: number | null;
  /** Average absolute move on days the stock reacted to good news / bad news (for asymmetry). */
  avgReactionToGoodNewsPct?: number | null;
  avgReactionToBadNewsPct?: number | null;
}

export interface RevisionInputs {
  epsUp?: number | null;
  epsDown?: number | null;
  revenueUp?: number | null;
  revenueDown?: number | null;
  priceTargetChangePct?: number | null;
  windowDays?: number | null;
}

export interface ExpectationsInputs {
  ticker: string;
  asOf: string;
  epsEstimates?: readonly (number | null)[] | null;
  revenueEstimates?: readonly (number | null)[] | null;
  growthEstimatesPct?: readonly (number | null)[] | null;
  marginEstimatesPct?: readonly (number | null)[] | null;
  priceTargets?: readonly (number | null)[] | null;
  price?: number | null;
  valuation?: { pe?: number | null; evSales?: number | null; evEbitda?: number | null; fcfYield?: number | null } | null;
  optionsImpliedMovePct?: number | null;
  impliedVolatility?: number | null;
  revisions?: RevisionInputs | null;
  sentiment?: number | null;
  positioning?: PositioningInputs | null;
  priceAction?: PriceActionInputs | null;
  consensusNarrative?: string | null;
  currentMarketNarrative?: string | null;
  expectedCatalyst?: string | null;
  sources?: readonly string[] | null;
  dataQuality?: Freshness | null;
}

export interface DispersionStats {
  mean: number;
  std: number | null;
  range: [number, number];
  count: number;
  /** std / |mean|, null when mean is zero or std unknown. */
  coefficientOfVariation: number | null;
}

export function dispersionStats(values: readonly (number | null | undefined)[] | null | undefined): DispersionStats | null {
  const xs = finiteValues(values);
  const m = mean(xs);
  const range = minMax(xs);
  if (m === null || range === null) return null;
  const std = stdDev(xs);
  const cv = std !== null && m !== 0 ? std / Math.abs(m) : null;
  return { mean: m, std, range, count: xs.length, coefficientOfVariation: cv };
}

/**
 * Consensus confidence: how much the consensus number deserves to be trusted as "the market's belief".
 * Rises with analyst coverage (saturating around 15-20 analysts) and falls with relative dispersion.
 * A single estimate is not a consensus; it gets a low ceiling.
 */
export function consensusConfidence(analystCount: number | null, std: number | null, meanValue: number | null): number | null {
  if (!isNum(analystCount) || analystCount <= 0) return null;
  const coverage = 1 - Math.exp(-analystCount / 6);
  let dispersionFactor = 0.5; // unknown dispersion: we cannot claim tight agreement
  if (isNum(std) && isNum(meanValue) && meanValue !== 0) {
    const cv = std / Math.abs(meanValue);
    dispersionFactor = 1 / (1 + 6 * cv);
  } else if (analystCount === 1) {
    dispersionFactor = 0.3;
  }
  return round(clamp01(coverage * dispersionFactor));
}

export interface CrowdingResult {
  score: number | null;
  components: Record<string, number | null>;
  notes: string[];
}

/**
 * Positioning crowding: how one-sided positioning appears. Higher = more crowded.
 * Components (each 0..1, averaged over those available):
 *  - short interest (very high short interest = crowded short; a crowded trade in either direction is fragile)
 *  - put/call ratio distance from a neutral band (~0.7-0.9)
 *  - volume vs average (attention spike)
 *  - price reaction asymmetry: bigger reactions to bad news than good news suggests everyone is already long.
 */
export function crowdingScore(positioning: PositioningInputs | null | undefined, priceAction: PriceActionInputs | null | undefined): CrowdingResult {
  const notes: string[] = [];
  const components: Record<string, number | null> = { shortInterest: null, putCall: null, volume: null, reactionAsymmetry: null };

  const si = positioning?.shortInterestPct;
  if (isNum(si) && si >= 0) components.shortInterest = clamp01(si / 25);
  else notes.push("short interest unavailable");

  const pc = positioning?.putCallRatio;
  if (isNum(pc) && pc >= 0) {
    const neutral = 0.8;
    components.putCall = clamp01(Math.abs(pc - neutral) / neutral);
  } else notes.push("put/call ratio unavailable");

  const vol = positioning?.volumeVsAvg;
  if (isNum(vol) && vol > 0) components.volume = clamp01((vol - 1) / 2);
  else notes.push("volume vs average unavailable");

  const good = priceAction?.avgReactionToGoodNewsPct;
  const bad = priceAction?.avgReactionToBadNewsPct;
  if (isNum(good) && isNum(bad) && Math.abs(good) + Math.abs(bad) > 0) {
    const g = Math.abs(good);
    const b = Math.abs(bad);
    // asymmetry in (-1, 1): positive when bad news moves the stock more than good news.
    const asym = (b - g) / (b + g);
    components.reactionAsymmetry = clamp01(0.5 + asym * 0.5);
  } else notes.push("price reaction asymmetry unavailable");

  const present = Object.values(components).filter(isNum);
  const score = present.length === 0 ? null : round(present.reduce((s, v) => s + v, 0) / present.length);
  if (score === null) notes.push("crowding score not computed: no positioning inputs");
  else if (present.length < 4) notes.push(`crowding score based on ${present.length}/4 components`);
  return { score, components, notes };
}

function n(v: number | null | undefined): number | null {
  return isNum(v) ? v : null;
}

/** Build a schema-validated ConsensusModel from raw inputs. Missing inputs remain null and are noted. */
export function buildConsensusModel(input: ExpectationsInputs): { model: ConsensusModel; notes: string[] } {
  const notes: string[] = [];
  const eps = dispersionStats(input.epsEstimates);
  const revenue = dispersionStats(input.revenueEstimates);
  const growth = dispersionStats(input.growthEstimatesPct);
  const margin = dispersionStats(input.marginEstimatesPct);
  const targets = dispersionStats(input.priceTargets);
  if (!eps) notes.push("no EPS estimates: consensus EPS null");
  if (!revenue) notes.push("no revenue estimates: consensus revenue null");
  if (!growth) notes.push("no growth estimates: consensus growth null");
  if (!margin) notes.push("no margin estimates: consensus margin null");

  const analystCount = eps ? eps.count : revenue ? revenue.count : null;
  const confidence = consensusConfidence(analystCount, eps?.std ?? null, eps?.mean ?? null);
  if (confidence === null) notes.push("consensus confidence unknown: no analyst count");

  const crowd = crowdingScore(input.positioning, input.priceAction);
  const positioningNotes = [...crowd.notes];
  if (targets && isNum(input.price) && input.price > 0) {
    const impliedUpside = ((targets.mean - input.price) / input.price) * 100;
    positioningNotes.push(`mean price target implies ${round(impliedUpside, 1)}% vs current price (${targets.count} targets)`);
  }

  const rev = input.revisions ?? null;
  const priceTargetChangePct = n(rev?.priceTargetChangePct);
  const model: ConsensusModel = {
    ticker: input.ticker,
    asOf: input.asOf,
    consensusRevenue: revenue ? round(revenue.mean) : null,
    consensusEps: eps ? round(eps.mean) : null,
    consensusGrowthPct: growth ? round(growth.mean) : null,
    consensusMarginPct: margin ? round(margin.mean) : null,
    consensusNarrative: (input.consensusNarrative ?? "").slice(0, 800),
    currentValuation: {
      pe: n(input.valuation?.pe),
      evSales: n(input.valuation?.evSales),
      evEbitda: n(input.valuation?.evEbitda),
      fcfYield: n(input.valuation?.fcfYield),
    },
    expectedCatalyst: input.expectedCatalyst ?? null,
    optionsImpliedMovePct: n(input.optionsImpliedMovePct),
    impliedVolatility: n(input.impliedVolatility),
    recentEstimateRevisions: {
      epsUp: n(rev?.epsUp) ?? 0,
      epsDown: n(rev?.epsDown) ?? 0,
      revenueUp: n(rev?.revenueUp) ?? 0,
      revenueDown: n(rev?.revenueDown) ?? 0,
      priceTargetChangePct,
      windowDays: n(rev?.windowDays) ?? 0,
    },
    currentSentiment: isNum(input.sentiment) ? Math.max(-1, Math.min(1, input.sentiment)) : null,
    positioningProxy: {
      shortInterestPct: n(input.positioning?.shortInterestPct),
      putCallRatio: n(input.positioning?.putCallRatio),
      volumeVsAvg: n(input.positioning?.volumeVsAvg),
      crowdingScore: crowd.score,
      notes: positioningNotes,
    },
    currentMarketNarrative: (input.currentMarketNarrative ?? "").slice(0, 800),
    dispersion: {
      epsStdDev: eps?.std !== null && eps?.std !== undefined ? round(eps.std) : null,
      epsRange: eps ? [eps.range[0], eps.range[1]] : null,
      analystCount,
      consensusConfidence: confidence,
    },
    sources: [...(input.sources ?? [])],
    dataQuality: input.dataQuality ?? "unknown",
  };
  if (!rev) notes.push("no revision history: revision counts reported as 0 with windowDays 0");
  if (!isNum(input.optionsImpliedMovePct)) notes.push("options implied move unavailable");
  return { model: ConsensusModelSchema.parse(model), notes };
}

export interface NumberComparison {
  reported: number | null;
  consensus: number | null;
  marketImplied: number | null;
  internal: number | null;
  /** reported vs consensus: the realised surprise */
  reportedVsConsensusPct: number | null;
  /** internal vs consensus: our variant */
  internalVsConsensusPct: number | null;
  /** internal vs what the price already implies: the part of our view that is not priced */
  internalVsMarketImpliedPct: number | null;
  /** market implied vs consensus: the "whisper" gap */
  marketImpliedVsConsensusPct: number | null;
  interpretation: string[];
}

/**
 * Four numbers that are routinely confused: what was reported, what analysts published,
 * what the price implies, and what we forecast. The trade lives in the gaps between them.
 */
export function distinguishNumbers(args: { reported?: number | null; consensus?: number | null; marketImplied?: number | null; internal?: number | null }): NumberComparison {
  const reported = n(args.reported);
  const consensus = n(args.consensus);
  const marketImplied = n(args.marketImplied);
  const internal = n(args.internal);
  const interpretation: string[] = [];
  const rvc = pctDiff(reported, consensus);
  const ivc = pctDiff(internal, consensus);
  const ivm = pctDiff(internal, marketImplied);
  const mvc = pctDiff(marketImplied, consensus);
  if (ivc !== null) interpretation.push(`internal forecast is ${round(ivc, 1)}% vs published consensus`);
  else interpretation.push("internal-vs-consensus gap unknown (missing input)");
  if (mvc !== null) {
    interpretation.push(mvc > 2 ? `price implies more than consensus (+${round(mvc, 1)}%): a beat is partly expected` : mvc < -2 ? `price implies less than consensus (${round(mvc, 1)}%): a miss is partly expected` : "price implies roughly the published consensus");
  } else interpretation.push("market-implied number unknown: cannot say what the price already discounts");
  if (ivm !== null) {
    interpretation.push(Math.abs(ivm) < 2 ? "our view is already reflected in the price: little variant edge" : `our view differs from the priced-in number by ${round(ivm, 1)}%: this is the tradable part`);
  }
  if (rvc !== null) interpretation.push(`reported vs consensus surprise: ${round(rvc, 1)}%`);
  return { reported, consensus, marketImplied, internal, reportedVsConsensusPct: rvc, internalVsConsensusPct: ivc, internalVsMarketImpliedPct: ivm, marketImpliedVsConsensusPct: mvc, interpretation };
}
