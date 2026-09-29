import type { Freshness, TenantScope } from "@yz/core";
import { assertScope, checkKillSwitchTriggers, entriesAllowed, marketSessionAt } from "@yz/core";
import type { AppContext } from "../../http/app.js";
import { UNFILLED_END_STATES, dailyBarFreshness, errorMessage, regimeFreshness } from "./common.js";
import { generateCandidates, type GenerateCandidatesSummary } from "./candidates.js";
import { evaluateCandidateForAccount, loadAccountContext, type AccountContext } from "./evaluate.js";
import { emitSafe } from "./events.js";
import { openTrade, requestApproval } from "./execute.js";
import type { EvaluationSnapshot, TradingRuntime } from "./types.js";

export interface KillSwitchCheck { triggered: boolean; alreadyActive: boolean; reasons: string[]; details: string[]; released?: boolean }

/**
 * Kill-switch reasons that describe a condition, not a loss: when the condition has cleared the
 * switch releases itself (audited). Loss, drawdown, reconciliation and broker triggers always wait
 * for a person.
 */
export const AUTO_RELEASE_REASONS: ReadonlySet<string> = new Set(["market_data_failure"]);
/** Market data must be at most this old (seconds) during the regular session for a data kill switch to release. */
export const DATA_RELEASE_MAX_AGE_SECONDS = 60;
/** Prefix of the pause reason the kill switch writes; a release lifts only a pause it caused. */
export const KILL_SWITCH_PAUSE_PREFIX = "Kill switch:";
export interface DataQualityGate { allowed: boolean; reason: string | null; quotes: Freshness; bars: Freshness; regime: Freshness }
/** A rejected evaluation stands this long before the candidate is looked at again during the session. */
export const REEVALUATE_AFTER_MS = 30 * 60_000;
/** Most rejections per candidate; after that it is left alone until it expires (bounds model spend on a setup that keeps failing). */
export const MAX_REJECTIONS_PER_CANDIDATE = 4;

/**
 * Whether an existing evaluation settles a candidate for this account, or the candidate should be
 * evaluated again this cycle. A rejection is provisional: capital, data freshness, per-cycle
 * budgets and the committee all change intra-day, so after a cooldown the candidate is looked at
 * again, a bounded number of times, while the regular session is open. An approval or shadow
 * decision is settled while any trade it produced lives; once every such trade ended without a
 * fill (cancelled or rejected), the candidate is eligible again after the same cooldown. Waiting
 * and needs-approval decisions are owned by their own flows and always stand.
 */
export function evaluationSettled(
  e: { finalStatus: string; detail: unknown; createdAt: string },
  ctx: { now: Date; session: string; rejections: number; trades: { state: string }[] },
): boolean {
  if (ctx.session !== "regular") return true;
  const detail = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : {};
  const at = Date.parse(typeof detail["evaluatedAt"] === "string" ? (detail["evaluatedAt"] as string) : e.createdAt);
  const cooled = !Number.isFinite(at) || ctx.now.getTime() - at >= REEVALUATE_AFTER_MS;
  if (e.finalStatus === "rejected") return !cooled || ctx.rejections >= MAX_REJECTIONS_PER_CANDIDATE;
  if (e.finalStatus === "approved" || e.finalStatus === "shadow") {
    if (ctx.trades.length === 0) return true;
    return !cooled || !ctx.trades.every((t) => UNFILLED_END_STATES.has(t.state));
  }
  return true;
}

export interface CycleSummary {
  scope: TenantScope;
  at: string;
  refused: boolean;
  session: string;
  killSwitch: KillSwitchCheck | null;
  survival: { mode: string; fitnessScore: number; riskMultiplier: number; hurdleBps: number; maxNewPositions: number; allowLiveEntries: boolean } | null;
  gate: DataQualityGate | null;
  entriesAllowed: boolean;
  candidates: number;
  evaluated: number;
  opened: number;
  approvalsRequested: number;
  shadow: number;
  rejected: number;
  waiting: number;
  /** Candidates evaluated again after a provisional rejection or an unfilled decision. */
  reevaluated: number;
  errors: string[];
  notes: string[];
}

/**
 * Evaluate every automatic kill-switch condition for one account with the current state.
 * Triggers the account's kill switch (never another account's), raises an alert, pauses the
 * account and audits it. Idempotent while the same reasons are already active.
 */
export async function evaluateKillSwitch(rt: TradingRuntime, acct: AccountContext): Promise<KillSwitchCheck> {
  const { repos } = rt;
  const scope = acct.scope;
  const health = rt.marketData.health();
  const lastSuccess = typeof health.metrics?.["lastSuccessAt"] === "string" ? Date.parse(health.metrics["lastSuccessAt"] as string) : NaN;
  // "not failing" is trusted until the source has failed three times in a row; a source that has
  // never succeeded is caught by the data-quality gate (no entries), not by the kill switch.
  // Feed age is only judged during the regular session: outside it quotes are refreshed every 15
  // minutes by design, and judging them at the pre-market transition tripped a false switch.
  const regular = acct.session === "regular";
  const feedAge = Number.isFinite(lastSuccess) ? Math.max(0, (acct.now.getTime() - lastSuccess) / 1000) : 0;
  const marketDataAgeSeconds = rt.marketData.failing ? null : regular ? feedAge : 0;
  const hourAgo = acct.now.getTime() - 3_600_000;
  const recentOrders = await repos.orders.recent(scope, 200);
  const executionFailures = recentOrders.filter((o) => Date.parse(o.createdAt) >= hourAgo && (o.state === "rejected" || o.state === "failed")).length;
  const regimeRow = await repos.market.latestRegime();
  const metrics = (regimeRow?.metrics && typeof regimeRow.metrics === "object" ? regimeRow.metrics : {}) as { vix?: number | null; realizedVol20?: number | null };
  const result = checkKillSwitchTriggers({
    settings: acct.settings, dailyPnlPct: acct.portfolio.dailyPnlPct, weeklyPnlPct: acct.portfolio.weeklyPnlPct, currentDrawdownPct: acct.portfolio.drawdownPct,
    marketDataAgeSeconds, brokerConsecutiveFailures: acct.account.status === "unreliable" ? 3 : acct.account.status === "error" ? 1 : 0,
    reconciliationOk: acct.reconciliation.ok, positionMismatch: acct.reconciliation.positionMismatch, abnormalAiOutput: false, executionFailuresInWindow: executionFailures, databaseError: false,
    unexpectedPosition: acct.reconciliation.unexpectedPosition, vix: typeof metrics.vix === "number" ? metrics.vix : null, realizedVol: typeof metrics.realizedVol20 === "number" ? metrics.realizedVol20 : null,
  });
  const existing = acct.killSwitch;
  // Auto-release: every active reason is a condition that has now cleared, in the regular session
  // with recent data, and nothing else would trigger.
  if (existing.active && existing.reasons.length > 0 && existing.reasons.every((r) => AUTO_RELEASE_REASONS.has(r)) && !result.shouldTrigger
    && regular && !rt.marketData.failing && Number.isFinite(lastSuccess) && feedAge <= DATA_RELEASE_MAX_AGE_SECONDS) {
    await repos.killSwitches.release(scope, "system");
    const unpaused = acct.account.tradingPaused && (acct.account.pausedReason ?? "").startsWith(KILL_SWITCH_PAUSE_PREFIX);
    if (unpaused) await repos.accounts.update(scope, { tradingPaused: false, pausedReason: null });
    const note = `market data healthy again (last fetch ${feedAge.toFixed(0)}s ago in the regular session); released ${existing.reasons.join(", ")}${unpaused ? " and resumed the account" : ""}`;
    await repos.alerts.raise({ userId: scope.userId, brokerAccountId: scope.brokerAccountId, severity: "info", kind: "risk", title: "Kill switch released automatically", message: note });
    await rt.audit.record({ category: "kill_switch", action: "released", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { reasons: existing.reasons, releasedBy: "system", automatic: true, feedAgeSeconds: Math.round(feedAge), unpaused } });
    rt.log.info({ scope: scope.brokerAccountId, reasons: existing.reasons }, "kill switch released automatically");
    acct.killSwitch = { ...existing, active: false, reasons: [] };
    if (unpaused) acct.account = { ...acct.account, tradingPaused: false, pausedReason: null };
    return { triggered: false, alreadyActive: false, reasons: [], details: [note], released: true };
  }
  const alreadyActive = existing.active && result.reasons.every((r) => existing.reasons.includes(r));
  if (!result.shouldTrigger || alreadyActive) return { triggered: false, alreadyActive, reasons: result.reasons, details: result.details };
  const note = result.details.join("; ").slice(0, 500);
  await repos.killSwitches.trigger(scope, result.reasons, "system", note, true);
  await repos.accounts.update(scope, { tradingPaused: true, pausedReason: `${KILL_SWITCH_PAUSE_PREFIX} ${result.reasons.join(", ")}` });
  await repos.alerts.raise({ userId: scope.userId, brokerAccountId: scope.brokerAccountId, severity: "critical", kind: "risk", title: "Kill switch triggered", message: note });
  await rt.audit.record({ category: "kill_switch", action: "triggered", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { reasons: result.reasons, details: result.details, triggeredBy: "system" } });
  emitSafe("killSwitchTriggered", scope, result.reasons);
  rt.log.warn({ scope: scope.brokerAccountId, reasons: result.reasons }, "kill switch triggered");
  return { triggered: true, alreadyActive: false, reasons: result.reasons, details: result.details };
}

/** Data-quality gate for NEW entries: quotes, bars and regime must all be at least "aging". */
export async function dataQualityGate(rt: TradingRuntime, acct: AccountContext, symbols: string[]): Promise<DataQualityGate> {
  const probe = Array.from(new Set(["SPY", ...symbols])).slice(0, 25);
  // Feed health, like bars below: the best freshness across the probe. A quote's age is the age of
  // the stock's last trade, so one thinly traded candidate reads "stale" while the feed is fine;
  // taking the worst let a single illiquid name halt every entry. Each symbol's own quote freshness
  // is still enforced per trade by the risk engine (data_freshness).
  const rankQ: Record<Freshness, number> = { fresh: 3, aging: 2, stale: 1, unknown: 0 };
  let quotes: Freshness = "unknown";
  if (rt.marketData.failing) quotes = "stale";
  else {
    const qs = await rt.marketData.getQuotes(probe, 30).catch(() => []);
    for (const q of qs) if (rankQ[q.freshness] > rankQ[quotes]) quotes = q.freshness;
  }
  // Pipeline-level bar freshness: the best of the probed symbols (a single illiquid name must not block everyone).
  const rank: Record<Freshness, number> = { fresh: 3, aging: 2, stale: 1, unknown: 0 };
  let bars: Freshness = "unknown";
  for (const s of probe) {
    const t = await rt.repos.market.latestBarTime(s, "day").catch(() => null);
    const f = dailyBarFreshness(t, acct.nowIso);
    if (rank[f] > rank[bars]) bars = f;
    if (bars === "fresh") break;
  }
  const regime = regimeFreshness(await rt.repos.market.latestRegime(), acct.nowIso);
  const verdict = entriesAllowed(quotes, bars, regime);
  return { allowed: verdict.allowed, reason: verdict.reason, quotes, bars, regime };
}

/** What the cycle does with an evaluation, given the account's autonomy. Returns a short note. */
export async function actOnEvaluation(rt: TradingRuntime, acct: AccountContext, ev: EvaluationSnapshot, summary: CycleSummary): Promise<string> {
  const autonomy = acct.account.autonomyLevel;
  switch (ev.finalStatus) {
    case "approved": {
      if (autonomy !== "fully_autonomous" && autonomy !== "semi_autonomous") return `${ev.candidate.symbol}: approved but autonomy ${autonomy} does not auto-execute`;
      const res = await openTrade(rt, acct.scope, ev);
      if (res.ok) { summary.opened += 1; return `${ev.candidate.symbol}: live order ${res.order.id}${res.duplicate ? " (existing)" : ""}`; }
      return `${ev.candidate.symbol}: approved but not executed: ${res.reason}`;
    }
    case "needs_approval": {
      const res = await requestApproval(rt, acct.scope, ev);
      if (res.approvalId) { summary.approvalsRequested += 1; return `${ev.candidate.symbol}: approval ${res.approvalId} requested`; }
      return `${ev.candidate.symbol}: approval not requested: ${"reason" in res ? res.reason : "unknown"}`;
    }
    case "shadow": {
      if (autonomy === "research_only") { summary.shadow += 1; return `${ev.candidate.symbol}: shadow evaluation journaled (research_only)`; }
      const res = await openTrade(rt, acct.scope, ev);
      summary.shadow += 1;
      if (res.ok) return `${ev.candidate.symbol}: shadow order ${res.order.id}${res.duplicate ? " (existing)" : ""}`;
      return `${ev.candidate.symbol}: shadow not executed: ${res.reason}`;
    }
    case "waiting": summary.waiting += 1; return `${ev.candidate.symbol}: waiting (${ev.fastBrain?.action ?? "fast brain"})`;
    case "rejected": summary.rejected += 1; return `${ev.candidate.symbol}: rejected (${ev.rejectionReasons.join(", ")})`;
    default: return `${ev.candidate.symbol}: ${ev.finalStatus}`;
  }
}

/**
 * Per-account job `trading_cycle`.
 *  0. refuse when the account is not in the scope;
 *  1. automatic kill-switch conditions (trigger, alert, pause);
 *  2. data-quality gate: no new entries on stale/unknown data (management continues in its own job);
 *  3. every fresh candidate not yet evaluated for this scope: evaluate, then execute / request approval / shadow;
 *  4. return a journal-worthy summary (stored by the scheduler as the job detail).
 */
export async function tradingCycle(rt: TradingRuntime, scope: TenantScope): Promise<CycleSummary> {
  assertScope(scope, "tradingCycle");
  const now = rt.clock();
  const summary: CycleSummary = { scope, at: now.toISOString(), refused: false, session: marketSessionAt(now), killSwitch: null, survival: null, gate: null, entriesAllowed: false, candidates: 0, evaluated: 0, opened: 0, approvalsRequested: 0, shadow: 0, rejected: 0, waiting: 0, reevaluated: 0, errors: [], notes: [] };
  const acct = await loadAccountContext(rt, scope);
  if (!acct) { summary.refused = true; summary.notes.push("account not found in scope; refusing to run"); return summary; }
  summary.survival = { mode: acct.survival.mode, fitnessScore: acct.survival.fitnessScore, riskMultiplier: acct.survival.riskMultiplier, hurdleBps: acct.survival.hurdleBps, maxNewPositions: acct.survival.maxNewPositions, allowLiveEntries: acct.survival.allowLiveEntries };
  if (acct.survival.mode === "hibernation" || acct.survival.mode === "survival") summary.notes.push(`survival mandate ${acct.survival.mode}: ${acct.survival.mandate.split(" Why:")[0]}`);
  summary.killSwitch = await evaluateKillSwitch(rt, acct);
  if (summary.killSwitch.triggered) summary.notes.push(`kill switch triggered: ${summary.killSwitch.reasons.join(", ")}`);

  const fresh = await rt.store.freshCandidates(acct.nowIso);
  const [evals, recentRejections, recentTrades] = await Promise.all([
    rt.store.evaluationsForCandidates(scope, fresh.map((c) => c.id)),
    rt.repos.rejected.recent(scope, 2000),
    rt.repos.trades.list(scope, { limit: 2000 }),
  ]);
  const rejectionsBy = new Map<string, number>();
  for (const r of recentRejections) if (r.candidateId) rejectionsBy.set(r.candidateId, (rejectionsBy.get(r.candidateId) ?? 0) + 1);
  const tradesBy = new Map<string, { state: string }[]>();
  for (const t of recentTrades) if (t.candidateId) tradesBy.set(t.candidateId, [...(tradesBy.get(t.candidateId) ?? []), { state: t.state }]);
  const settled = new Set<string>();
  const again = new Set<string>();
  for (const e of evals) {
    if (evaluationSettled(e, { now, session: summary.session, rejections: rejectionsBy.get(e.candidateId) ?? 0, trades: tradesBy.get(e.candidateId) ?? [] })) settled.add(e.candidateId);
    else { again.add(e.candidateId); summary.reevaluated += 1; }
  }
  const pending = fresh.filter((c) => !settled.has(c.id));
  summary.candidates = pending.length;
  if (summary.reevaluated > 0) summary.notes.push(`${summary.reevaluated} candidate(s) re-evaluated after cooldown`);
  summary.gate = await dataQualityGate(rt, acct, pending.map((c) => c.symbol));
  summary.entriesAllowed = summary.gate.allowed;
  if (!summary.gate.allowed) {
    summary.notes.push(`no new entries: ${summary.gate.reason} (quotes ${summary.gate.quotes}, bars ${summary.gate.bars}, regime ${summary.gate.regime}); ${pending.length} candidate(s) left unevaluated`);
    if (pending.length > 0) await rt.repos.systemEvents.record("trading_cycle", "warning", `entries blocked for account ${scope.brokerAccountId}: ${summary.gate.reason}`, { scope, gate: summary.gate }).catch(() => undefined);
    return summary;
  }
  for (const candidate of pending) {
    try {
      const ev = await evaluateCandidateForAccount(rt, scope, candidate, { identityVerified: true, liveEntriesThisCycle: summary.opened + summary.approvalsRequested, reevaluate: again.has(candidate.id) });
      summary.evaluated += 1;
      const acctNow = summary.killSwitch.triggered ? (await loadAccountContext(rt, scope)) ?? acct : acct;
      summary.notes.push(await actOnEvaluation(rt, acctNow, ev, summary));
    } catch (err) {
      summary.errors.push(`${candidate.symbol}/${candidate.strategyKey}: ${errorMessage(err)}`);
      rt.log.warn({ err, candidateId: candidate.id, scope: scope.brokerAccountId }, "candidate evaluation failed");
    }
  }
  return summary;
}

/** Global job `candidate_generation`: shared, user-agnostic. */
export async function candidateGeneration(ctx: AppContext, rt: TradingRuntime): Promise<GenerateCandidatesSummary> {
  return generateCandidates(ctx, { asOf: rt.clock(), log: rt.log });
}
