import { VariantViewSchema } from "../types/index.js";
import type { Catalyst, ConsensusModel, Evidence, InternalForecast, Scenario, VariantView } from "../types/index.js";
import { aggregateCatalystStrength, aggregatePricedIn, nextCatalyst, rankCatalysts } from "./catalyst.js";
import { epsStdDevPct, variantSignificance } from "./dispersion.js";
import { toViewEvidence, weighEvidence } from "./evidence.js";
import { clamp01, clip, isNum, pctDiff, round } from "./math.js";
import type { NarrativeTracking } from "./narrative.js";
import type { ImpliedExpectationsResult } from "./reverseDcf.js";
import { recommendAction, riskRewardRatio, variantPerceptionScore } from "./score.js";
import type { ExpectedSurpriseResult } from "./surprise.js";
import type { TimingAssessment } from "./timing.js";

/**
 * Assemble a complete, schema-validated VariantView from deterministic pieces and analyst outputs.
 * Nothing is invented here: absent analyst outputs stay null and lower the score; every string is
 * clipped to the schema's limits.
 */

export type PreMortem = NonNullable<VariantView["preMortem"]>;
export type RedTeam = NonNullable<VariantView["redTeam"]>;
export type SourceDisagreementRecord = VariantView["sourceDisagreements"][number];

export interface VariantViewParts {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  internal: InternalForecast | null;
  consensusStatement?: string | null;
  internalStatement?: string | null;
  catalysts: Catalyst[];
  holdingPeriodDays: number;
  timing: TimingAssessment;
  expectedSurprise: ExpectedSurpriseResult | null;
  narrative: NarrativeTracking | null;
  scenarios: Scenario[];
  impliedExpectations: ImpliedExpectationsResult | null;
  preMortem: PreMortem | null;
  redTeam: RedTeam | null;
  sourceDisagreements: SourceDisagreementRecord[];
  evidence: Evidence[];
  secondOrder: string[];
  portfolioFit?: string | null;
  /** Overrides for the "what would make us wrong" block; otherwise derived. */
  whatWouldMakeUsWrong?: Partial<VariantView["whatWouldMakeUsWrong"]>;
  versions: VariantView["versions"];
}

export interface AssembledVariantView {
  view: VariantView;
  notes: string[];
}

const METRICS: { key: "revenue" | "eps" | "marginPct" | "growthPct"; consensusKey: keyof ConsensusModel; label: string }[] = [
  { key: "revenue", consensusKey: "consensusRevenue", label: "revenue" },
  { key: "eps", consensusKey: "consensusEps", label: "eps" },
  { key: "marginPct", consensusKey: "consensusMarginPct", label: "margin" },
  { key: "growthPct", consensusKey: "consensusGrowthPct", label: "growth" },
];

export function computeDifferences(consensus: ConsensusModel, internal: InternalForecast | null): VariantView["differences"] {
  return METRICS.map((m) => {
    const c = consensus[m.consensusKey];
    const i = internal ? internal[m.key] : null;
    const cv = isNum(c) ? c : null;
    const iv = isNum(i) ? i : null;
    const diff = pctDiff(iv, cv);
    return { metric: m.label, consensus: cv, internal: iv, differencePct: diff === null ? null : round(diff, 2) };
  });
}

function scenario(scenarios: readonly Scenario[], name: Scenario["name"]): Scenario | null {
  return scenarios.find((s) => s.name === name) ?? null;
}

function fmt(v: number | null | undefined, suffix = ""): string {
  return isNum(v) ? `${round(v, 1)}${suffix}` : "n/a";
}

export function composeIcSummary(view: Omit<VariantView, "icSummary">, extras: { portfolioFit: string | null; keyRisk: string; nextCatalystLine: string; whyRight: string }): string {
  const bull = scenario(view.scenarios, "bull");
  const base = scenario(view.scenarios, "base");
  const bear = scenario(view.scenarios, "bear");
  const sc = (s: Scenario | null) => (s ? `${fmt(s.priceImpactPct, "%")} (p=${round(s.probability, 2)}): ${clip(s.fundamentalOutcome, 160)}` : "not modelled");
  const variantLines = view.differences.filter((d) => d.differencePct !== null).map((d) => `${d.metric} ${d.differencePct! >= 0 ? "+" : ""}${round(d.differencePct!, 1)}% vs consensus`);
  const lines = [
    `Ticker: ${view.ticker} (as of ${view.asOf})`,
    `Market Belief: ${view.consensusStatement}`,
    `Our View: ${view.internalStatement}`,
    `Variant: ${variantLines.length > 0 ? variantLines.join("; ") : "no quantified variant"}${view.meaningful ? "" : " — not meaningful"}`,
    `Why We May Be Right: ${extras.whyRight}`,
    `Catalyst: ${extras.nextCatalystLine}`,
    `What Is Priced In: ${Math.round(view.pricedInScore * 100)}% of the view; expected reaction ${fmt(view.expectedReactionPct, "%")}${view.impliedExpectations && isNum(view.impliedExpectations.impliedGrowthPct) ? `; price implies ${fmt(view.impliedExpectations.impliedGrowthPct, "%")} growth` : ""}`,
    `Bull: ${sc(bull)}`,
    `Base: ${sc(base)}`,
    `Bear: ${sc(bear)}`,
    `Key Risk: ${extras.keyRisk}`,
    `Invalidation: ${view.whatWouldMakeUsWrong.invalidatingEvidence.slice(0, 3).join("; ") || "not specified"}`,
    `Portfolio Fit: ${extras.portfolioFit ?? "not assessed"}`,
    `Recommended Action: ${view.recommendedAction}${view.timing.appropriate ? "" : " — timing poor, wait"}`,
    `Confidence: ${round(view.confidence, 2)} (score ${round(view.score.total, 2)})`,
  ];
  return clip(lines.join("\n"), 3000).replace(/ /g, " ");
}

export function assembleVariantView(parts: VariantViewParts): AssembledVariantView {
  const notes: string[] = [];
  const { consensus, internal } = parts;
  const differences = computeDifferences(consensus, internal);
  const gaps = differences.map((d) => d.differencePct).filter(isNum);
  const maxGap = gaps.length > 0 ? gaps.reduce((m, g) => (Math.abs(g) > Math.abs(m) ? g : m), 0) : null;
  if (!internal) notes.push("no internal forecast: no variant view, conviction reduced");

  const ranked = rankCatalysts(parts.catalysts, { holdingPeriodDays: parts.holdingPeriodDays, asOf: parts.asOf });
  const catalystAgg = aggregateCatalystStrength(ranked);
  notes.push(...catalystAgg.notes);
  const next = nextCatalyst(parts.catalysts, parts.asOf);

  const pricedFromCatalysts = aggregatePricedIn(parts.catalysts);
  const pricedFromSurprise = parts.expectedSurprise && isNum(parts.expectedSurprise.pricedInPct) ? parts.expectedSurprise.pricedInPct / 100 : null;
  const pricedInScore = pricedFromSurprise !== null && pricedFromCatalysts !== null ? round(0.5 * pricedFromSurprise + 0.5 * pricedFromCatalysts) : (pricedFromSurprise ?? pricedFromCatalysts ?? 0.5);
  if (pricedFromSurprise === null && pricedFromCatalysts === null) notes.push("priced-in share unknown: assumed 0.5 for the view, scored as missing");

  const significance = variantSignificance(maxGap, epsStdDevPct(consensus), consensus.dispersion.analystCount);
  notes.push(...significance.notes);
  const weighed = weighEvidence(parts.evidence);
  notes.push(...weighed.notes);
  const evidenceQuality = parts.evidence.length > 0 ? (internal ? round(0.5 * weighed.quality + 0.5 * clamp01(internal.evidenceQuality)) : weighed.quality) : internal ? clamp01(internal.evidenceQuality) : null;

  const bull = scenario(parts.scenarios, "bull");
  const bear = scenario(parts.scenarios, "bear");
  const upsidePct = parts.whatWouldMakeUsWrong?.upsidePct ?? bull?.priceImpactPct ?? null;
  const downsidePct = parts.whatWouldMakeUsWrong?.downsidePct ?? bear?.priceImpactPct ?? null;
  const probSum = parts.scenarios.reduce((s, x) => s + x.probability, 0);
  if (parts.scenarios.length > 0 && Math.abs(probSum - 1) > 0.05) notes.push(`scenario probabilities sum to ${round(probSum, 2)}, not 1`);

  const crowding = consensus.positioningProxy.crowdingScore ?? parts.narrative?.crowdedness ?? null;
  const score = variantPerceptionScore({
    expectationGapPct: maxGap,
    forecastConfidence: internal?.confidence ?? null,
    evidenceQuality,
    catalystStrength: parts.catalysts.length > 0 ? catalystAgg.strength : null,
    timingScore: parts.timing.score,
    pricedInScore: pricedFromSurprise === null && pricedFromCatalysts === null ? null : pricedInScore,
    dispersionSignificance: maxGap === null ? null : significance.significance,
    positioningCrowding: crowding,
    upsidePct,
    downsidePct,
  });
  notes.push(...score.notes);
  const riskReward = riskRewardRatio(upsidePct, downsidePct);
  const action = recommendAction(score.total, parts.timing, parts.preMortem?.verdict ?? null, parts.redTeam?.severity ?? null, riskReward);
  notes.push(...action.reasons);

  const meaningful = maxGap !== null && Math.abs(maxGap) >= 5 && significance.significance >= 0.25 && internal !== null;
  let confidence = internal ? clamp01(internal.confidence) : 0;
  if (!meaningful) confidence *= 0.6;
  if (parts.redTeam) confidence *= 1 - 0.5 * clamp01(parts.redTeam.severity);
  if (evidenceQuality !== null) confidence *= 0.5 + 0.5 * evidenceQuality;
  confidence = round(clamp01(confidence));

  const consensusStatement = clip(parts.consensusStatement ?? consensus.consensusNarrative ?? "", 500) || "consensus view not summarised";
  const internalStatement = clip(parts.internalStatement ?? internal?.reasoning[0] ?? "", 500) || "no internal view";
  const reasons: string[] = [];
  if (internal) reasons.push(...internal.reasoning.map((r) => clip(r, 400)));
  reasons.push(clip(significance.interpretation, 400));
  if (parts.expectedSurprise) reasons.push(...parts.expectedSurprise.reasoning.map((r) => clip(r, 400)));

  const whyRight = internal?.reasoning[0] ?? "no internal reasoning";
  const whyMarketMightBeRight = parts.redTeam?.legitimateFlaws[0] ?? parts.preMortem?.misunderstood ?? "not assessed";
  const wwmw: VariantView["whatWouldMakeUsWrong"] = {
    marketBelieves: clip(parts.whatWouldMakeUsWrong?.marketBelieves ?? consensusStatement, 400),
    weBelieve: clip(parts.whatWouldMakeUsWrong?.weBelieve ?? internalStatement, 400),
    whyDifferent: clip(parts.whatWouldMakeUsWrong?.whyDifferent ?? whyRight, 400),
    whyMarketMightBeRight: clip(parts.whatWouldMakeUsWrong?.whyMarketMightBeRight ?? whyMarketMightBeRight, 400),
    invalidatingEvidence: (parts.whatWouldMakeUsWrong?.invalidatingEvidence ?? parts.redTeam?.contradictoryEvidence ?? []).map((s) => clip(s, 300)),
    resolvingCatalyst: clip(parts.whatWouldMakeUsWrong?.resolvingCatalyst ?? (next ? `${next.description} (${next.expectedDate})` : "no dated catalyst"), 300),
    upsidePct: upsidePct ?? 0,
    downsidePct: downsidePct ?? 0,
  };
  if (upsidePct === null || downsidePct === null) notes.push("upside/downside unknown: recorded as 0 in whatWouldMakeUsWrong, scored as missing");

  const narrative: VariantView["narrative"] = parts.narrative
    ? { dominant: clip(parts.narrative.dominant, 200), trend: parts.narrative.trend, crowded: parts.narrative.crowded, confirmingInfo: parts.narrative.confirmingInfo.map((s) => clip(s, 300)), contradictingInfo: parts.narrative.contradictingInfo.map((s) => clip(s, 300)), priceDivergingFromNarrative: parts.narrative.priceDivergingFromNarrative }
    : { dominant: clip(consensus.currentMarketNarrative, 200) || "unknown", trend: "unknown", crowded: false, confirmingInfo: [], contradictingInfo: [], priceDivergingFromNarrative: false };

  const es = parts.expectedSurprise;
  const draft: Omit<VariantView, "icSummary"> = {
    ticker: parts.ticker,
    asOf: parts.asOf,
    consensusStatement,
    internalStatement,
    differences,
    confidence,
    reasons,
    meaningful,
    pricedInScore: clamp01(pricedInScore),
    catalysts: parts.catalysts,
    expectedReactionPct: es?.adjustedImpactPct ?? null,
    timing: { appropriate: parts.timing.appropriate, score: clamp01(parts.timing.score), reasons: parts.timing.reasons.map((r) => clip(r, 300)) },
    expectedSurprise: es ? { metric: es.metric, consensus: es.consensus, internal: es.internal, surprisePct: es.surprisePct, pricedInPct: es.pricedInPct, historicalSensitivity: es.historicalSensitivity, adjustedImpactPct: es.adjustedImpactPct } : null,
    secondOrder: parts.secondOrder.map((s) => clip(s, 400)),
    narrative,
    whatWouldMakeUsWrong: wwmw,
    scenarios: parts.scenarios,
    impliedExpectations: parts.impliedExpectations
      ? { impliedGrowthPct: parts.impliedExpectations.impliedGrowthPct, impliedMarginPct: parts.impliedExpectations.impliedMarginPct, impliedReturnOnCapital: parts.impliedExpectations.impliedReturnOnCapital, comparedToHistory: clip(parts.impliedExpectations.comparedToHistory, 400), comparedToGuidance: clip(parts.impliedExpectations.comparedToGuidance, 400), comparedToInternal: clip(parts.impliedExpectations.comparedToInternal, 400) }
      : null,
    preMortem: parts.preMortem,
    redTeam: parts.redTeam,
    sourceDisagreements: parts.sourceDisagreements.map((d) => ({ ...d, claimA: clip(d.claimA, 300), claimB: clip(d.claimB, 300), reason: d.reason === null ? null : clip(d.reason, 300), effectOnTrade: clip(d.effectOnTrade, 300) })),
    evidence: parts.evidence.map(toViewEvidence),
    score: { total: score.total, components: score.components },
    recommendedAction: action.action,
    versions: parts.versions,
  };
  const keyRisk = parts.preMortem?.likelyCauseOfLoss ?? parts.redTeam?.legitimateFlaws[0] ?? "not assessed";
  const nextLine = next ? `${next.description} — ${next.expectedDate}, p=${round(next.probability, 2)}, impact ${fmt(next.potentialImpactPct, "%")}, ${Math.round(next.pricedInScore * 100)}% priced` : parts.catalysts.length > 0 ? "no dated catalyst" : "none identified";
  const icSummary = composeIcSummary(draft, { portfolioFit: parts.portfolioFit ?? null, keyRisk: clip(keyRisk, 300), nextCatalystLine: nextLine, whyRight: clip(whyRight, 400) });
  const view = VariantViewSchema.parse({ ...draft, icSummary });
  return { view, notes };
}
