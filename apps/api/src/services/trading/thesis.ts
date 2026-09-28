import type {
  CalibrationProfile, CandidateFit, DataEnvelope, EnsembleResult, ExecutionPlan, Freshness, HistoricalAnalog, PortfolioAssessment, RegimeAssessment, RiskSettings, SizingResult, SurvivalState, TenantScope,
  TradeCandidate, TradeThesis,
} from "@yz/core";
import { FEATURE, FEATURE_VERSION, RISK_ENGINE_VERSION, TradeThesisSchema, assertScope, calibratedConfidence as calibrateConfidence, summarizeAnalogs } from "@yz/core";
import { THESIS_WRITER_PROMPT_VERSION, makeEnvelope, runCommittee, scopeKey, type CommitteeResult, type PortfolioAssessmentInput, type StructuredModelClient, type ThesisNumbers } from "@yz/intelligence";
import type { Repos } from "../../http/app.js";
import { errorMessage, isFiniteNumber, round4 } from "./common.js";
import type { CandidateRecord, TradingStore } from "./store.js";
import type { TradingLogger, EvaluationGeometry, EvaluationProbability } from "./types.js";

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
  /** Win probability the thesis may claim (breakeven for the geometry plus the calibrated signal tilt), before committee adjustments. */
  calibratedConfidence: number;
  /** Levels re-measured from the live entry price. */
  geometry?: EvaluationGeometry | null;
  /** How the win probability was arrived at. */
  probability?: EvaluationProbability | null;
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
  const g = input.geometry ?? null;
  const pr = input.probability ?? null;
  const parts: string[] = [];
  parts.push(`We are buying ${c.symbol} under the ${c.strategyKey.replace(/_/g, " ")} strategy because ${why}.`);
  // The signal score is a bounded composite of the strategy's signals, not a return forecast; say so.
  parts.push(`Signal score ${input.ensemble.expectedEdge >= 0 ? "+" : ""}${input.ensemble.expectedEdge.toFixed(2)} (a bounded composite of the strategy's signals, not a return forecast).`);
  if (g && pr && pr.breakeven !== null) {
    const stopSigma = g.stopSigma.toFixed(1);
    const targetSigma = g.targetSigma === null ? null : g.targetSigma.toFixed(1);
    parts.push(`Target ${g.targetPrice !== null ? `${g.targetPrice.toFixed(2)} ` : ""}(+${(g.upsidePct * 100).toFixed(1)}%${targetSigma ? `, ${targetSigma}σ over ${c.holdingPeriodDays} days` : ""}) against a risk stop ${g.invalidationPrice !== null ? `at ${g.invalidationPrice.toFixed(2)} ` : ""}(-${(g.downsidePct * 100).toFixed(1)}%, ${stopSigma}σ): reward/risk ${g.rewardRisk.toFixed(1)}.`);
    if (g.structuralInvalidationPrice !== null) parts.push(`The thesis level is ${g.structuralInvalidationPrice.toFixed(2)}; the risk stop sits closer because a stop that far away is not a risk limit.`);
    parts.push(`Forecast ${pr.expectedReturn >= 0 ? "+" : ""}${(pr.expectedReturn * 100).toFixed(2)}% over ${c.holdingPeriodDays} days: a signal of this score is worth about its information coefficient (${pr.informationCoefficient.toFixed(3)}) times the ${(g.sigmaHorizon * 100).toFixed(1)}% the name typically moves in that time, not the distance to the target.`);
    parts.push(`Win probability ${pct(calibrated, 0)}: this geometry breaks even at ${pct(pr.breakeven, 0)}, and the forecast adds ${(calibrated - pr.breakeven) >= 0 ? "+" : ""}${((calibrated - pr.breakeven) * 100).toFixed(1)} points. With no edge the target would be touched first ${pct(pr.noEdge.target, 0)} of the time and ${pct(pr.noEdge.neither, 0)} of paths would expire unresolved.`);
  } else {
    parts.push(`Win probability ${pct(calibrated, 0)}; we expect about +${c.expectedUpsidePct.toFixed(1)}% upside against -${c.expectedDownsidePct.toFixed(1)}% downside over roughly ${c.holdingPeriodDays} trading days in a ${input.regime.primary.replace(/_/g, " ")} regime.`);
  }
  if (hs && hs.analogs > 0) {
    parts.push(`The system found ${hs.analogs} similar historical setups, ${hs.positive} produced positive returns${hs.avgReturnPct !== null ? ` (average ${hs.avgReturnPct >= 0 ? "+" : ""}${hs.avgReturnPct.toFixed(1)}%)` : ""}.`);
  } else {
    parts.push("No comparable historical setups were found in the trade memory: the win probability rests on the base rate and the signal, not on realised outcomes.");
  }
  const sizeNotes: string[] = [];
  if (input.fit.sizeMultiplier < 1) sizeNotes.push(...input.fit.notes.filter((n) => /above|limited|exceed|cap|concentration|capacity|duplicate|shares a factor|unknown/i.test(n) && !/diversifying|low correlation/i.test(n)));
  if (input.sizing.scalingMultiplier < 1) sizeNotes.push(`sizing scaled to ${(input.sizing.scalingMultiplier * 100).toFixed(0)}% of the Kelly target (${input.sizing.bindingConstraint})`);
  if (sizeNotes.length > 0) parts.push(`Position size was reduced because ${sizeNotes.slice(0, 3).join("; ")}.`);
  else parts.push(`Position size is bound by ${input.sizing.bindingConstraint.replace(/_/g, " ")}.`);
  if (input.plan) parts.push(`Execution: ${input.plan.orderType} order${input.plan.limitPrice !== null ? ` at ${input.plan.limitPrice}` : ""}, expected cost ${input.plan.expectedCostBps.toFixed(1)} bps.`);
  if (committee && committee.votes.length > 0) {
    const tally = committee.votes.map((v) => `${v.agent} ${v.vote}`).join(", ");
    parts.push(`Committee votes: ${tally}${committee.devilsAdvocate ? `; devil's advocate verdict ${committee.devilsAdvocate.verdict}` : ""}.`);
  }
  const stopLevel = g?.invalidationPrice ?? (c.ensemble as { view?: { invalidationPrice?: number | null } }).view?.invalidationPrice ?? null;
  parts.push(`We are wrong if ${input.regime.primary.replace(/_/g, " ")} conditions reverse${isFiniteNumber(stopLevel) ? ` or price closes below ${stopLevel.toFixed(2)}` : ""}, and we exit when the target is reached, the thesis is invalidated or the holding period elapses.`);
  const plainEnglish = parts.join(" ").slice(0, 2000);
  const entryLogic = [`${why}.`, ...input.ensemble.explanation.slice(0, 6)].join(" ").slice(0, 2000);
  return { entryLogic, plainEnglish };
}

/**
 * Deterministic reasons the thesis could be wrong, from the same inputs that support it. A thesis
 * with two supporting items and none against usually means nobody looked; these always look.
 */
export function deterministicContradictions(input: ThesisInputs, nowIso: string): TradeThesis["contradictingEvidence"] {
  const out: TradeThesis["contradictingEvidence"] = [];
  const add = (source: string, summary: string, reliability = 1): void => { out.push({ source, kind: "internal", observedAt: nowIso, reliability, summary: summary.slice(0, 600) }); };
  const c = input.candidate;
  const f = input.features;
  const num = (k: string): number | null => { const v = f[k]; return typeof v === "number" && Number.isFinite(v) ? v : null; };
  if (input.analogs.length === 0) add("trade_memory", "No comparable historical setups: nothing in the trade memory has tested this pattern, so the win probability is a base rate plus a signal, not a measured hit rate.");
  for (const n of input.geometry?.notes ?? []) add("trade_geometry", `Geometry adjusted: ${n}.`);
  if (input.geometry && input.geometry.rewardRisk < 1.5) add("trade_geometry", `Reward/risk ${input.geometry.rewardRisk.toFixed(2)} is thin: the win rate must clear ${input.probability?.breakeven !== null && input.probability?.breakeven !== undefined ? pct(input.probability.breakeven, 0) : "breakeven"} just to cover the stop.`);
  if (input.dataFreshness !== "fresh") add("data_pipeline", `Input data is ${input.dataFreshness}: the signal may rest on prices that have already moved.`);
  if (input.daysToNextEvent !== null && input.daysToNextEvent <= c.holdingPeriodDays) add("calendar", `A scheduled event falls in ${input.daysToNextEvent} day(s), inside the ${c.holdingPeriodDays}-day horizon: it can gap through the stop regardless of the signal.`);
  const vdev = num(FEATURE.vwapDeviationPct);
  if (vdev !== null && vdev > 0.004) add("market_structure", `Price is ${(vdev * 100).toFixed(2)}% above intraday VWAP: the entry pays up after an intraday run.`);
  const close = num(FEATURE.close), sma20 = num(FEATURE.sma20), vol20 = num(FEATURE.realizedVol20);
  if (close !== null && sma20 !== null && sma20 > 0 && vol20 !== null && vol20 > 0) {
    const ext = (close / sma20 - 1) / ((vol20 / Math.sqrt(252)) * Math.sqrt(20));
    if (ext > 1.5) add("market_structure", `Price is ${ext.toFixed(1)}σ above its 20-day average: extended, short-term reversal risk.`);
  }
  const mom = num(FEATURE.momentum12_1);
  if (mom !== null && mom > 1.0) add("literature", `12-1 momentum ${(mom * 100).toFixed(0)}%: winners this extended are where momentum crashes hit hardest, and a single name can gap through any stop.`);
  if (c.holdingPeriodDays <= 5 && /trend|momentum|breakout|mtf/i.test(c.strategyKey)) add("literature", "A five-day-or-shorter continuation trade works against the documented short-term reversal tendency of single stocks.");
  const saturated = input.ensemble.components.filter((k) => Math.abs(k.value ?? 0) >= 0.99).map((k) => k.key);
  if (saturated.length > 0) add("signal_ensemble", `Signal score saturated at its bound for ${saturated.slice(0, 3).join(", ")}: strength beyond the threshold is not measured, so a saturated score is not extra conviction.`);
  if (input.ensemble.disagreement > 0.3) add("signal_ensemble", `Signals disagree (dispersion ${input.ensemble.disagreement.toFixed(2)}).`);
  if (input.strategyPerfInRegime && input.strategyPerfInRegime.trades >= 10 && input.strategyPerfInRegime.winRate !== null && input.strategyPerfInRegime.winRate < 0.45) add("strategy_profile", `This strategy has won only ${pct(input.strategyPerfInRegime.winRate, 0)} of ${input.strategyPerfInRegime.trades} trades in the ${input.regime.primary} regime.`);
  return out;
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
  // Committee haircuts shrink the forecast tilt over breakeven, never the breakeven itself: a
  // disputed forecast is a smaller forecast, not a coin with fewer than two sides.
  const breakevenForTilt = input.probability?.breakeven ?? null;
  const shrinkTilt = (p: number, factor: number): number => round4(breakevenForTilt === null ? p * factor : breakevenForTilt + (p - breakevenForTilt) * factor);
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
        calibrated = shrinkTilt(calibrated, 1 - 0.5 * committee.disagreement);
        if (committee.devilsAdvocate?.verdict === "reject") calibrated = shrinkTilt(calibrated, 0.7);
        else if (committee.devilsAdvocate?.verdict === "reduce") calibrated = shrinkTilt(calibrated, 0.85);
      } else {
        calibrated = shrinkTilt(calibrated, 0.9);
        warnings.push("committee produced no votes; forecast tilt haircut x0.9");
      }
    } catch (err) {
      committee = null;
      calibrated = shrinkTilt(calibrated, 0.9);
      warnings.push(`committee failed: ${errorMessage(err)}; forecast tilt haircut x0.9`);
      deps.log?.warn({ err, symbol: c.symbol }, "investment committee failed; deterministic thesis continues");
    }
  }

  const text = narrate(input, calibrated, committee);
  const draft = committee?.thesisTextByScope[key] ?? null;
  const supportingEvidence: TradeThesis["supportingEvidence"] = draft?.text.supportingEvidence ?? [
    { source: "signal_ensemble", kind: "model", observedAt: input.ensemble.asOf, reliability: Math.max(0, Math.min(1, input.ensemble.confidence)), summary: input.ensemble.explanation.slice(0, 4).join("; ").slice(0, 600) },
    { source: "regime_engine", kind: "internal", observedAt: input.regime.asOf, reliability: input.regime.confidence, summary: `${input.regime.primary} regime (confidence ${pct(input.regime.confidence, 0)}); ${input.regime.explanation.slice(0, 2).join("; ")}`.slice(0, 600) },
  ];
  const contradictingEvidence: TradeThesis["contradictingEvidence"] = [...(draft?.text.contradictingEvidence ?? []), ...deterministicContradictions(input, nowIso)];
  if (committee?.devilsAdvocate) {
    for (const w of committee.devilsAdvocate.whyWrong.slice(0, 4)) contradictingEvidence.push({ source: "devils_advocate", kind: "model", observedAt: nowIso, reliability: committee.devilsAdvocate.confidence, summary: w.slice(0, 600) });
  }
  if (input.fit.fitScore < 0) contradictingEvidence.push({ source: "portfolio_engine", kind: "internal", observedAt: input.assessment.asOf, reliability: 1, summary: `Portfolio fit ${input.fit.fitScore.toFixed(2)}: ${input.fit.notes.slice(0, 3).join("; ")}`.slice(0, 600) });

  const thesisId = crypto.randomUUID();
  const thesis: TradeThesis = {
    id: thesisId, userId: scope.userId, brokerAccountId: scope.brokerAccountId, candidateId: c.id, ticker: c.symbol, strategyId: c.strategyId, strategyKey: c.strategyKey, strategyVersionId: c.strategyVersionId,
    direction: "long", expectedHoldingPeriodDays: c.holdingPeriodDays,
    entryLogic: (draft?.text.entryLogic ?? text.entryLogic).slice(0, 2000),
    expectedEdge: Math.max(-1, Math.min(1, input.ensemble.expectedEdge)), confidence: input.probability?.signalConfidence ?? input.ensemble.confidence, calibratedConfidence: Math.max(0, Math.min(1, calibrated)), marketRegime: input.regime.primary,
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
