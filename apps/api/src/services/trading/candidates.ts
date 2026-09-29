import type { Bar, EnsembleResult, Freshness, HistoricalAnalog, Quote, RegimeAssessment, Signal, StrategyContext, StrategyOutput, TradeMemoryEntry } from "@yz/core";
import {
  FEATURE, FEATURE_VERSION, MEMORY_FEATURE_KEYS, STRATEGY_LIBRARY, buildNormalizer, combineSignals, findAnalogs, isAbstention, marketSessionAt, regimeSupport, summarizeAnalogs, vectorize,
  type VectorizedMemoryEntry,
} from "@yz/core";
import type { AppContext } from "../../http/app.js";
import { dailyBarFreshness, errorMessage, nextTradingDayClose, numOrNull, regimeFromRow, rowToBar, rowToQuote, sameSessionClose, stageRank } from "./common.js";

/** Strategies whose signal describes the current session (intraday bars, VWAP): valid only while that session is open. */
export const INTRADAY_STRATEGY_KEYS: readonly string[] = STRATEGY_LIBRARY.filter((s) => s.descriptor.interval !== "day").map((s) => s.descriptor.key);
import { ensureStrategyRows } from "./strategyRows.js";
import { TradingStore, type CandidateRecord, type StrategyRecord } from "./store.js";
import type { TradingLogger } from "./types.js";

export interface GenerateCandidatesSummary {
  asOf: string;
  strategies: number;
  symbols: number;
  evaluations: number;
  signals: number;
  created: CandidateRecord[];
  /** Fresh candidates after this run (created + still-valid earlier ones). */
  active: CandidateRecord[];
  expired: number;
  skipped: Record<string, number>;
  errors: string[];
}

interface UniverseEntry {
  symbol: string;
  features: Record<string, number | null>;
  featuresAsOf: string;
  featureFreshness: string;
  sector: string | null;
}

/** Map the feature engine's keys onto the fixed memory vector keys used by analog retrieval. */
export function memoryFeatures(features: Record<string, number | null>, regime: RegimeAssessment, extras: { regimeFit: number; expectedEdge: number; confidence: number }): Record<string, number> {
  const pick = (k: string): number | null => numOrNull(features[k]);
  const raw: Record<string, number | null> = {
    momentum_20: pick(FEATURE.ret20),
    momentum_60: pick(FEATURE.ret60),
    momentum_120: pick(FEATURE.ret120),
    rsi_14: pick(FEATURE.rsi14),
    realized_vol_20: pick(FEATURE.realizedVol20),
    vol_ratio: pick(FEATURE.relativeVolume20),
    breadth: regime.metrics.breadthPctAbove50,
    spread_bps: pick(FEATURE.spreadBps),
    liquidity_score: pick(FEATURE.liquidityScore),
    volume_ratio: pick(FEATURE.relativeVolume20),
    distance_to_52w_high: pick(FEATURE.high52wDistancePct),
    sector_relative_strength: pick(FEATURE.residualRet20),
    correlation_to_market: pick(FEATURE.corr60),
    regime_fit: extras.regimeFit,
    expected_edge: extras.expectedEdge,
    confidence: extras.confidence,
  };
  const out: Record<string, number> = {};
  for (const k of MEMORY_FEATURE_KEYS) {
    const v = raw[k];
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export interface AnalogLookup {
  entries: VectorizedMemoryEntry[];
  normalizer: ReturnType<typeof buildNormalizer>;
}

/** Load every user's closed trade memory for analog retrieval (read-only evidence). */
export async function loadAnalogMemory(store: TradingStore): Promise<AnalogLookup> {
  const rows = await store.closedTradeMemory();
  const entries: VectorizedMemoryEntry[] = rows.map((r) => ({
    tradeId: r.tradeId, scope: { userId: r.userId, brokerAccountId: r.brokerAccountId }, mode: r.mode, symbol: r.symbol, sector: r.sector, strategyKey: r.strategyKey, regime: r.regime,
    signals: r.signals, features: r.features, entryPrice: r.entryPrice, exitPrice: r.exitPrice, holdingDays: r.holdingDays, positionPct: r.positionPct, confidence: r.confidence, expectedEdge: r.expectedEdge,
    predictedDownsidePct: r.predictedDownsidePct, actualReturnPct: r.actualReturnPct, maePct: r.maePct, mfePct: r.mfePct, slippageBps: r.slippageBps, executionQuality: r.executionQuality, exitReason: r.exitReason,
    reviewClassification: r.reviewClassification as TradeMemoryEntry["reviewClassification"], lessons: r.lessons, openedAt: r.openedAt, closedAt: r.closedAt, vector: r.vector,
  }));
  return { entries, normalizer: buildNormalizer(entries) };
}

export function analogsFor(lookup: AnalogLookup, query: { features: Record<string, number>; strategyKey: string; regime: string; symbol: string; sector: string | null }, k = 10): HistoricalAnalog[] {
  if (lookup.entries.length === 0) return [];
  const vector = vectorize(query.features, MEMORY_FEATURE_KEYS, lookup.normalizer);
  return findAnalogs({ vector, strategyKey: query.strategyKey, regime: query.regime, symbol: query.symbol, sector: query.sector }, lookup.entries, k)
    .map((a) => ({ tradeId: a.tradeId, symbol: a.symbol, strategyKey: a.strategyKey, regime: a.regime, similarity: a.similarity, returnPct: a.returnPct, thesisCorrect: a.thesisCorrect, lesson: a.lesson }));
}

/** Signal-ensemble inputs learned by the learning engine, with safe defaults when absent. */
export async function ensembleInputs(store: TradingStore, strategyKey: string): Promise<{ weights: Record<string, number>; calibrationAdjustments: Record<string, number>; signalClusters: Record<string, string>; signalDecay: Record<string, number | null>; strategyCalibration: number }> {
  const weights: Record<string, number> = {};
  const signalClusters: Record<string, string> = {};
  const signalDecay: Record<string, number | null> = {};
  for (const row of await store.signalProfiles()) {
    const p = row.profile as { currentWeight?: number; cluster?: string; decayHalfLifeDays?: number | null };
    if (typeof p.currentWeight === "number" && p.currentWeight > 0) weights[row.signalKey] = p.currentWeight;
    if (typeof p.cluster === "string" && p.cluster) signalClusters[row.signalKey] = p.cluster;
    if (typeof p.decayHalfLifeDays === "number" && p.decayHalfLifeDays > 0) signalDecay[row.signalKey] = p.decayHalfLifeDays;
  }
  const cal = await store.calibration(strategyKey);
  const strategyCalibration = cal && Number.isFinite(cal.adjustment) && cal.adjustment > 0 ? cal.adjustment : 1;
  return { weights, calibrationAdjustments: {}, signalClusters, signalDecay, strategyCalibration };
}

/**
 * Shared, user-agnostic candidate generation. For every library strategy that is enabled for at
 * least one user (and globally allowed at stage >= live_shadow) and every universe symbol with
 * fresh features and bars, evaluate the strategy, persist its signals, combine them with the
 * ensemble and create a `candidates` row for long entries. Portfolio fit, sizing and risk are
 * NOT decided here: they are per account (see evaluate.ts). Doing nothing is normal: abstentions
 * and no-setup views are counted, not persisted as candidates.
 */
export async function generateCandidates(ctx: AppContext, opts: { asOf: Date; log?: TradingLogger }): Promise<GenerateCandidatesSummary> {
  const { repos } = ctx;
  const db = repos.sessionsDb();
  const store = new TradingStore(db);
  const asOf = opts.asOf.toISOString();
  const log = opts.log;
  const summary: GenerateCandidatesSummary = { asOf, strategies: 0, symbols: 0, evaluations: 0, signals: 0, created: [], active: [], expired: 0, skipped: {}, errors: [] };
  const skip = (reason: string): void => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };

  summary.expired = await store.expireCandidates(asOf);
  // An intraday signal (price vs intraday VWAP, intraday trend) describes a session. Outside the
  // regular session it is stale, so no intraday candidate is formed and any still open is expired:
  // the next session starts from its own bars, never from yesterday's afternoon.
  const session = marketSessionAt(opts.asOf);
  if (session !== "regular") summary.expired += await store.expireCandidatesForStrategies([...INTRADAY_STRATEGY_KEYS]);
  const strategyRows = await ensureStrategyRows(db);
  const global = await repos.globalRisk.get();
  const enabledByAnyUser = await store.strategyIdsEnabledByAnyUser();
  const active: { strategy: (typeof STRATEGY_LIBRARY)[number]; row: StrategyRecord; parameters: Record<string, number | string | boolean> }[] = [];
  for (const strategy of STRATEGY_LIBRARY) {
    const row = strategyRows.get(strategy.descriptor.key);
    if (!row) { skip("strategy_row_missing"); continue; }
    if (row.globallyDisabled || global.disabledStrategyIds.includes(row.id)) { skip("strategy_globally_disabled"); continue; }
    if (stageRank(row.stage) < stageRank("live_shadow")) { skip("strategy_stage_below_live_shadow"); continue; }
    if (!enabledByAnyUser.has(row.id)) { skip("strategy_not_enabled_by_any_user"); continue; }
    if (strategy.descriptor.interval !== "day" && session !== "regular") { skip("intraday_outside_regular_session"); continue; }
    let parameters: Record<string, number | string | boolean> = {};
    if (row.currentVersionId) {
      const v = await store.strategyVersion(row.currentVersionId);
      if (v) parameters = v.parameters;
    }
    active.push({ strategy, row, parameters });
  }
  summary.strategies = active.length;
  const existingFresh = await store.freshCandidates(asOf);
  summary.active = [...existingFresh];
  if (active.length === 0) return summary;

  // Universe: instruments with fresh features.
  const instruments = (await repos.market.allInstruments()).filter((i) => i.tradeable !== false && i.state !== "delisted" && (i.assetClass ?? "equity") === "equity" && !i.delistedAt);
  const universe: UniverseEntry[] = [];
  for (const inst of instruments) {
    const f = await repos.market.latestFeatures(inst.symbol, FEATURE_VERSION);
    if (!f) { skip("no_features"); continue; }
    if (f.freshness === "stale" || f.freshness === "unknown") { skip("features_not_fresh"); continue; }
    if (dailyBarFreshness(f.asOf, asOf) === "stale") { skip("features_too_old"); continue; }
    universe.push({ symbol: inst.symbol, features: f.values, featuresAsOf: f.asOf, featureFreshness: f.freshness, sector: inst.sector ?? null });
  }
  summary.symbols = universe.length;
  if (universe.length === 0) return summary;

  const regimeRow = await repos.market.latestRegime();
  const regime = regimeFromRow(regimeRow, asOf);
  const needsIntraday = active.some((a) => a.strategy.descriptor.interval === "5minute");
  const symbols = universe.map((u) => u.symbol);
  const quotes = new Map((await repos.market.latestQuotes(symbols)).map((q) => [q.symbol, rowToQuote(q)]));
  const horizonEnd = new Date(opts.asOf.getTime() + 60 * 86_400_000).toISOString();
  // Recent past reports are included (last 20 days) so reversion strategies can refuse a post-earnings slide.
  const earnings = await repos.market.upcomingEarnings(symbols, new Date(opts.asOf.getTime() - 20 * 86_400_000).toISOString(), horizonEnd);
  const universeCtx = universe.map((u) => ({ symbol: u.symbol, features: u.features }));
  const analogMemory = await loadAnalogMemory(store);
  const ensembleByStrategy = new Map<string, Awaited<ReturnType<typeof ensembleInputs>>>();
  const expiresAt = nextTradingDayClose(opts.asOf);
  // Intraday candidates die with their session.
  const intradayExpiresAt = sameSessionClose(opts.asOf) ?? expiresAt;
  const freshKeys = new Set(existingFresh.map((c) => `${c.symbol}:${c.strategyKey}`));

  for (const u of universe) {
    let bars: Bar[];
    let intradayBars: Bar[] = [];
    try {
      bars = (await repos.market.bars(u.symbol, "day", { limit: 300, end: asOf })).map(rowToBar);
      if (needsIntraday) intradayBars = (await repos.market.bars(u.symbol, "5minute", { limit: 200, end: asOf })).map(rowToBar);
    } catch (err) {
      summary.errors.push(`${u.symbol}: bars ${errorMessage(err)}`);
      continue;
    }
    if (bars.length === 0) { skip("no_bars"); continue; }
    const quote: Quote | null = quotes.get(u.symbol) ?? null;
    const upcomingEvents = earnings.filter((e) => e.symbol === u.symbol).map((e) => ({ kind: "earnings", at: e.reportAt, description: `Earnings report (${e.timing ?? "timing unknown"})` }));

    for (const { strategy, row, parameters } of active) {
      const d = strategy.descriptor;
      if (d.interval === "5minute" && intradayBars.length < 12) { skip("no_intraday_bars"); continue; }
      const sctx: StrategyContext = {
        asOf, symbol: u.symbol, bars, intradayBars: d.interval === "5minute" ? intradayBars : undefined, quote, features: u.features, regime,
        universe: d.needsUniverse ? universeCtx : undefined, sector: null, upcomingEvents, position: null, parameters, featureVersion: FEATURE_VERSION,
      };
      let out: StrategyOutput;
      try {
        out = strategy.evaluate(sctx);
      } catch (err) {
        summary.errors.push(`${d.key}/${u.symbol}: ${errorMessage(err)}`);
        continue;
      }
      summary.evaluations += 1;
      if (isAbstention(out) || !out.view) { skip("abstained"); continue; }
      const view = out.view;
      if (view.explanation.startsWith("Abstained") || view.explanation.startsWith("No setup") || view.strength === 0) { skip("no_setup"); continue; }
      if (view.direction !== "long" || view.strength <= 0) { skip("not_a_long_entry"); continue; }
      if (out.signals.length > 0) {
        await repos.market.recordSignals(out.signals.map((s: Signal) => ({
          key: s.key, strategyKey: s.strategyKey, symbol: s.symbol, direction: s.direction, value: s.value, confidence: s.confidence, horizonDays: s.horizonDays,
          asOf: s.asOf, featureVersion: s.featureVersion, inputFreshness: s.inputFreshness, explanation: s.explanation,
        })));
        summary.signals += out.signals.length;
      }
      let inputs = ensembleByStrategy.get(d.key);
      if (!inputs) { inputs = await ensembleInputs(store, d.key); ensembleByStrategy.set(d.key, inputs); }
      const calibrationAdjustments: Record<string, number> = {};
      for (const s of out.signals) calibrationAdjustments[s.key] = inputs.strategyCalibration;
      const ensemble: EnsembleResult = combineSignals({
        symbol: u.symbol, strategyKey: d.key, family: d.family, asOf, signals: out.signals, regime,
        weights: inputs.weights, calibrationAdjustments, signalClusters: inputs.signalClusters, signalDecay: inputs.signalDecay,
        dataQuality: u.featureFreshness as Freshness,
      });
      if (ensemble.expectedEdge <= 0 || ensemble.confidence <= 0) { skip("no_positive_edge"); continue; }
      const key = `${u.symbol}:${d.key}`;
      if (freshKeys.has(key)) { skip("candidate_already_open"); continue; }
      const regimeFit = regimeSupport(regime, d.supportedRegimes);
      const event = upcomingEvents.find((e) => { const dt = (Date.parse(e.at) - opts.asOf.getTime()) / 86_400_000; return dt >= -0.5 && dt <= view.horizonDays; });
      const analogs = analogsFor(analogMemory, { features: memoryFeatures(u.features, regime, { regimeFit, expectedEdge: ensemble.expectedEdge, confidence: ensemble.confidence }), strategyKey: d.key, regime: regime.primary, symbol: u.symbol, sector: u.sector });
      const hs = analogs.length > 0 ? summarizeAnalogs(analogs) : null;
      try {
        const created = await store.insertCandidate({
          symbol: u.symbol, strategyId: row.id, strategyKey: d.key, strategyVersionId: row.currentVersionId, direction: "long",
          ensemble: { ...ensemble, view: { strength: view.strength, confidence: view.confidence, explanation: view.explanation, invalidationPrice: view.invalidationPrice, targetPrice: view.targetPrice, rewardRisk: view.rewardRisk ?? null, stopSigma: view.stopSigma ?? null, targetSigma: view.targetSigma ?? null, structuralInvalidationPrice: view.structuralInvalidationPrice ?? null, geometryNotes: view.geometryNotes ?? [] }, analogs },
          expectedUpsidePct: view.expectedUpsidePct, expectedDownsidePct: view.expectedDownsidePct, holdingPeriodDays: view.horizonDays,
          catalyst: event ? `${event.kind}: ${event.description}` : null, catalystAt: event ? event.at : null,
          liquidityScore: numOrNull(u.features[FEATURE.liquidityScore]) ?? 0, regimeFit,
          historicalSimilarity: hs ? { analogs: hs.analogs, positive: hs.positive, avgReturnPct: hs.avgReturnPct, thesisCorrectRate: hs.thesisCorrectRate } : null,
          status: "candidate", expiresAt: d.interval === "day" ? expiresAt : intradayExpiresAt,
        });
        summary.created.push(created);
        summary.active.push(created);
        freshKeys.add(key);
      } catch (err) {
        summary.errors.push(`${d.key}/${u.symbol}: persist ${errorMessage(err)}`);
      }
    }
  }
  if (summary.errors.length > 0) log?.warn({ errors: summary.errors.slice(0, 10) }, "candidate generation had errors");
  return summary;
}
