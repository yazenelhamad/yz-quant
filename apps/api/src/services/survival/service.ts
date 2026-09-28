import type { PerformanceStats, RiskSettings, StrategyFitness, StrategyStage, SurvivalState, TenantScope, TradeMemoryEntry, StrategyIntelligenceProfile } from "@yz/core";
import { EMPTY_STATS, assertScope, assessStrategyFitness, computePerformanceStats, computeSurvival, darwinianAllocation, type DarwinianAllocation } from "@yz/core";
import { StrategyCatalogRepository, StrategyProfilesRepository, StrategySettingsRepository, TradeMemoryRepository, type SurvivalStateRow } from "@yz/db";
import type { Repos } from "../../http/app.js";
import type { AuditService } from "../audit.js";
import { memoryRowToEntry } from "../learning/mapping.js";

export const SURVIVAL_BENCHMARK = "SPY";
/** A stored state older than this is recomputed before it is used. */
export const SURVIVAL_STALE_MS = 10 * 60_000;
const RECENT_N = 20;

export interface SurvivalRuntime {
  repos: Repos;
  audit: AuditService;
  clock: () => Date;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

/** The account facts the mandate needs; a subset of the trading AccountContext so this module stays independent of it. */
export interface SurvivalAccountFacts {
  scope: TenantScope;
  settings: RiskSettings;
  now: Date;
  portfolio: { totalValue: number | null; dailyPnlPct: number | null; weeklyPnlPct: number | null; drawdownPct: number | null; peakValue: number | null };
}

export function stateFromRow(row: SurvivalStateRow | undefined): SurvivalState | null {
  if (!row) return null;
  const s = row.state as SurvivalState;
  return s && typeof s === "object" && typeof s.mode === "string" ? s : null;
}

function windows(entries: TradeMemoryEntry[]): { overall: PerformanceStats; recent: PerformanceStats } {
  const closed = entries.filter((e) => typeof e.actualReturnPct === "number").sort((a, b) => Date.parse(a.closedAt ?? a.openedAt) - Date.parse(b.closedAt ?? b.openedAt));
  if (closed.length === 0) return { overall: { ...EMPTY_STATS }, recent: { ...EMPTY_STATS } };
  return { overall: computePerformanceStats(closed), recent: computePerformanceStats(closed.slice(-RECENT_N)) };
}

/** One equity point per UTC day (the day's last snapshot), oldest first. */
function dailyEquity(rows: { asOf: string; totalValue: number }[]): { day: string; value: number; asOf: string }[] {
  const byDay = new Map<string, { day: string; value: number; asOf: string }>();
  for (const r of [...rows].sort((a, b) => a.asOf.localeCompare(b.asOf))) {
    if (!Number.isFinite(r.totalValue) || r.totalValue <= 0) continue;
    byDay.set(r.asOf.slice(0, 10), { day: r.asOf.slice(0, 10), value: r.totalValue, asOf: r.asOf });
  }
  return [...byDay.values()];
}

/**
 * Compute and persist the survival mandate for one account from its own realised record: equity
 * snapshots (runway, drawdown, alpha), closed live and shadow trades (expectancy, profit factor)
 * and the benchmark's bars over the same period. Mode changes raise an alert and an audit entry.
 */
export async function refreshSurvival(rt: SurvivalRuntime, facts: SurvivalAccountFacts): Promise<SurvivalState> {
  assertScope(facts.scope, "refreshSurvival");
  const { repos } = rt;
  const scope = facts.scope;
  const nowIso = facts.now.toISOString();
  const memory = new TradeMemoryRepository(repos.sessionsDb());
  const [previousRow, snapshotRows, memoryRows] = await Promise.all([repos.survival.latest(scope), repos.snapshots.history(scope, 800), memory.forScope(scope, { limit: 5000 })]);
  const previous = stateFromRow(previousRow);
  const entries = memoryRows.map(memoryRowToEntry);
  const live = windows(entries.filter((e) => e.mode === "live"));
  const shadow = windows(entries.filter((e) => e.mode === "shadow"));

  const equity = dailyEquity(snapshotRows);
  const first = equity[0] ?? null;
  const last = equity[equity.length - 1] ?? null;
  const recentDailyReturns: number[] = [];
  for (let i = Math.max(1, equity.length - 30); i < equity.length; i += 1) {
    const prev = equity[i - 1]!.value; const cur = equity[i]!.value;
    if (prev > 0) recentDailyReturns.push(cur / prev - 1);
  }
  const peakPoint = equity.reduce<{ value: number; asOf: string } | null>((m, p) => (m === null || p.value > m.value ? { value: p.value, asOf: p.asOf } : m), null);
  const current = facts.portfolio.totalValue ?? last?.value ?? null;
  const liveReturnPct = first && current !== null && first.value > 0 && equity.length >= 2 ? current / first.value - 1 : null;

  let benchmark: { label: string; returnPct: number | null } | null = null;
  if (first && equity.length >= 2) {
    try {
      const bars = await repos.market.bars(SURVIVAL_BENCHMARK, "day", { start: first.asOf, end: nowIso, limit: 800 });
      const sorted = [...bars].sort((a, b) => a.time.localeCompare(b.time));
      const b0 = sorted[0]; const b1 = sorted[sorted.length - 1];
      benchmark = { label: SURVIVAL_BENCHMARK, returnPct: b0 && b1 && b0.close > 0 && sorted.length >= 2 ? b1.close / b0.close - 1 : null };
    } catch { benchmark = { label: SURVIVAL_BENCHMARK, returnPct: null }; }
  }

  const state = computeSurvival({
    scope, now: nowIso,
    settings: { maxDrawdownPct: facts.settings.maxDrawdownPct, maxWeeklyLossPct: facts.settings.maxWeeklyLossPct, maxDailyLossPct: facts.settings.maxDailyLossPct, maxSimultaneousPositions: facts.settings.maxSimultaneousPositions },
    equity: { current, peak: facts.portfolio.peakValue ?? peakPoint?.value ?? null, inception: first?.value ?? null, inceptionAt: first?.asOf ?? null, lastHighAt: peakPoint?.asOf ?? null },
    drawdownPct: facts.portfolio.drawdownPct, dailyPnlPct: facts.portfolio.dailyPnlPct, weeklyPnlPct: facts.portfolio.weeklyPnlPct, recentDailyReturns,
    live, shadow, benchmark, liveReturnPct, previous,
  });

  await repos.survival.record(scope, {
    mode: state.mode, modeSince: state.modeSince, previousMode: state.previousMode, fitnessScore: state.fitnessScore, riskMultiplier: state.riskMultiplier, minEdgeMultiplier: state.minEdgeMultiplier,
    hurdleBps: state.hurdleBps, maxNewPositions: state.maxNewPositions, allowLiveEntries: state.allowLiveEntries, runwayDays: state.runway.days, alphaPct: state.alpha.alphaPct, state, version: state.version, computedAt: state.computedAt,
  });

  if (!previous || previous.mode !== state.mode) {
    const worse = previous ? state.mode !== previous.mode && ["survival", "hibernation"].includes(state.mode) : false;
    const severity = state.mode === "hibernation" ? "critical" : state.mode === "survival" ? "critical" : state.mode === "probation" ? "warning" : "info";
    const title = previous ? `Survival mandate: ${previous.mode} -> ${state.mode}` : `Survival mandate: ${state.mode}`;
    await repos.alerts.raise({ userId: scope.userId, brokerAccountId: scope.brokerAccountId, severity, kind: "risk", title, message: state.mandate.slice(0, 1000) });
    await rt.audit.record({ category: "risk", action: "survival_mode_changed", result: worse ? "info" : "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { from: previous?.mode ?? null, to: state.mode, fitnessScore: state.fitnessScore, riskMultiplier: state.riskMultiplier, runwayDays: state.runway.days, reasons: state.reasons.slice(0, 6) } });
    await repos.systemEvents.record("survival", worse ? "warning" : "info", `${scope.brokerAccountId}: ${title}`, { fitnessScore: state.fitnessScore, reasons: state.reasons.slice(0, 6) }).catch(() => undefined);
    rt.log.info({ scope: scope.brokerAccountId, from: previous?.mode ?? null, to: state.mode, fitness: state.fitnessScore }, "survival mode changed");
  }
  return state;
}

/** Latest stored state, recomputed when missing or stale. */
export async function loadSurvival(rt: SurvivalRuntime, facts: SurvivalAccountFacts): Promise<SurvivalState> {
  const row = await rt.repos.survival.latest(facts.scope);
  const state = stateFromRow(row);
  if (state && facts.now.getTime() - Date.parse(state.computedAt) < SURVIVAL_STALE_MS) return state;
  return refreshSurvival(rt, facts);
}

// ---------------------------------------------------------------------------------------------
// Strategy Darwinism (read side): fitness of every strategy for one account from stored profiles
// ---------------------------------------------------------------------------------------------

export interface StrategyFitnessView extends StrategyFitness { name: string; allocation: DarwinianAllocation | null }

export async function strategyFitnessForScope(repos: Repos, scope: TenantScope, now: Date): Promise<{ fitness: StrategyFitnessView[]; allocations: DarwinianAllocation[] }> {
  assertScope(scope, "strategyFitnessForScope");
  const db = repos.sessionsDb();
  const profilesRepo = new StrategyProfilesRepository(db);
  const settingsRepo = new StrategySettingsRepository(db);
  const [profiles, settings, catalog] = await Promise.all([profilesRepo.forScope(scope), settingsRepo.listForScope(scope), new StrategyCatalogRepository(db).list()]);
  const nowIso = now.toISOString();
  const fitness: StrategyFitness[] = [];
  const names = new Map(catalog.map((s) => [s.id, s.name]));
  for (const s of settings) {
    if (!s.enabled) continue;
    const live = profiles.find((p) => p.strategyId === s.strategyId && p.mode === "live");
    const shadow = profiles.find((p) => p.strategyId === s.strategyId && p.mode === "shadow");
    const key = live?.strategyKey ?? shadow?.strategyKey ?? catalog.find((c) => c.id === s.strategyId)?.key ?? s.strategyId;
    fitness.push(assessStrategyFitness({
      strategyId: s.strategyId, strategyKey: key, stage: s.stage as StrategyStage, capitalAllocation: s.capitalAllocation,
      live: live ? (live.profile as StrategyIntelligenceProfile) : null, shadow: shadow ? (shadow.profile as StrategyIntelligenceProfile) : null, now: nowIso,
    }));
  }
  const budget = Math.min(1, fitness.reduce((sum, f) => sum + f.currentAllocation, 0));
  const allocations = budget > 0 ? darwinianAllocation(fitness, { budget }) : [];
  const byId = new Map(allocations.map((a) => [a.strategyId, a]));
  return { fitness: fitness.map((f) => ({ ...f, name: names.get(f.strategyId) ?? f.strategyKey, allocation: byId.get(f.strategyId) ?? null })), allocations };
}
