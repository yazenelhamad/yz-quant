import {
  assembleVariantView,
  assessTiming,
  buildConsensusModel,
  daysBetweenIso,
  detectSourceDisagreement,
  expectedSurprise,
  frameworkFor,
  historicalSensitivity,
  impliedExpectations,
  nextCatalyst,
  priorTheses,
  trackNarrative,
} from "@yz/core";
import type {
  Catalyst,
  CompanyIntelligenceProfile,
  DataEnvelope,
  Evidence,
  ExpectationsInputs,
  ExpectationsRecord,
  ImpliedExpectationsInput,
  ImpliedExpectationsResult,
  SourceClaim,
  TaggedEnvelope,
  TechnicalSetup,
  VariantView,
} from "@yz/core";
import type { ModelUsage, StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { CONSENSUS_NARRATIVE_PROMPT_VERSION, runConsensusNarrativeAnalyst } from "./consensusNarrativeAnalyst.js";
import { FORECAST_PROMPT_VERSION, runForecastAnalyst } from "./forecastAnalyst.js";
import { PRE_MORTEM_PROMPT_VERSION, runPreMortemAnalyst } from "./preMortemAnalyst.js";
import { VARIANT_NOT_CONFIGURED_MESSAGE } from "./prompts.js";
import { RED_TEAM_PROMPT_VERSION, runRedTeamAnalyst } from "./redTeamAnalyst.js";
import { SCENARIO_PROMPT_VERSION, runScenarioAnalyst } from "./scenarioAnalyst.js";
import { SECOND_ORDER_PROMPT_VERSION, runSecondOrderAnalyst } from "./secondOrderAnalyst.js";

/**
 * Variant perception orchestrator: deterministic pieces from @yz/core, analysts through the
 * StructuredModelClient, assembled into a schema-validated VariantView. Any analyst failure or an
 * unconfigured client yields a clearly marked failure, never a partially invented view.
 */

export const ORCHESTRATOR_PROMPT_VERSION = "vp-orchestrator-1.0.0";

export const VARIANT_PROMPT_VERSIONS = {
  orchestrator: ORCHESTRATOR_PROMPT_VERSION,
  consensusNarrative: CONSENSUS_NARRATIVE_PROMPT_VERSION,
  forecast: FORECAST_PROMPT_VERSION,
  scenarios: SCENARIO_PROMPT_VERSION,
  preMortem: PRE_MORTEM_PROMPT_VERSION,
  redTeam: RED_TEAM_PROMPT_VERSION,
  secondOrder: SECOND_ORDER_PROMPT_VERSION,
} as const;

export interface VariantPerceptionInput {
  ticker: string;
  asOf: string;
  sector: string | null;
  industry?: string | null;
  /** Raw consensus inputs (estimates, targets, positioning, ...). */
  expectations: ExpectationsInputs;
  envelopes: DataEnvelope[];
  holdingPeriodDays: number;
  direction?: "long" | "short";
  timing?: {
    technicalSetup?: TechnicalSetup | null;
    liquidityScore?: number | null;
    regimeFit?: number | null;
    volatility?: number | null;
    signalDecayHalfLife?: number | null;
    signalAgeDays?: number | null;
  } | null;
  reverseDcf?: ImpliedExpectationsInput | null;
  /** 0..1 position of current valuation in its own history. */
  valuationPercentile?: number | null;
  evidence: Evidence[];
  claims?: SourceClaim[];
  knownCatalysts?: Catalyst[];
  portfolioFit?: string | null;
  /** Metric used for the expected surprise model; defaults to the sector framework's priority metric that has a consensus value. */
  surpriseMetric?: "eps" | "revenue";
}

export interface VariantPerceptionDeps {
  /** Historical expectations records (all tickers allowed; filtered by ticker). */
  expectationsRecords: ExpectationsRecord[];
  profile: CompanyIntelligenceProfile | null;
}

export type VariantPerceptionStage = "precheck" | "consensus_narrative" | "forecast" | "scenarios" | "pre_mortem" | "red_team" | "second_order" | "assemble";

export type VariantPerceptionResult =
  | { ok: true; view: VariantView; notes: string[]; usage: ModelUsage[]; promptVersions: typeof VARIANT_PROMPT_VERSIONS }
  | { ok: false; error: "not_configured" | "validation_failed" | "provider_error" | "rate_limited" | "timeout" | "refused" | "assembly_failed"; message: string; stage: VariantPerceptionStage; usage: ModelUsage[] };

function fail(stage: VariantPerceptionStage, r: Extract<StructuredResult<unknown>, { ok: false }>, usage: ModelUsage[]): VariantPerceptionResult {
  return { ok: false, error: r.error, message: r.message, stage, usage };
}

export async function runVariantPerception(input: VariantPerceptionInput, client: StructuredModelClient, deps: VariantPerceptionDeps): Promise<VariantPerceptionResult> {
  const usage: ModelUsage[] = [];
  if (!client.configured) {
    return { ok: false, error: "not_configured", message: `variant perception did not run for ${input.ticker}: ${VARIANT_NOT_CONFIGURED_MESSAGE}`, stage: "precheck", usage };
  }
  const notes: string[] = [];
  const framework = frameworkFor(input.sector, input.industry ?? null);
  const records = deps.expectationsRecords.filter((r) => r.ticker === input.ticker);
  const built = buildConsensusModel({ ...input.expectations, ticker: input.ticker, asOf: input.asOf });
  notes.push(...built.notes);
  let consensus = built.model;

  // 1. Consensus narrative + envelope tagging.
  const narrativeRes = await runConsensusNarrativeAnalyst({ ticker: input.ticker, asOf: input.asOf, consensus, envelopes: input.envelopes, framework }, client);
  if (!narrativeRes.ok) return fail("consensus_narrative", narrativeRes, usage);
  usage.push(narrativeRes.usage);
  const narrativeOut = narrativeRes.output;
  consensus = {
    ...consensus,
    consensusNarrative: consensus.consensusNarrative || narrativeOut.consensusNarrative.slice(0, 800),
    currentMarketNarrative: consensus.currentMarketNarrative || narrativeOut.currentMarketNarrative.slice(0, 800),
    expectedCatalyst: consensus.expectedCatalyst ?? narrativeOut.expectedCatalyst,
  };
  const byHash = new Map(input.envelopes.map((e) => [e.contentHash, e] as const));
  const tagged: TaggedEnvelope[] = narrativeOut.tags.flatMap((t) => {
    const env = byHash.get(t.id);
    return env ? [{ envelope: env, tags: t.narratives, sentiment: t.sentiment }] : [];
  });

  // 2. Internal forecast and catalysts.
  const prior = priorTheses(deps.profile, input.ticker);
  const forecastRes = await runForecastAnalyst({ ticker: input.ticker, asOf: input.asOf, consensus, envelopes: input.envelopes, framework, profile: deps.profile, priorThesesSummary: prior.summary, knownCatalysts: input.knownCatalysts ?? [] }, client);
  if (!forecastRes.ok) return fail("forecast", forecastRes, usage);
  usage.push(forecastRes.usage);
  const { forecast, catalysts } = forecastRes.output;

  // 3. Deterministic pieces.
  const dcf: ImpliedExpectationsResult | null = input.reverseDcf
    ? impliedExpectations({ ...input.reverseDcf, internalGrowthPct: input.reverseDcf.internalGrowthPct ?? forecast.growthPct, internalMarginPct: input.reverseDcf.internalMarginPct ?? forecast.marginPct })
    : null;
  if (dcf) notes.push(...dcf.notes);

  const scenarioRes = await runScenarioAnalyst({ ticker: input.ticker, asOf: input.asOf, consensus, forecast, catalysts, framework, holdingPeriodDays: input.holdingPeriodDays, impliedExpectations: dcf ? { impliedGrowthPct: dcf.impliedGrowthPct, impliedMarginPct: dcf.impliedMarginPct, comparedToInternal: dcf.comparedToInternal } : null }, client);
  if (!scenarioRes.ok) return fail("scenarios", scenarioRes, usage);
  usage.push(scenarioRes.usage);
  const scenarios = scenarioRes.output.scenarios;

  const metric: "eps" | "revenue" = input.surpriseMetric ?? (framework.priorityMetrics[0] === "revenue" && consensus.consensusRevenue !== null ? "revenue" : consensus.consensusEps !== null ? "eps" : "revenue");
  const sensitivity = historicalSensitivity(records, metric);
  if (!sensitivity) notes.push(`no historical ${metric} sensitivity for ${input.ticker} (${records.length} records)`);
  const crowding = consensus.positioningProxy.crowdingScore;
  const next = nextCatalyst(catalysts, input.asOf);
  const nextPricedInPct = next ? next.pricedInScore * 100 : null;
  const surprise = expectedSurprise({
    metric,
    consensus: metric === "eps" ? consensus.consensusEps : consensus.consensusRevenue,
    internal: metric === "eps" ? forecast.eps : forecast.revenue,
    pricedInPct: nextPricedInPct,
    historicalSensitivity: sensitivity?.slope ?? null,
    impliedMovePct: consensus.optionsImpliedMovePct,
    valuationPercentile: input.valuationPercentile ?? null,
    crowding,
  });
  notes.push(...surprise.notes);

  const timing = assessTiming({
    catalystDaysAway: next ? daysBetweenIso(input.asOf, next.expectedDate) : null,
    holdingPeriodDays: input.holdingPeriodDays,
    technicalSetup: input.timing?.technicalSetup ?? null,
    positioningCrowding: crowding,
    liquidityScore: input.timing?.liquidityScore ?? null,
    recentMovePct: { d5: input.expectations.priceAction?.return5dPct ?? null, d20: input.expectations.priceAction?.return20dPct ?? null },
    regimeFit: input.timing?.regimeFit ?? null,
    volatility: input.timing?.volatility ?? null,
    signalDecayHalfLife: input.timing?.signalDecayHalfLife ?? null,
    signalAgeDays: input.timing?.signalAgeDays ?? null,
    direction: input.direction ?? "long",
  });

  const narrative = trackNarrative(tagged, { asOf: input.asOf, priceChangePct: input.expectations.priceAction?.return20dPct ?? null, positioningCrowding: crowding });
  notes.push(...narrative.notes);
  const disagreements = detectSourceDisagreement(input.claims ?? []);
  const pricedInScore = next ? next.pricedInScore : surprise.pricedInPct !== null ? surprise.pricedInPct / 100 : 0.5;

  // 4. Pre-mortem, red team, second order (independent of each other).
  const timingView: VariantView["timing"] = { appropriate: timing.appropriate, score: timing.score, reasons: timing.reasons };
  const surpriseView: VariantView["expectedSurprise"] = { metric: surprise.metric, consensus: surprise.consensus, internal: surprise.internal, surprisePct: surprise.surprisePct, pricedInPct: surprise.pricedInPct, historicalSensitivity: surprise.historicalSensitivity, adjustedImpactPct: surprise.adjustedImpactPct };
  const dcfView: VariantView["impliedExpectations"] = dcf ? { impliedGrowthPct: dcf.impliedGrowthPct, impliedMarginPct: dcf.impliedMarginPct, impliedReturnOnCapital: dcf.impliedReturnOnCapital, comparedToHistory: dcf.comparedToHistory, comparedToGuidance: dcf.comparedToGuidance, comparedToInternal: dcf.comparedToInternal } : null;
  const [preMortemRes, redTeamRes, secondOrderRes] = await Promise.all([
    runPreMortemAnalyst({ ticker: input.ticker, asOf: input.asOf, consensus, forecast, catalysts, scenarios, timing: timingView, expectedSurprise: surpriseView, pricedInScore, crowding, holdingPeriodDays: input.holdingPeriodDays }, client),
    runRedTeamAnalyst({ ticker: input.ticker, asOf: input.asOf, consensus, forecast, catalysts, scenarios, evidence: input.evidence, sourceDisagreements: disagreements, envelopes: input.envelopes, impliedExpectations: dcfView, timing: timingView, crowding }, client),
    runSecondOrderAnalyst({ ticker: input.ticker, asOf: input.asOf, consensus, forecast, catalysts, framework }, client),
  ]);
  if (!preMortemRes.ok) return fail("pre_mortem", preMortemRes, usage);
  usage.push(preMortemRes.usage);
  if (!redTeamRes.ok) return fail("red_team", redTeamRes, usage);
  usage.push(redTeamRes.usage);
  if (!secondOrderRes.ok) return fail("second_order", secondOrderRes, usage);
  usage.push(secondOrderRes.usage);

  // 5. Assemble.
  try {
    const assembled = assembleVariantView({
      ticker: input.ticker,
      asOf: input.asOf,
      consensus,
      internal: forecast,
      consensusStatement: narrativeOut.consensusNarrative,
      internalStatement: forecast.reasoning[0] ?? null,
      catalysts,
      holdingPeriodDays: input.holdingPeriodDays,
      timing,
      expectedSurprise: surprise,
      narrative,
      scenarios,
      impliedExpectations: dcf,
      preMortem: preMortemRes.output,
      redTeam: redTeamRes.output,
      sourceDisagreements: disagreements.map(({ topic, sourceA, claimA, sourceB, claimB, reason, moreReliable, effectOnTrade }) => ({ topic, sourceA, claimA, sourceB, claimB, reason, moreReliable, effectOnTrade })),
      evidence: input.evidence,
      secondOrder: [...secondOrderRes.output.considerations, ...secondOrderRes.output.unanswered.map((q) => `unanswered: ${q}`)],
      portfolioFit: input.portfolioFit ?? null,
      versions: { modelName: forecastRes.modelName, modelVersion: forecastRes.modelVersion, promptVersion: `${ORCHESTRATOR_PROMPT_VERSION}|${FORECAST_PROMPT_VERSION}|${SCENARIO_PROMPT_VERSION}|${PRE_MORTEM_PROMPT_VERSION}|${RED_TEAM_PROMPT_VERSION}` },
    });
    notes.push(...assembled.notes);
    return { ok: true, view: assembled.view, notes, usage, promptVersions: VARIANT_PROMPT_VERSIONS };
  } catch (err) {
    return { ok: false, error: "assembly_failed", message: `variant view failed validation: ${err instanceof Error ? err.message : String(err)}`, stage: "assemble", usage };
  }
}
