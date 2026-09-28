import type {
  EnsembleResult, FastBrainInput, FastBrainOutput, Freshness, GlobalRiskState, HistoricalAnalog, KillSwitchState, MarketSession, PerformanceStats, RegimeAssessment, RejectionReason, RiskAction,
  RiskEvaluation, RiskInput, RiskSettings, StrategyIntelligenceProfile, StrategyStage, TenantScope, TradeMode,
} from "@yz/core";
import {
  CrossTenantError, FEATURE, FEATURE_VERSION, assess, assertScope, computeSize, decide, evaluate as riskEvaluate, marketSessionAt, minutesToClose, pearsonCorrelation, planExecution,
  sameScope, spreadBpsFromQuote, worstFreshnessOf,
} from "@yz/core";
import type { BrokerAdapter } from "@yz/broker";
import type { BrokerAccountRow, OrderRow, PositionRow } from "@yz/db";
import type { QuoteWithQuality } from "../marketData.js";
import { LIVE_STAGES, SHADOW_OR_LIVE_STAGES, dailyBarFreshness, errorMessage, isFiniteNumber, numOrNull, regimeFreshness, regimeFromRow, round4, rowToBar, utcDayStart, utcWeekStart } from "./common.js";
import { emitSafe } from "./events.js";
import type { CandidateRecord, StrategyRecord, UserStrategySettingsRecord } from "./store.js";
import { buildThesis, calibrateForStrategy } from "./thesis.js";
import type { EvaluateOptions, EvaluationSnapshot, FinalStatus, TradingRuntime } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Account context (everything the engines need about ONE account, loaded through scoped repos)
// ---------------------------------------------------------------------------------------------

export interface InstrumentInfo { symbol: string; sector: string | null; beta: number | null; adv: number | null; fractional: boolean; tradeable: boolean | null }

export interface AccountContext {
  scope: TenantScope;
  account: BrokerAccountRow;
  settings: RiskSettings;
  now: Date;
  nowIso: string;
  session: MarketSession;
  snapshot: { asOf: string; totalValue: number; cash: number; buyingPower: number } | null;
  positions: PositionRow[];
  instruments: Map<string, InstrumentInfo>;
  openOrders: OrderRow[];
  global: GlobalRiskState;
  killSwitch: KillSwitchState;
  reconciliation: { ok: boolean | null; ageSeconds: number | null; positionMismatch: boolean; unexpectedPosition: boolean };
  portfolio: { totalValue: number | null; cash: number | null; buyingPower: number | null; dailyPnlPct: number | null; weeklyPnlPct: number | null; drawdownPct: number | null; peakValue: number | null; deployedPct: number | null };
}

export function globalStateFromRow(row: { liveExecutionDisabled: boolean; forceShadowMode: boolean; pausedUsers: string[]; disabledStrategyIds: string[]; killSwitchActive: boolean; killSwitchReasons: string[]; killSwitchNote: string | null; killSwitchTriggeredAt: string | null; killSwitchTriggeredBy: string | null; updatedAt: string; updatedBy: string | null }): GlobalRiskState {
  return {
    liveExecutionDisabled: row.liveExecutionDisabled, forceShadowMode: row.forceShadowMode, pausedUsers: row.pausedUsers ?? [], disabledStrategyIds: row.disabledStrategyIds ?? [],
    globalKillSwitch: { scope: null, active: row.killSwitchActive, reasons: (row.killSwitchReasons ?? []) as KillSwitchState["reasons"], allowRiskReducingExits: true, triggeredAt: row.killSwitchTriggeredAt, triggeredBy: row.killSwitchTriggeredBy, note: row.killSwitchNote },
    updatedAt: row.updatedAt, updatedBy: row.updatedBy,
  };
}

export function killSwitchStateFromRow(scope: TenantScope, row: { active: boolean; reasons: string[]; allowRiskReducingExits: boolean; triggeredAt: string | null; triggeredBy: string | null; note: string | null } | undefined): KillSwitchState {
  return row
    ? { scope, active: row.active, reasons: row.reasons as KillSwitchState["reasons"], allowRiskReducingExits: row.allowRiskReducingExits, triggeredAt: row.triggeredAt, triggeredBy: row.triggeredBy, note: row.note }
    : { scope, active: false, reasons: [], allowRiskReducingExits: true, triggeredAt: null, triggeredBy: null, note: null };
}

/** Load the account context for a scope. Returns null when the account is not in the scope (never throws for that). */
export async function loadAccountContext(rt: TradingRuntime, scope: TenantScope): Promise<AccountContext | null> {
  assertScope(scope, "loadAccountContext");
  const { repos } = rt;
  const account = await repos.accounts.forScope(scope);
  if (!account) return null;
  const now = rt.clock();
  const nowIso = now.toISOString();
  const [settings, snapshotRow, positions, openOrders, globalRow, ksRow, recon, peak] = await Promise.all([
    repos.riskSettings.get(scope), repos.snapshots.latest(scope), repos.positions.list(scope), repos.orders.open(scope), repos.globalRisk.get(), repos.killSwitches.get(scope), repos.reconciliations.latest(scope), repos.snapshots.peak(scope),
  ]);
  const instRows = await repos.market.instrumentsFor(positions.map((p) => p.symbol));
  const instruments = new Map<string, InstrumentInfo>(instRows.map((i) => [i.symbol, { symbol: i.symbol, sector: i.sector, beta: i.beta, adv: i.avgDollarVolume20, fractional: i.fractional === true, tradeable: i.tradeable }]));

  let dailyPnlPct: number | null = null;
  let weeklyPnlPct: number | null = null;
  let drawdownPct: number | null = null;
  if (snapshotRow) {
    const total = snapshotRow.totalValue;
    if (isFiniteNumber(snapshotRow.dailyPnl) && total - snapshotRow.dailyPnl > 0) dailyPnlPct = snapshotRow.dailyPnl / (total - snapshotRow.dailyPnl);
    else {
      const first = await repos.snapshots.firstSince(scope, utcDayStart(now).toISOString());
      if (first && first.totalValue > 0) dailyPnlPct = (total - first.totalValue) / first.totalValue;
    }
    const weekFirst = await repos.snapshots.firstSince(scope, utcWeekStart(now).toISOString());
    // With no earlier snapshot this week, the week's P&L is at least today's (never assumed better than known).
    weeklyPnlPct = weekFirst && weekFirst.totalValue > 0 ? (total - weekFirst.totalValue) / weekFirst.totalValue : dailyPnlPct;
    drawdownPct = isFiniteNumber(snapshotRow.drawdownPct) ? snapshotRow.drawdownPct : (isFiniteNumber(peak) && peak > 0 ? Math.max(0, (peak - total) / peak) : null);
  }
  let deployedPct: number | null = null;
  if (snapshotRow && snapshotRow.totalValue > 0) {
    if (positions.every((p) => isFiniteNumber(p.marketValue))) deployedPct = positions.reduce((s, p) => s + Math.abs(p.marketValue as number), 0) / snapshotRow.totalValue;
    else deployedPct = isFiniteNumber(snapshotRow.exposurePct) ? snapshotRow.exposurePct : null;
  }
  return {
    scope, account, settings, now, nowIso, session: marketSessionAt(now),
    snapshot: snapshotRow ? { asOf: snapshotRow.asOf, totalValue: snapshotRow.totalValue, cash: snapshotRow.cash, buyingPower: snapshotRow.buyingPower } : null,
    positions, instruments, openOrders, global: globalStateFromRow(globalRow), killSwitch: killSwitchStateFromRow(scope, ksRow),
    reconciliation: { ok: recon ? recon.ok : null, ageSeconds: recon ? Math.max(0, (now.getTime() - Date.parse(recon.at)) / 1000) : null, positionMismatch: (recon?.positionMismatches?.length ?? 0) > 0, unexpectedPosition: (recon?.unexpectedPositions?.length ?? 0) > 0 },
    portfolio: {
      totalValue: snapshotRow?.totalValue ?? null, cash: snapshotRow?.cash ?? null, buyingPower: snapshotRow?.buyingPower ?? null, dailyPnlPct, weeklyPnlPct, drawdownPct, peakValue: isFiniteNumber(peak) ? peak : (snapshotRow?.totalValue ?? null), deployedPct,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Symbol context (quote, freshness, features, correlation, events)
// ---------------------------------------------------------------------------------------------

export interface SymbolContext {
  symbol: string;
  quote: QuoteWithQuality | null;
  quoteFreshness: Freshness;
  quoteAgeSeconds: number | null;
  barsFreshness: Freshness;
  regime: RegimeAssessment;
  regimeFreshness: Freshness;
  dataFreshness: Freshness;
  features: Record<string, number | null>;
  instrument: InstrumentInfo;
  spreadBps: number | null;
  adv: number | null;
  annualizedVol: number | null;
  atrPct: number | null;
  correlationToPortfolio: number | null;
  correlationByPosition: Map<string, number>;
  eventWithinHorizon: boolean;
  daysToNextEvent: number | null;
  minutesToClose: number | null;
}

async function alignedReturns(rt: TradingRuntime, symbols: string[], endIso: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const s of symbols) {
    try {
      const bars = (await rt.repos.market.bars(s, "day", { limit: 70, end: endIso })).map(rowToBar);
      const m = new Map<string, number>();
      for (let i = 1; i < bars.length; i += 1) {
        const prev = bars[i - 1]!; const cur = bars[i]!;
        if (prev.close > 0) m.set(cur.time.slice(0, 10), cur.close / prev.close - 1);
      }
      out.set(s, m);
    } catch { /* missing bars => unknown correlation */ }
  }
  return out;
}

export async function loadSymbolContext(rt: TradingRuntime, acct: AccountContext, symbol: string, horizonDays: number): Promise<SymbolContext> {
  const { repos } = rt;
  const nowIso = acct.nowIso;
  const [quotes, latestBar, regimeRow, featureRow, instRow] = await Promise.all([
    rt.marketData.getQuotes([symbol], 30).catch(() => [] as QuoteWithQuality[]), repos.market.latestBarTime(symbol, "day"), repos.market.latestRegime(), repos.market.latestFeatures(symbol, FEATURE_VERSION), repos.market.instrument(symbol),
  ]);
  const quote = quotes.find((q) => q.symbol === symbol) ?? null;
  const features = featureRow?.values ?? {};
  const instrument: InstrumentInfo = {
    symbol, sector: instRow?.sector ?? null, beta: instRow?.beta ?? numOrNull(features[FEATURE.beta60]), adv: instRow?.avgDollarVolume20 ?? numOrNull(features[FEATURE.avgDollarVolume20]), fractional: instRow?.fractional === true, tradeable: instRow?.tradeable ?? null,
  };
  const quoteFreshness: Freshness = quote ? quote.freshness : "unknown";
  const barsFreshness = dailyBarFreshness(latestBar, nowIso);
  const regime = regimeFromRow(regimeRow, nowIso);
  const rf = regimeFreshness(regimeRow, nowIso);
  const spreadBps = quote ? spreadBpsFromQuote(quote.bid, quote.ask) : numOrNull(features[FEATURE.spreadBps]);

  // Correlation of the candidate to each held position over the last 60 sessions (aligned by date).
  const held = acct.positions.map((p) => p.symbol).filter((s) => s !== symbol);
  const correlationByPosition = new Map<string, number>();
  let correlationToPortfolio: number | null = null;
  if (held.length > 0) {
    const rets = await alignedReturns(rt, [symbol, ...held], nowIso);
    const mine = rets.get(symbol);
    let wsum = 0; let w = 0;
    for (const p of acct.positions) {
      if (p.symbol === symbol) continue;
      const theirs = rets.get(p.symbol);
      if (!mine || !theirs) continue;
      const days = [...mine.keys()].filter((d) => theirs.has(d)).sort().slice(-60);
      if (days.length < 20) continue;
      const r = pearsonCorrelation(days.map((d) => mine.get(d) as number), days.map((d) => theirs.get(d) as number));
      if (r === null) continue;
      correlationByPosition.set(p.symbol, r);
      const weight = Math.abs(p.marketValue ?? 0);
      wsum += r * weight; w += weight;
    }
    if (w > 0) correlationToPortfolio = Math.max(-1, Math.min(1, wsum / w));
  }

  const horizonEnd = new Date(acct.now.getTime() + Math.max(1, horizonDays) * 86_400_000).toISOString();
  const events = await repos.market.upcomingEarnings([symbol], nowIso, horizonEnd).catch(() => []);
  const next = events.map((e) => Date.parse(e.reportAt)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b)[0];
  return {
    symbol, quote, quoteFreshness, quoteAgeSeconds: quote?.ageSeconds ?? null, barsFreshness, regime, regimeFreshness: rf,
    dataFreshness: worstFreshnessOf(quoteFreshness, barsFreshness, rf), features, instrument, spreadBps, adv: instrument.adv,
    annualizedVol: numOrNull(features[FEATURE.realizedVol20]), atrPct: numOrNull(features[FEATURE.atrPct]), correlationToPortfolio, correlationByPosition,
    eventWithinHorizon: events.length > 0, daysToNextEvent: next === undefined ? null : Math.round((next - acct.now.getTime()) / 86_400_000), minutesToClose: minutesToClose(acct.now),
  };
}

// ---------------------------------------------------------------------------------------------
// Mode, adapter and risk input helpers
// ---------------------------------------------------------------------------------------------

export interface StrategyContextForAccount {
  row: StrategyRecord;
  setting: UserStrategySettingsRecord | undefined;
  userStage: StrategyStage;
  enabledForUser: boolean;
  isEventStrategy: boolean;
  settingsForRisk: RiskSettings;
}

/** Merge per-strategy user overrides into the account risk settings (overrides can only tighten). */
export function strategyContextForAccount(acct: AccountContext, row: StrategyRecord, setting: UserStrategySettingsRecord | undefined): StrategyContextForAccount {
  const s = acct.settings;
  const restricted = [...s.restrictedSymbols, ...(setting?.blockedSymbols ?? [])];
  let allowed = s.allowedSymbols;
  if (setting?.allowedSymbols && setting.allowedSymbols.length > 0) {
    allowed = allowed === null ? setting.allowedSymbols : allowed.filter((x) => setting.allowedSymbols!.map((y) => y.toUpperCase()).includes(x.toUpperCase()));
  }
  return {
    row, setting, userStage: (setting?.stage ?? "research") as StrategyStage, enabledForUser: setting?.enabled === true, isEventStrategy: row.family === "event",
    settingsForRisk: { ...s, restrictedSymbols: restricted, allowedSymbols: allowed, minConfidence: Math.max(s.minConfidence, setting?.minConfidence ?? 0), minExpectedEdge: Math.max(s.minExpectedEdge, setting?.minExpectedEdge ?? 0) },
  };
}

/**
 * shadow when: user stage is live_shadow, autonomy is research_only/shadow, global force-shadow, or the account is simulated.
 * live only when: user stage limited_live/live AND global stage limited_live/live AND autonomy >= manual_approval AND broker connected.
 * Anything else (e.g. live stage but broker disconnected) evaluates in shadow so the decision is still journaled.
 */
export function resolveMode(acct: AccountContext, strat: StrategyContextForAccount): { mode: TradeMode; why: string } {
  const autonomy = acct.account.autonomyLevel;
  if (acct.account.kind === "simulated") return { mode: "shadow", why: "simulated account" };
  if (acct.global.forceShadowMode) return { mode: "shadow", why: "global force-shadow mode" };
  if (autonomy === "research_only" || autonomy === "shadow") return { mode: "shadow", why: `autonomy ${autonomy}` };
  if (!LIVE_STAGES.has(strat.userStage) || !LIVE_STAGES.has(strat.row.stage)) return { mode: "shadow", why: `strategy stage user=${strat.userStage} global=${strat.row.stage}` };
  if (acct.account.status !== "connected") return { mode: "shadow", why: `broker ${acct.account.status}` };
  return { mode: "live", why: "live stage, live autonomy, broker connected" };
}

/** The adapter an execution in `mode` would use for this account. Never a live adapter for shadow on a real account. */
export async function resolveExecutionAdapter(rt: TradingRuntime, acct: AccountContext, mode: TradeMode): Promise<BrokerAdapter | null> {
  if (acct.account.kind === "simulated") return rt.broker.adapterFor(acct.scope);
  if (mode === "shadow") return rt.shadowBooks.adapterFor(acct.scope, acct.account);
  const adapter = await rt.broker.adapterFor(acct.scope);
  if (!adapter) return null;
  if (adapter.binding.kind !== acct.account.kind) return null;
  return adapter;
}

export function adapterMappingVerified(adapter: BrokerAdapter | null, acct: AccountContext): boolean {
  return !!adapter && sameScope(adapter.binding.scope, acct.scope) && adapter.binding.accountNumber === acct.account.accountNumber;
}

export interface RiskInputArgs {
  acct: AccountContext;
  sym: SymbolContext;
  strat: StrategyContextForAccount | null;
  mode: TradeMode;
  action: RiskAction;
  side: "buy" | "sell";
  quantity: number;
  price: number | null;
  candidateId: string | null;
  tradeId: string | null;
  identityVerified: boolean;
  accountMappingVerified: boolean;
  metrics: RiskInput["candidate"];
  eventRiskWithinHorizon: boolean;
}

export function buildRiskInput(a: RiskInputArgs): RiskInput {
  const { acct, sym } = a;
  return {
    decisionId: crypto.randomUUID(), candidateId: a.candidateId, tradeId: a.tradeId, scope: acct.scope, now: acct.nowIso, action: a.action, symbol: sym.symbol, side: a.side,
    quantity: a.quantity, price: a.price, estimatedNotional: a.price !== null ? a.quantity * a.price : null, assetClass: "equity", sector: sym.instrument.sector, mode: a.mode, fractionalAllowed: sym.instrument.fractional,
    candidate: a.metrics,
    dataQuality: { quoteFreshness: sym.quoteFreshness, quoteAgeSeconds: sym.quoteAgeSeconds, barsFreshness: sym.barsFreshness, regimeFreshness: sym.regimeFreshness, contradictory: false },
    portfolio: {
      totalValue: acct.portfolio.totalValue, cash: acct.portfolio.cash, buyingPower: acct.portfolio.buyingPower,
      positions: acct.positions.map((p) => ({ symbol: p.symbol, assetClass: p.assetClass as "equity" | "option" | "crypto", sector: acct.instruments.get(p.symbol)?.sector ?? null, beta: acct.instruments.get(p.symbol)?.beta ?? null, quantity: p.quantity, marketValue: isFiniteNumber(p.marketValue) ? p.marketValue : null, correlationToCandidate: sym.correlationByPosition.get(p.symbol) ?? null })),
      openOrdersCount: acct.openOrders.length, currentDrawdownPct: acct.portfolio.drawdownPct, dailyPnlPct: acct.portfolio.dailyPnlPct, weeklyPnlPct: acct.portfolio.weeklyPnlPct, peakValue: acct.portfolio.peakValue,
    },
    settings: a.strat?.settingsForRisk ?? acct.settings, global: acct.global,
    account: {
      identityVerified: a.identityVerified, accountMappingVerified: a.accountMappingVerified, paused: acct.account.tradingPaused, brokerStatus: acct.account.status as RiskInput["account"]["brokerStatus"],
      reconciliationOk: acct.reconciliation.ok, reconciliationAgeSeconds: acct.reconciliation.ageSeconds, autonomyLevel: acct.account.autonomyLevel as RiskInput["account"]["autonomyLevel"], killSwitch: acct.killSwitch,
    },
    market: { session: acct.session },
    strategy: a.strat
      ? { strategyId: a.strat.row.id, enabledForUser: a.strat.enabledForUser, globallyDisabled: a.strat.row.globallyDisabled, userStage: a.strat.userStage, globalStage: a.strat.row.stage as StrategyStage, optionsAllowed: a.strat.setting?.optionsAllowed === true, isEventStrategy: a.strat.isEventStrategy }
      : { strategyId: "manual", enabledForUser: true, globallyDisabled: false, userStage: "live", globalStage: "live", optionsAllowed: false, isEventStrategy: false },
    eventRiskWithinHorizon: a.eventRiskWithinHorizon,
  };
}

const REASON_BY_CHECK: Record<string, RejectionReason> = {
  min_confidence: "insufficient_confidence", min_expected_edge: "insufficient_expected_edge",
  position_size: "portfolio_concentration", capital_deployed: "portfolio_concentration", sector_exposure: "portfolio_concentration", correlated_exposure: "portfolio_concentration", max_positions: "portfolio_concentration", portfolio_beta: "portfolio_concentration",
  min_liquidity: "poor_liquidity", max_spread: "poor_liquidity", max_loss_per_trade: "bad_risk_reward", event_risk: "event_risk",
  data_freshness: "stale_data", data_contradictory: "stale_data",
  strategy_enabled: "strategy_disabled", strategy_globally_disabled: "strategy_disabled", strategy_stage: "strategy_disabled", symbol_restricted: "strategy_disabled", symbol_allowed: "strategy_disabled",
  kill_switch_global: "kill_switch", kill_switch_account: "kill_switch",
  autonomy_level: "autonomy_level", force_shadow_mode: "autonomy_level", live_execution_disabled: "autonomy_level",
  broker_connected: "broker_unavailable", reconciliation_ok: "broker_unavailable",
  identity_verified: "identity_uncertain", account_mapping_verified: "identity_uncertain",
};

export function rejectionReasonsFromRisk(decision: RiskEvaluation): RejectionReason[] {
  const out = new Set<RejectionReason>();
  for (const c of decision.checks) {
    if (c.passed || c.severity !== "blocking") continue;
    out.add(REASON_BY_CHECK[c.code] ?? "risk_limit_exceeded");
  }
  if (decision.failedClosed) out.add("other");
  if (decision.verdict === "reject" && out.size === 0) out.add("risk_limit_exceeded");
  return [...out];
}

export async function recordRiskDecision(rt: TradingRuntime, scope: TenantScope, decision: RiskEvaluation, tradeId: string | null = null): Promise<void> {
  await rt.repos.riskDecisions.record(scope, {
    id: decision.id || crypto.randomUUID(), candidateId: decision.candidateId, tradeId: tradeId ?? decision.tradeId, symbol: decision.symbol, action: decision.action, verdict: decision.verdict,
    requestedQuantity: decision.requestedQuantity, approvedQuantity: decision.approvedQuantity, approvedNotional: decision.approvedNotional, checks: decision.checks, reasons: decision.reasons,
    failedClosed: decision.failedClosed, riskEngineVersion: decision.riskEngineVersion, decidedAt: decision.decidedAt || rt.clock().toISOString(),
  });
}

function perfFromStats(stats: PerformanceStats | undefined): { winRate: number | null; payoffRatio: number | null; trades: number } | null {
  if (!stats || stats.trades <= 0) return null;
  const payoff = isFiniteNumber(stats.avgWinPct) && isFiniteNumber(stats.avgLossPct) && stats.avgLossPct !== 0 ? Math.abs(stats.avgWinPct / stats.avgLossPct) : null;
  return { winRate: stats.winRate, payoffRatio: payoff, trades: stats.trades };
}

// ---------------------------------------------------------------------------------------------
// The per-account evaluation: portfolio engine -> sizing -> thesis -> fast brain -> risk engine
// ---------------------------------------------------------------------------------------------

export function snapshotFromStored(scope: TenantScope, candidate: CandidateRecord, row: { finalStatus: string; portfolioFit: number; sizeMultiplier: number; proposedQuantity: number; fastBrain: unknown; detail: unknown; createdAt: string }): EvaluationSnapshot {
  const d = (row.detail && typeof row.detail === "object" ? row.detail : {}) as Partial<EvaluationSnapshot> & { regime?: RegimeAssessment };
  return {
    scope, candidate, ensemble: candidate.ensemble as EnsembleResult, regime: d.regime ?? (candidate.ensemble as { regime?: RegimeAssessment }).regime ?? ({} as RegimeAssessment), mode: d.mode ?? "shadow",
    finalStatus: row.finalStatus as FinalStatus, reasons: d.reasons ?? [], rejectionReasons: d.rejectionReasons ?? [], price: d.price ?? null, quantity: d.quantity ?? row.proposedQuantity, notional: d.notional ?? 0,
    assessment: d.assessment ?? null, fit: d.fit ?? null, sizing: d.sizing ?? null, fastBrain: (row.fastBrain as FastBrainOutput | null) ?? null, risk: d.risk ?? null, thesisId: d.thesisId ?? null, thesis: null,
    calibratedConfidence: d.calibratedConfidence ?? 0, strategyId: candidate.strategyId, strategyVersionId: candidate.strategyVersionId, accountNumber: d.accountNumber ?? "", evaluatedAt: d.evaluatedAt ?? row.createdAt, replay: true,
  };
}

/**
 * Evaluate one shared candidate for ONE account. Every input is loaded through scoped repositories;
 * every output is written under the same scope. The order is fixed: portfolio engine -> sizing ->
 * thesis (deterministic, optionally enriched) -> fast brain -> deterministic risk engine (absolute
 * veto). Missing inputs fail closed into a recorded rejection. A candidate already evaluated for
 * the scope is returned from storage (`replay: true`) so it can never produce a second order.
 */
export async function evaluateCandidateForAccount(rt: TradingRuntime, scope: TenantScope, candidate: CandidateRecord, opts: EvaluateOptions): Promise<EvaluationSnapshot> {
  assertScope(scope, "evaluateCandidateForAccount");
  const { repos, store } = rt;
  const existing = await store.evaluationForCandidate(scope, candidate.id);
  if (existing) return snapshotFromStored(scope, candidate, existing);

  const acct = await loadAccountContext(rt, scope);
  if (!acct) throw new CrossTenantError("evaluateCandidateForAccount: account not in scope", scope, scope);
  const ensemble = candidate.ensemble as EnsembleResult;
  const strategyRow = await store.strategyById(candidate.strategyId);
  const setting = await store.userStrategySetting(scope, candidate.strategyId);
  const strat = strategyRow ? strategyContextForAccount(acct, strategyRow, setting) : null;
  const sym = await loadSymbolContext(rt, acct, candidate.symbol, candidate.holdingPeriodDays);
  const modeInfo = strat ? resolveMode(acct, strat) : { mode: "shadow" as TradeMode, why: "strategy row missing" };
  const mode = modeInfo.mode;
  const adapter = await resolveExecutionAdapter(rt, acct, mode).catch(() => null);
  const mappingVerified = adapterMappingVerified(adapter, acct);
  const price = sym.quote?.last ?? null;
  const reasons: string[] = [`mode ${mode} (${modeInfo.why})`];
  const rejectionReasons = new Set<RejectionReason>();
  const analogs = ((candidate.ensemble as { analogs?: HistoricalAnalog[] }).analogs ?? []) as HistoricalAnalog[];
  const strategyVersion = candidate.strategyVersionId ? (await store.strategyVersion(candidate.strategyVersionId))?.version ?? "unknown" : "unknown";

  const base = {
    scope, candidate, ensemble, regime: sym.regime, mode, price, quantity: 0, notional: 0, assessment: null, fit: null, sizing: null, fastBrain: null, risk: null, thesisId: null, thesis: null,
    calibratedConfidence: 0, strategyId: candidate.strategyId, strategyVersionId: candidate.strategyVersionId, accountNumber: acct.account.accountNumber, evaluatedAt: acct.nowIso, replay: false,
  } satisfies Omit<EvaluationSnapshot, "finalStatus" | "reasons" | "rejectionReasons">;

  const finish = async (snap: EvaluationSnapshot): Promise<EvaluationSnapshot> => {
    const { thesis: _thesis, candidate: _c, ...detail } = snap;
    await repos.candidateEvaluations.upsert(scope, {
      candidateId: candidate.id, portfolioFit: snap.fit?.fitScore ?? -1, sizeMultiplier: snap.fit?.sizeMultiplier ?? 0, proposedQuantity: snap.quantity, fastBrain: snap.fastBrain,
      riskDecisionId: snap.risk?.id ?? null, finalStatus: snap.finalStatus, detail: { ...detail, modeWhy: modeInfo.why },
    });
    if (snap.finalStatus === "rejected" || snap.finalStatus === "waiting") {
      await repos.rejected.record(scope, {
        candidateId: candidate.id, symbol: candidate.symbol, strategyId: candidate.strategyId, reasons: snap.rejectionReasons.length > 0 ? snap.rejectionReasons : ["other"], detail: snap.reasons.join("; ").slice(0, 4000),
        expectedEdge: ensemble.expectedEdge, confidence: snap.calibratedConfidence || ensemble.confidence, regime: sym.regime.primary, priceAtRejection: price, rejectedAt: acct.nowIso,
      });
      emitSafe("tradeRejected", scope, candidate.id, snap.reasons);
    }
    await rt.audit.record({ category: "risk", action: `candidate_${snap.finalStatus}`, result: snap.finalStatus === "rejected" ? "rejected" : "info", userId: scope.userId, brokerAccountId: scope.brokerAccountId, strategyId: candidate.strategyId, strategyVersionId: candidate.strategyVersionId, detail: { candidateId: candidate.id, symbol: candidate.symbol, mode, quantity: snap.quantity, reasons: snap.reasons.slice(0, 20), riskDecisionId: snap.risk?.id ?? null } });
    return snap;
  };
  const reject = (why: string, reason: RejectionReason, extra: Partial<EvaluationSnapshot> = {}): Promise<EvaluationSnapshot> => {
    reasons.push(why); rejectionReasons.add(reason);
    return finish({ ...base, ...extra, finalStatus: "rejected", reasons, rejectionReasons: [...rejectionReasons] });
  };

  // ---- fail-closed gates before any engine runs ------------------------------------------
  if (!strategyRow || !strat) return reject("strategy row missing for candidate", "strategy_disabled");
  if (!acct.snapshot) return reject("no portfolio snapshot for this account (fail closed)", "stale_data");
  if (!sym.quote || price === null || price <= 0) return reject("no usable quote for the symbol (fail closed)", "stale_data");
  const openTrade = await repos.trades.openForSymbol(scope, candidate.symbol, mode);
  if (openTrade) return reject(`already managing an open ${mode} trade in ${candidate.symbol} (${openTrade.id})`, "other");
  const existingTrade = await store.tradeForCandidate(scope, candidate.id);
  if (existingTrade) return reject(`candidate already produced trade ${existingTrade.id}`, "other");

  const positionCap = Math.min(acct.settings.maxPositionPct, setting?.maxPositionPct ?? Infinity);
  const proposedNotional = Math.max(0, positionCap * (acct.portfolio.totalValue ?? 0));
  const calibratedRaw = await calibrateForStrategy(store, candidate.strategyKey, ensemble.confidence);

  // ---- hard gates: kill switches, pauses, identity/mapping -> the risk engine records the formal veto ----
  // These block every entry regardless of size, so the portfolio/sizing/thesis work is skipped and
  // the deterministic risk engine is run on the pre-portfolio proposed size to journal the reasons.
  const hardGate = acct.killSwitch.active || acct.global.globalKillSwitch.active || acct.account.tradingPaused || acct.global.pausedUsers.includes(scope.userId)
    || !opts.identityVerified || !mappingVerified || (mode === "live" && acct.global.liveExecutionDisabled);
  if (hardGate) {
    const probeQty = Math.max(1, Math.floor(proposedNotional / price));
    const gateRisk = riskEvaluate(buildRiskInput({
      acct, sym, strat, mode, action: "enter", side: "buy", quantity: probeQty, price, candidateId: candidate.id, tradeId: null, identityVerified: opts.identityVerified, accountMappingVerified: mappingVerified,
      metrics: { expectedEdge: ensemble.expectedEdge, confidence: calibratedRaw, disagreement: ensemble.disagreement, uncertainty: ensemble.uncertainty, expectedDownsidePct: candidate.expectedDownsidePct / 100, annualizedVol: sym.annualizedVol, spreadBps: sym.spreadBps, adv: sym.adv, liquidityScore: candidate.liquidityScore, beta: sym.instrument.beta },
      eventRiskWithinHorizon: sym.eventWithinHorizon,
    }));
    await recordRiskDecision(rt, scope, gateRisk);
    for (const r of rejectionReasonsFromRisk(gateRisk)) rejectionReasons.add(r);
    if (gateRisk.verdict !== "reject") rejectionReasons.add("other"); // cannot happen: every hard gate is blocking; fail closed anyway
    reasons.push(`blocked before sizing: ${gateRisk.reasons.filter((r) => !r.startsWith("warning")).slice(0, 4).join("; ") || "hard gate active"}`);
    return finish({ ...base, risk: gateRisk, calibratedConfidence: calibratedRaw, finalStatus: "rejected", reasons, rejectionReasons: [...rejectionReasons] });
  }

  // ---- 1. portfolio engine ----------------------------------------------------------------------
  const assessment = assess({
    scope, now: acct.nowIso, totalValue: acct.portfolio.totalValue, cash: acct.portfolio.cash,
    positions: acct.positions.map((p) => ({ symbol: p.symbol, assetClass: p.assetClass as "equity" | "option" | "crypto", sector: acct.instruments.get(p.symbol)?.sector ?? null, beta: acct.instruments.get(p.symbol)?.beta ?? null, quantity: p.quantity, marketValue: isFiniteNumber(p.marketValue) ? p.marketValue : null, correlationToCandidate: sym.correlationByPosition.get(p.symbol) ?? null, earningsInDays: null })),
    peakValue: acct.portfolio.peakValue, dailyPnlPct: acct.portfolio.dailyPnlPct, weeklyPnlPct: acct.portfolio.weeklyPnlPct, settings: strat.settingsForRisk,
    candidate: { symbol: candidate.symbol, assetClass: "equity", sector: sym.instrument.sector, beta: sym.instrument.beta, proposedNotional, correlationToPortfolio: sym.correlationToPortfolio, strategyKey: candidate.strategyKey, earningsInDays: sym.daysToNextEvent },
  });
  const fit = assessment.candidate;
  if (!fit) return reject("portfolio engine produced no candidate fit", "other", { assessment });
  reasons.push(`portfolio fit ${fit.fitScore.toFixed(2)} x${fit.sizeMultiplier.toFixed(2)}: ${fit.notes.slice(0, 3).join("; ")}`);

  // ---- 2. sizing --------------------------------------------------------------------------------
  const profileRow = await store.systemStrategyProfile(candidate.strategyKey);
  const profile = profileRow ? (profileRow.profile as StrategyIntelligenceProfile) : null;
  const existingPositionNotional = acct.positions.filter((p) => p.symbol === candidate.symbol).reduce((s, p) => s + Math.abs(p.marketValue ?? 0), 0);
  const sizing = computeSize({
    scope, now: acct.nowIso, symbol: candidate.symbol, price, totalValue: acct.portfolio.totalValue, buyingPower: acct.portfolio.buyingPower, settings: strat.settingsForRisk,
    strategyMaxPositionPct: setting?.maxPositionPct ?? null, strategyMaxLossPerTradePct: setting?.maxLossPerTradePct ?? null, capitalAllocation: setting && setting.capitalAllocation > 0 ? setting.capitalAllocation : null,
    candidate: {
      confidence: calibratedRaw, expectedEdge: ensemble.expectedEdge, expectedUpsidePct: candidate.expectedUpsidePct / 100, expectedDownsidePct: candidate.expectedDownsidePct / 100, regimeFit: candidate.regimeFit,
      liquidityScore: candidate.liquidityScore, annualizedVol: sym.annualizedVol, atrPct: sym.atrPct, adv: sym.adv, correlationToPortfolio: sym.correlationToPortfolio, uncertainty: ensemble.uncertainty,
    },
    portfolio: { currentDrawdownPct: acct.portfolio.drawdownPct, existingPositionNotional, deployedPct: acct.portfolio.deployedPct ?? NaN, sizeMultiplier: fit.sizeMultiplier },
    strategyPerformance: perfFromStats(profile?.overall), regimePerformance: perfFromStats(profile?.byRegime?.[sym.regime.primary]),
    fractionalAllowed: sym.instrument.fractional, orderType: "limit",
  });
  reasons.push(`sizing: ${sizing.rationale[sizing.rationale.length - 1] ?? sizing.bindingConstraint}`);
  if (sizing.quantity <= 0) {
    const reason: RejectionReason = /liquidity/.test(sizing.bindingConstraint) ? "poor_liquidity" : /confidence/.test(sizing.bindingConstraint) ? "insufficient_confidence" : /edge|kelly|payoff/.test(sizing.bindingConstraint) ? "bad_risk_reward" : "portfolio_concentration";
    return reject(`sizing produced no position: ${sizing.bindingConstraint}`, reason, { assessment, fit, sizing, calibratedConfidence: calibratedRaw });
  }

  // ---- 3. thesis (deterministic numbers, optional committee enrichment) --------------------------
  const prelimPlan = planExecution({
    scope, symbol: candidate.symbol, side: "buy", quantity: sizing.quantity, urgency: "normal", last: price, bid: sym.quote.bid, ask: sym.quote.ask, spreadBps: sym.spreadBps, adv: sym.adv,
    realizedVolDaily: numOrNull(sym.features[FEATURE.realizedVolDaily20]), session: acct.session, minutesToClose: sym.minutesToClose,
    expectedEdgeBps: expectedEdgeBps(ensemble.expectedEdge, candidate.expectedUpsidePct), fractionalAllowed: sym.instrument.fractional, extendedHoursAllowed: acct.settings.tradingHours.allowExtendedHours, learned: null,
  }, { maxSpreadBps: acct.settings.maxSpreadBps, maxChaseBps: 20, defaultRepriceSeconds: 45 });
  let thesisResult: Awaited<ReturnType<typeof buildThesis>>;
  try {
    thesisResult = await buildThesis(scope, {
      candidate, ensemble, regime: sym.regime, features: sym.features, price, fit, assessment, sizing, plan: prelimPlan.abort ? null : prelimPlan, settings: strat.settingsForRisk, analogs,
      strategyPerfInRegime: profile?.byRegime?.[sym.regime.primary] ? { trades: profile.byRegime[sym.regime.primary]!.trades, winRate: profile.byRegime[sym.regime.primary]!.winRate, expectancyPct: profile.byRegime[sym.regime.primary]!.expectancyPct, profitFactor: profile.byRegime[sym.regime.primary]!.profitFactor } : null,
      calibratedConfidence: calibratedRaw, dataFreshness: sym.dataFreshness, adv: sym.adv, spreadBps: sym.spreadBps, annualizedVol: sym.annualizedVol, sector: sym.instrument.sector, strategyVersion,
      buyingPower: acct.portfolio.buyingPower ?? 0, cash: acct.portfolio.cash ?? 0, positionCount: acct.positions.length, daysToNextEvent: sym.daysToNextEvent,
    }, { repos, store, modelClient: rt.modelClient, clock: rt.clock, log: rt.log });
  } catch (err) {
    return reject(`thesis could not be built or validated: ${errorMessage(err)} (no thesis = no trade)`, "no_thesis", { assessment, fit, sizing, calibratedConfidence: calibratedRaw });
  }
  const calibrated = thesisResult.calibratedConfidence;
  if (thesisResult.committee.ran) reasons.push(`committee: ${thesisResult.committee.votes} votes, disagreement ${thesisResult.committee.disagreement.toFixed(2)}${thesisResult.committee.devilsAdvocateVerdict ? `, devil's advocate ${thesisResult.committee.devilsAdvocateVerdict}` : ""}`);
  for (const w of thesisResult.committee.warnings.slice(0, 3)) reasons.push(`committee warning: ${w}`);

  // ---- 4. fast brain ----------------------------------------------------------------------------
  const heldPosition = acct.positions.find((p) => p.symbol === candidate.symbol) ?? null;
  const openOrder = acct.openOrders.find((o) => o.symbol === candidate.symbol) ?? null;
  const fbInput: FastBrainInput = {
    scope, symbol: candidate.symbol, strategyKey: candidate.strategyKey, hasPosition: !!heldPosition && heldPosition.quantity > 0,
    positionPnlPct: heldPosition && isFiniteNumber(heldPosition.averageCost) && heldPosition.averageCost > 0 ? price / heldPosition.averageCost - 1 : null, positionAgeDays: null, invalidated: false, targetReached: false,
    expectedEdge: ensemble.expectedEdge, confidence: calibrated, disagreement: Math.max(ensemble.disagreement, thesisResult.committee.disagreement), uncertainty: ensemble.uncertainty, regimeFit: candidate.regimeFit,
    liquidityScore: candidate.liquidityScore, spreadBps: sym.spreadBps, dataFreshness: sym.dataFreshness, portfolioFit: fit.fitScore, riskCapacity: assessment.riskCapacity, eventRiskWithinHorizon: sym.eventWithinHorizon,
    openOrder: openOrder ? { side: openOrder.side, ageSeconds: Math.max(0, (acct.now.getTime() - Date.parse(openOrder.createdAt)) / 1000), distanceFromMarketBps: openOrder.limitPrice ? Math.abs((price - openOrder.limitPrice) / price) * 10_000 : 0, fillProbability: 0.5 } : null,
    marketSession: acct.session, calibrationAdjustment: 1,
  };
  const fastBrain = decide(fbInput, acct.nowIso);
  reasons.push(`fast brain ${fastBrain.action} (${(fastBrain.conviction * 100).toFixed(0)}%)`);

  // ---- 5. deterministic risk engine (absolute veto) ----------------------------------------------
  const riskInput = buildRiskInput({
    acct, sym, strat, mode, action: "enter", side: "buy", quantity: sizing.quantity, price, candidateId: candidate.id, tradeId: null, identityVerified: opts.identityVerified, accountMappingVerified: mappingVerified,
    metrics: { expectedEdge: ensemble.expectedEdge, confidence: calibrated, disagreement: ensemble.disagreement, uncertainty: ensemble.uncertainty, expectedDownsidePct: candidate.expectedDownsidePct / 100, annualizedVol: sym.annualizedVol, spreadBps: sym.spreadBps, adv: sym.adv, liquidityScore: candidate.liquidityScore, beta: sym.instrument.beta },
    eventRiskWithinHorizon: sym.eventWithinHorizon,
  });
  const risk = riskEvaluate(riskInput);
  await recordRiskDecision(rt, scope, risk);
  reasons.push(`risk ${risk.verdict}${risk.reasons.length ? `: ${risk.reasons.filter((r) => !r.startsWith("warning")).slice(0, 4).join("; ")}` : ""}`);

  const common: Partial<EvaluationSnapshot> = { assessment, fit, sizing, fastBrain, risk, thesisId: thesisResult.thesisId, thesis: thesisResult.thesis, calibratedConfidence: calibrated, quantity: risk.approvedQuantity, notional: risk.approvedNotional };
  if (risk.verdict === "reject") {
    for (const r of rejectionReasonsFromRisk(risk)) rejectionReasons.add(r);
    await repos.theses.update(scope, thesisResult.thesisId, { status: "invalidated" });
    return finish({ ...base, ...common, finalStatus: "rejected", reasons, rejectionReasons: [...rejectionReasons] });
  }
  if (fastBrain.action !== "BUY") {
    rejectionReasons.add(fastBrain.action === "WAIT" || fastBrain.action === "HOLD" ? "other" : "other");
    reasons.push(`fast brain chose ${fastBrain.action}: no entry`);
    await repos.theses.update(scope, thesisResult.thesisId, { status: "superseded" });
    return finish({ ...base, ...common, finalStatus: "waiting", reasons, rejectionReasons: [...rejectionReasons] });
  }
  let finalStatus: FinalStatus;
  if (mode === "shadow") finalStatus = "shadow";
  else if (risk.requiresApproval) finalStatus = "needs_approval";
  else finalStatus = "approved";
  if (acct.account.autonomyLevel === "research_only") reasons.push("autonomy research_only: evaluation journaled, nothing is executed");
  await repos.theses.update(scope, thesisResult.thesisId, { status: "active" });
  return finish({ ...base, ...common, finalStatus, reasons, rejectionReasons: [] });
}

/**
 * Theoretical edge in bps for the execution model: expected edge (signed strength in [-1, 1])
 * times the expected upside move (percent points) = percentage-of-move we expect to capture,
 * expressed in bps (x100). Example: edge 0.6 x 4% upside = 2.4% = 240 bps.
 */
export function expectedEdgeBps(expectedEdge: number, expectedUpsidePctPoints: number): number {
  const v = Math.max(0, expectedEdge) * Math.max(0, expectedUpsidePctPoints) * 100;
  return Number.isFinite(v) ? round4(v) : 0;
}
