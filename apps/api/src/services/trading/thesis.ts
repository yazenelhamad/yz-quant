import type {
  CalibrationProfile, CandidateFit, DataEnvelope, EnsembleResult, ExecutionPlan, Freshness, HistoricalAnalog, PortfolioAssessment, RegimeAssessment, RiskSettings, SizingResult, SurvivalState, TenantScope,
  TradeCandidate, TradeThesis,
} from "@yz/core";
import { FEATURE_VERSION, RISK_ENGINE_VERSION, TradeThesisSchema, assertScope, calibratedConfidence as calibrateConfidence, summarizeAnalogs } from "@yz/core";
import { THESIS_WRITER_PROMPT_VERSION, makeEnvelope, runCommittee, scopeKey, type CommitteeResult, type PortfolioAssessmentInput, type StructuredModelClient, type ThesisNumbers } from "@yz/intelligence";
import type { Repos } from "../../http/app.js";
import { errorMessage, isFiniteNumber, round4 } from "./common.js";
import type { CandidateRecord, TradingStore } from "./store.js";
import type { TradingLogger } from "./types.js";

export const THESIS_BUILDER_VERSION = "thesis-builder-1.0.0";

/** Committee agents the trading cycle asks for (execution/risk officer/red team are not part of the thesis). */
export const COMMITTEE_AGENTS = ["market_regime", "quant", "market_structure", "fundamental", "news", "portfolio_manager", "devils_advocate"] as const;

export interface ThesisInputs {
  candidate: CandidateRecord;
  ensemble: EnsembleResult;
  regime: RegimeAssessment;
  features: Record<string, number | null>;
  price: number;
  fit: CandidateFit;
  assessment: PortfolioAssessment;
  sizing: SizingResult;
  plan: ExecutionPlan | null;
  settings: RiskSettings;
  analogs: HistoricalAnalog[];
  strategyPerfInRegime: { trades: number; winRate: number | null; expectancyPct: number | null; profitFactor: number | null } | null;
  /** Ensemble confidence mapped through the strategy's calibration profile (before committee adjustments). */
  calibratedConfidence: number;
  dataFreshness: Freshness;
  adv: number | null;
  spreadBps: number | null;
  annualizedVol: number | null;
  sector: string | null;
  strategyVersion: string;
  buyingPower: number;
  cash: number;
  positionCount: number;
  daysToNextEvent: number | null;
  /** The account's survival mandate, shown to the portfolio manager agent. */
  survival?: SurvivalState | null;
}

export interface ThesisBuildResult {
  thesis: TradeThesis;
  thesisId: string;
  /** Final calibrated confidence after committee adjustments (== input when the committee did not run). */
  calibratedConfidence: number;
  committee: { ran: boolean; configured: boolean; disagreement: number; votes: number; warnings: string[]; devilsAdvocateVerdict: string | null };
}

export interface ThesisDeps {
  repos: Repos;
  store: TradingStore;
  modelClient: StructuredModelClient;
  clock: () => Date;
  log?: TradingLogger;
}

export function calibrationProfileFrom(row: { profile: unknown } | undefined): CalibrationProfile | null {
  if (!row || !row.profile || typeof row.profile !== "object") return null;
  const p = row.profile as Partial<CalibrationProfile>;
  if (!Array.isArray(p.buckets) || typeof p.sampleSize !== "number") return null;
  return p as CalibrationProfile;
}

/** Ensemble confidence through the strategy's learned calibration curve; identity when no profile exists. */
export async function calibrateForStrategy(store: TradingStore, strategyKey: string, raw: number): Promise<number> {
  const profile = calibrationProfileFrom(await store.calibration(strategyKey)) ?? calibrationProfileFrom(await store.calibration("system"));
  return round4(calibrateConfidence(raw, profile));
}

function pct(v: number, dp = 1): string {
  return `${(v * 100).toFixed(dp)}%`;
}

function candidateFromRow(row: CandidateRecord, ensemble: EnsembleResult): TradeCandidate {
  return {
    id: row.id, symbol: row.symbol, strategyId: row.strategyId, strategyKey: row.strategyKey, strategyVersionId: row.strategyVersionId, direction: row.direction as TradeCandidate["direction"],
    ensemble, expectedUpsidePct: row.expectedUpsidePct, expectedDownsidePct: row.expectedDownsidePct, holdingPeriodDays: row.holdingPeriodDays, catalyst: row.catalyst, catalystAt: row.catalystAt,
    liquidityScore: row.liquidityScore, regimeFit: row.regimeFit, historicalSimilarity: (row.historicalSimilarity as TradeCandidate["historicalSimilarity"]) ?? null, createdAt: row.createdAt, expiresAt: row.expiresAt,
    status: row.status as TradeCandidate["status"],
  };
}

/** Deterministic plain-English narrative in the journal's house style. */
export function narrate(input: ThesisInputs, calibrated: number, committee: CommitteeResult | null): { entryLogic: string; plainEnglish: string } {
  const c = input.candidate;
  const view = (c.ensemble as { view?: { explanation?: string } }).view;
  const why = (view?.explanation ?? input.ensemble.explanation[0] ?? "the strategy's signals aligned").replace(/\.$/, "");
  const hs = input.analogs.length > 0 ? summarizeAnalogs(input.analogs) : null;
  const parts: string[] = [];
  parts.push(`We are buying ${c.symbol} under the ${c.strategyKey.replace(/_/g, " ")} strategy because ${why}.`);
  parts.push(`Expected edge ${input.ensemble.expectedEdge >= 0 ? "+" : ""}${input.ensemble.expectedEdge.toFixed(2)} with calibrated confidence ${pct(calibrated, 0)}; we expect about +${c.expectedUpsidePct.toFixed(1)}% upside against -${c.expectedDownsidePct.toFixed(1)}% downside over roughly ${c.holdingPeriodDays} trading days in a ${input.regime.primary.replace(/_/g, " ")} regime.`);
  if (hs && hs.analogs > 0) {
    parts.push(`The system found ${hs.analogs} similar historical setups, ${hs.positive} produced positive returns${hs.avgReturnPct !== null ? ` (average ${hs.avgReturnPct >= 0 ? "+" : ""}${hs.avgReturnPct.toFixed(1)}%)` : ""}.`);
  } else {
    parts.push("No comparable historical setups were found in the trade memory, so this thesis is not backed by analogs.");
  }
  const sizeNotes: string[] = [];
  if (input.fit.sizeMultiplier < 1) sizeNotes.push(...input.fit.notes.filter((n) => /cap|limit|concentration|correlat|capacity|duplicate/i.test(n)));
  if (input.sizing.scalingMultiplier < 1) sizeNotes.push(`sizing scaled to ${(input.sizing.scalingMultiplier * 100).toFixed(0)}% of the Kelly target (${input.sizing.bindingConstraint})`);
  if (sizeNotes.length > 0) parts.push(`Position size was reduced because ${sizeNotes.slice(0, 3).join("; ")}.`);
  else parts.push(`Position size is bound by ${input.sizing.bindingConstraint.replace(/_/g, " ")}.`);
  if (input.plan) parts.push(`Execution: ${input.plan.orderType} order${input.plan.limitPrice !== null ? ` at ${input.plan.limitPrice}` : ""}, expected cost ${input.plan.expectedCostBps.toFixed(1)} bps.`);
  if (committee && committee.votes.length > 0) {
    const tally = committee.votes.map((v) => `${v.agent} ${v.vote}`).join(", ");
    parts.push(`Committee votes: ${tally}${committee.devilsAdvocate ? `; devil's advocate verdict ${committee.devilsAdvocate.verdict}` : ""}.`);
  }
  const invalidation = c.ensemble && (c.ensemble as { view?: { invalidationPrice?: number | null } }).view?.invalidationPrice;
  parts.push(`We are wrong if ${input.regime.primary.replace(/_/g, " ")} conditions reverse${isFiniteNumber(invalidation) ? ` or price closes below ${invalidation.toFixed(2)}` : ""}, and we exit when the target is reached, the thesis is invalidated or the holding period elapses.`);
  const plainEnglish = parts.join(" ").slice(0, 2000);
  const entryLogic = [`${why}.`, ...input.ensemble.explanation.slice(0, 6)].join(" ").slice(0, 2000);
  return { entryLogic, plainEnglish };
}

async function envelopesFor(repos: Repos, symbol: string, now: Date): Promise<{ news: DataEnvelope[]; fundamentals: DataEnvelope[]; priorKnown: { contentHash: string; summary?: string; observedAt?: string }[] }> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const news: DataEnvelope[] = [];
  const priorKnown: { contentHash: string; summary?: string; observedAt?: string }[] = [];
  try {
    for (const n of await repos.market.newsFor(symbol, since, 20)) {
      const reliability = Math.max(0, Math.min(1, 1 - ((n.sourceTier ?? 7) - 1) / 10));
      news.push(makeEnvelope("news", n.source, `${n.headline}${n.summary ? `\n${n.summary}` : ""}`, n.publishedAt, reliability));
      if (n.genuinelyNew === false) priorKnown.push({ contentHash: n.contentHash, summary: n.headline, observedAt: n.publishedAt });
    }
  } catch { /* news is optional evidence */ }
  const fundamentals: DataEnvelope[] = [];
  try {
    const inst = await repos.market.instrument(symbol);
    if (inst?.meta && typeof inst.meta === "object" && Object.keys(inst.meta as object).length > 0) {
      fundamentals.push(makeEnvelope("api", "instruments.meta", JSON.stringify(inst.meta).slice(0, 6000), inst.updatedAt, 0.7));
    }
  } catch { /* optional */ }
  return { news, fundamentals, priorKnown };
}

/**
 * Build, validate and store the TradeThesis for one candidate in one account.
 *
 * Every number comes from the deterministic engines (ensemble, portfolio, sizing, execution plan).
 * When the model client is configured, the investment committee runs on data envelopes built
 * from stored news/fundamentals and its votes, devil's advocate findings and thesis text are
 * merged in; every model output is journaled in `model_outputs`. Committee failures never block
 * the deterministic path: the thesis still validates, but calibrated confidence is lowered
 *   - by committee disagreement:      confidence x (1 - 0.5 x disagreement)
 *   - by a devil's advocate "reject":  x 0.7, "reduce": x 0.85
 *   - when a configured committee failed outright (no votes): x 0.9
 * so unavailable or divided advice makes the system more conservative, never more aggressive.
 */
export async function buildThesis(scope: TenantScope, input: ThesisInputs, deps: ThesisDeps): Promise<ThesisBuildResult> {
  assertScope(scope, "buildThesis");
  const now = deps.clock();
  const nowIso = now.toISOString();
  const c = input.candidate;
  const s = input.sizing;
  const view = (c.ensemble as { view?: { invalidationPrice?: number | null; targetPrice?: number | null } }).view ?? {};
  const invalidationPrice = isFiniteNumber(view.invalidationPrice) ? view.invalidationPrice : round4(input.price * (1 - c.expectedDownsidePct / 100));
  const targetPrice = isFiniteNumber(view.targetPrice) ? view.targetPrice : round4(input.price * (1 + c.expectedUpsidePct / 100));
  const maxAcceptableLossPct = Math.min(1, Math.max(0, input.settings.maxLossPerTradePct));

  let calibrated = input.calibratedConfidence;
  let committee: CommitteeResult | null = null;
  const warnings: string[] = [];
  const key = scopeKey(scope);
  if (deps.modelClient.configured) {
    try {
      const env = await envelopesFor(deps.repos, c.symbol, now);
      const assessment: PortfolioAssessmentInput = {
        scope, asOf: input.assessment.asOf, totalValue: input.assessment.totalValue, cash: input.cash, buyingPower: input.buyingPower, positionCount: input.positionCount,
        currentSymbolPct: input.fit.duplicateExposure ? Math.max(0, input.fit.positionPctAfter - s.notional / Math.max(1, input.assessment.totalValue)) : 0,
        positionPctAfter: input.fit.positionPctAfter, sectorPctAfter: input.fit.sectorPctAfter, sector: input.sector, correlationToPortfolio: input.fit.correlationToPortfolio, betaAfter: input.fit.betaAfter,
        drawdownPct: input.assessment.currentDrawdownPct ?? 0, riskCapacity: input.assessment.riskCapacity, fitScore: input.fit.fitScore, concentrationTop5Pct: null, notes: input.fit.notes,
        ...(input.survival ? { mandate: { mode: input.survival.mode, fitnessScore: input.survival.fitnessScore, riskMultiplier: input.survival.riskMultiplier, minEdgeMultiplier: input.survival.minEdgeMultiplier, hurdleBps: input.survival.hurdleBps, runwayDays: input.survival.runway.days, allowLiveEntries: input.survival.allowLiveEntries, summary: input.survival.mandate } } : {}),
      };
      const numbers: ThesisNumbers = {
        symbol: c.symbol, strategyKey: c.strategyKey, direction: "long", marketRegime: input.regime.primary, expectedEdge: input.ensemble.expectedEdge, confidence: input.ensemble.confidence,
        calibratedConfidence: calibrated, expectedUpsidePct: c.expectedUpsidePct, expectedDownsidePct: c.expectedDownsidePct, expectedHoldingPeriodDays: c.holdingPeriodDays,
        proposedQuantity: s.quantity, proposedNotional: s.notional, invalidationPrice, targetPrice, maxAcceptableLossPct, referencePrice: input.price, catalyst: c.catalyst, catalystAt: c.catalystAt,
      };
      committee = await runCommittee({
        symbol: c.symbol, candidate: candidateFromRow(c, input.ensemble), regime: input.regime, features: input.features,
        envelopes: { news: env.news, fundamentals: env.fundamentals, filings: [] },
        portfolioAssessmentsByScope: { [key]: assessment }, thesisNumbersByScope: { [key]: numbers }, priorAnalogs: input.analogs, strategyPerfInRegime: input.strategyPerfInRegime,
        agentWeights: {}, enabledAgents: [...COMMITTEE_AGENTS], priorKnownNews: env.priorKnown, daysToNextEvent: input.daysToNextEvent, urgency: "normal",
      }, { client: deps.modelClient });
      warnings.push(...committee.warnings);
      for (const entry of committee.modelOutputsLog) {
        await deps.store.recordModelOutput({
          agentName: entry.agent, modelName: entry.modelName ?? "unknown", modelVersion: entry.modelVersion ?? "unknown", promptVersion: entry.promptVersion,
          userId: entry.scopeKey ? scope.userId : null, brokerAccountId: entry.scopeKey ? scope.brokerAccountId : null, symbol: c.symbol, candidateId: c.id, thesisId: null,
          input: null, output: null, valid: entry.valid, validationError: entry.error ? `${entry.error}${entry.message ? `: ${entry.message}` : ""}`.slice(0, 600) : null, latencyMs: entry.latencyMs, inputTokens: entry.usage?.inputTokens ?? null, outputTokens: entry.usage?.outputTokens ?? null, costUsd: entry.usage?.costUsd ?? null,
        }).catch(() => undefined);
      }
      if (committee.votes.length > 0) {
        calibrated = round4(calibrated * (1 - 0.5 * committee.disagreement));
        if (committee.devilsAdvocate?.verdict === "reject") calibrated = round4(calibrated * 0.7);
        else if (committee.devilsAdvocate?.verdict === "reduce") calibrated = round4(calibrated * 0.85);
      } else {
        calibrated = round4(calibrated * 0.9);
        warnings.push("committee produced no votes; calibrated confidence haircut x0.9");
      }
    } catch (err) {
      committee = null;
      calibrated = round4(calibrated * 0.9);
      warnings.push(`committee failed: ${errorMessage(err)}; calibrated confidence haircut x0.9`);
      deps.log?.warn({ err, symbol: c.symbol }, "investment committee failed; deterministic thesis continues");
    }
  }

  const text = narrate(input, calibrated, committee);
  const draft = committee?.thesisTextByScope[key] ?? null;
  const supportingEvidence: TradeThesis["supportingEvidence"] = draft?.text.supportingEvidence ?? [
    { source: "signal_ensemble", kind: "model", observedAt: input.ensemble.asOf, reliability: Math.max(0, Math.min(1, input.ensemble.confidence)), summary: input.ensemble.explanation.slice(0, 4).join("; ").slice(0, 600) },
    { source: "regime_engine", kind: "internal", observedAt: input.regime.asOf, reliability: input.regime.confidence, summary: `${input.regime.primary} regime (confidence ${pct(input.regime.confidence, 0)}); ${input.regime.explanation.slice(0, 2).join("; ")}`.slice(0, 600) },
  ];
  const contradictingEvidence: TradeThesis["contradictingEvidence"] = draft?.text.contradictingEvidence ?? [];
  if (committee?.devilsAdvocate) {
    for (const w of committee.devilsAdvocate.whyWrong.slice(0, 4)) contradictingEvidence.push({ source: "devils_advocate", kind: "model", observedAt: nowIso, reliability: committee.devilsAdvocate.confidence, summary: w.slice(0, 600) });
  }
  if (input.fit.fitScore < 0) contradictingEvidence.push({ source: "portfolio_engine", kind: "internal", observedAt: input.assessment.asOf, reliability: 1, summary: `Portfolio fit ${input.fit.fitScore.toFixed(2)}: ${input.fit.notes.slice(0, 3).join("; ")}`.slice(0, 600) });

  const thesisId = crypto.randomUUID();
  const thesis: TradeThesis = {
    id: thesisId, userId: scope.userId, brokerAccountId: scope.brokerAccountId, candidateId: c.id, ticker: c.symbol, strategyId: c.strategyId, strategyKey: c.strategyKey, strategyVersionId: c.strategyVersionId,
    direction: "long", expectedHoldingPeriodDays: c.holdingPeriodDays,
    entryLogic: (draft?.text.entryLogic ?? text.entryLogic).slice(0, 2000),
    expectedEdge: Math.max(-1, Math.min(1, input.ensemble.expectedEdge)), confidence: input.ensemble.confidence, calibratedConfidence: Math.max(0, Math.min(1, calibrated)), marketRegime: input.regime.primary,
    supportingEvidence, contradictingEvidence, catalyst: c.catalyst, catalystAt: c.catalystAt,
    expectedUpsidePct: c.expectedUpsidePct, expectedDownsidePct: c.expectedDownsidePct, annualizedVolatility: input.annualizedVol,
    proposedQuantity: s.quantity, proposedNotional: s.notional,
    invalidationPoint: (draft?.text.invalidationPoint ?? `Close below ${invalidationPrice.toFixed(2)} (${pct(c.expectedDownsidePct / 100)} adverse move) or regime turns hostile to ${c.strategyKey.replace(/_/g, " ")}`).slice(0, 600),
    invalidationPrice, exitConditions: (draft?.text.exitConditions ?? [`Target ${targetPrice.toFixed(2)} reached`, `Price closes below ${invalidationPrice.toFixed(2)}`, `Holding period of ${c.holdingPeriodDays} trading days elapses`, "Fast brain EXIT/REDUCE confirmed by the risk engine"]).map((x) => x.slice(0, 300)),
    targetPrice, maxAcceptableLossPct,
    portfolioImpact: { positionPctAfter: input.fit.positionPctAfter, sectorPctAfter: input.fit.sectorPctAfter, sector: input.sector, correlationToPortfolio: input.fit.correlationToPortfolio, betaAfter: input.fit.betaAfter, fitScore: input.fit.fitScore, notes: input.fit.notes },
    liquidity: { adv: input.adv, spreadBps: input.spreadBps, score: Math.max(0, Math.min(1, c.liquidityScore)) },
    executionMethod: input.plan
      ? { orderType: input.plan.orderType, limitLogic: input.plan.limitPrice !== null ? `limit ${input.plan.limitPrice}; ${input.plan.reasons.find((r) => /urgency/.test(r)) ?? ""}`.trim() : null, urgency: "normal", staging: input.plan.staging ? `${input.plan.staging.slices} slices / ${input.plan.staging.intervalSeconds}s` : null }
      : { orderType: "limit", limitLogic: null, urgency: "normal", staging: null },
    dataFreshness: input.dataFreshness,
    similarHistoricalTrades: input.analogs,
    strategyPerformanceInRegime: input.strategyPerfInRegime,
    modelVotes: (committee?.votes ?? []).map((v) => ({ agent: v.agent, vote: v.vote, confidence: v.confidence, note: (v.keyPoints[0] ?? v.risks[0] ?? "").slice(0, 400) })),
    devilsAdvocate: committee?.devilsAdvocate
      ? { whyWrong: committee.devilsAdvocate.whyWrong.map((w) => w.slice(0, 400)), late: committee.devilsAdvocate.late, pricedIn: committee.devilsAdvocate.pricedIn, sharedSignalRisk: committee.devilsAdvocate.sharedSignalRisk, eventRisk: committee.devilsAdvocate.eventRisk, recentSimilarTradesPoor: committee.devilsAdvocate.recentSimilarTradesPoor, overconfidenceFlag: committee.devilsAdvocate.overconfidenceFlag, verdict: committee.devilsAdvocate.verdict }
      : null,
    variantPerception: null,
    plainEnglish: (draft?.text.plainEnglish ?? text.plainEnglish).slice(0, 2000),
    versions: {
      modelName: committee?.configured ? (deps.modelClient.modelFor("slow_brain") ?? "unknown") : "deterministic",
      modelVersion: committee?.modelOutputsLog.find((e) => e.modelVersion)?.modelVersion ?? THESIS_BUILDER_VERSION,
      promptVersion: THESIS_WRITER_PROMPT_VERSION, featureVersion: FEATURE_VERSION, strategyVersion: input.strategyVersion, riskEngineVersion: RISK_ENGINE_VERSION,
    },
    createdAt: nowIso,
    status: "draft",
  };
  const parsed = TradeThesisSchema.safeParse(thesis);
  if (!parsed.success) throw new Error(`thesis failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  await deps.repos.theses.create(scope, {
    id: thesisId, candidateId: c.id, tradeId: null, symbol: c.symbol, strategyId: c.strategyId, strategyVersionId: c.strategyVersionId, direction: "long",
    expectedEdge: parsed.data.expectedEdge, confidence: parsed.data.confidence, calibratedConfidence: parsed.data.calibratedConfidence, marketRegime: parsed.data.marketRegime, status: "draft",
    thesis: parsed.data, modelName: parsed.data.versions.modelName, modelVersion: parsed.data.versions.modelVersion, promptVersion: parsed.data.versions.promptVersion,
  });
  return {
    thesis: parsed.data, thesisId, calibratedConfidence: parsed.data.calibratedConfidence,
    committee: { ran: committee !== null, configured: deps.modelClient.configured, disagreement: committee?.disagreement ?? 0, votes: committee?.votes.length ?? 0, warnings, devilsAdvocateVerdict: committee?.devilsAdvocate?.verdict ?? null },
  };
}

/** Load and re-validate a stored thesis. Returns null when missing or invalid (no thesis = no trade). */
export async function loadValidThesis(repos: Repos, scope: TenantScope, thesisId: string): Promise<TradeThesis | null> {
  const row = await repos.theses.byId(scope, thesisId);
  if (!row) return null;
  const parsed = TradeThesisSchema.safeParse(row.thesis);
  if (!parsed.success) return null;
  if (parsed.data.userId !== scope.userId || parsed.data.brokerAccountId !== scope.brokerAccountId) return null;
  return parsed.data;
}
