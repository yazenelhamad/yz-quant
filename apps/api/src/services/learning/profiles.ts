import type { AgentIntelligenceProfile, ExecutionOutcome, ModelIntelligenceProfile, SignalIntelligenceProfile, StrategyIntelligenceProfile, TenantScope, TradeMemoryEntry } from "@yz/core";
import { buildAgentProfile, buildModelProfile, buildSignalProfile, buildStrategyProfile, type AgentDecisionObservation, type ModelPrediction, type SignalObservation } from "@yz/core";
import { listScopes, scopeKey, type LearningContext } from "./context.js";
import { executionOutcomeRowToOutcome, memoryRowToEntry, regimeLookup } from "./mapping.js";

export const SIGNAL_WEIGHT_BOUNDS = Object.freeze({ min: 0.25, max: 2 });
const PROFILE_MODES: StrategyIntelligenceProfile["mode"][] = ["all", "live", "shadow"];

export interface ProfilesRebuildResult {
  strategyProfiles: number;
  signalProfiles: number;
  modelProfiles: number;
  agentProfiles: number;
  /** Shared "all" profiles keyed by strategy key (for regime insights and scorecards). */
  sharedByStrategy: Record<string, StrategyIntelligenceProfile>;
}

function returnSeries(entries: TradeMemoryEntry[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const sorted = [...entries].filter((e) => typeof e.actualReturnPct === "number").sort((a, b) => Date.parse(a.closedAt ?? a.openedAt) - Date.parse(b.closedAt ?? b.openedAt));
  for (const e of sorted) (out[e.strategyKey] ??= []).push(e.actualReturnPct as number);
  return out;
}

/**
 * Rebuilds every intelligence profile from stored evidence. Shared profiles read both users'
 * shadow + live memory but are stored without scope; per-user profiles only ever see that user's
 * entries (the core engine asserts it). Nothing here writes user state.
 */
export async function rebuildProfiles(ctx: LearningContext): Promise<ProfilesRebuildResult> {
  const { lr, repos } = ctx;
  const now = ctx.clock().toISOString();
  const strategies = await lr.catalog.list();
  const memoryRows = await lr.memory.all();
  const allEntries = memoryRows.map(memoryRowToEntry);
  const scopes = await listScopes(ctx);

  const outcomesByScope = new Map<string, ExecutionOutcome[]>();
  for (const scope of scopes) {
    const rows = await lr.inputs.executionOutcomesForScope(scope);
    outcomesByScope.set(scopeKey(scope), rows.map(executionOutcomeRowToOutcome));
  }
  const allOutcomes = [...outcomesByScope.values()].flat();

  let strategyProfiles = 0;
  const sharedByStrategy: Record<string, StrategyIntelligenceProfile> = {};

  const buildFor = async (scope: TenantScope | null, entries: TradeMemoryEntry[], outcomes: ExecutionOutcome[]): Promise<void> => {
    const correlations = returnSeries(entries);
    for (const s of strategies) {
      const own = entries.filter((e) => e.strategyKey === s.key);
      if (scope && own.length === 0) continue; // no evidence in this scope: no per-user profile row
      for (const mode of PROFILE_MODES) {
        if (mode !== "all" && !own.some((e) => e.mode === mode)) continue;
        const profile = buildStrategyProfile({ strategyId: s.id, strategyKey: s.key, scope, mode, entries: own, executionOutcomes: outcomes, correlations, theoreticalEdgePct: null, now });
        await lr.strategyProfiles.upsert({ strategyId: s.id, strategyKey: s.key, scope, mode, profile });
        strategyProfiles += 1;
        if (scope === null && mode === "all") sharedByStrategy[s.key] = profile;
      }
    }
  };
  await buildFor(null, allEntries, allOutcomes);
  for (const scope of scopes) {
    const entries = allEntries.filter((e) => e.scope.userId === scope.userId && e.scope.brokerAccountId === scope.brokerAccountId);
    await buildFor(scope, entries, outcomesByScope.get(scopeKey(scope)) ?? []);
  }

  // ---- signal profiles (shared) ----
  const regimeHistory = await repos.market.regimeHistory(2000);
  const regimeAt = regimeLookup(regimeHistory);
  const keys = await repos.market.signalKeys();
  const seriesByKey: Record<string, number[]> = {};
  const obsByKey: Record<string, SignalObservation[]> = {};
  for (const key of keys) {
    const rows = await repos.market.resolvedSignals(key, 2000);
    const sorted = [...rows].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
    obsByKey[key] = sorted.map((r) => ({ value: r.value, realizedReturnPct: r.realizedReturnPct, regime: regimeAt(r.asOf), asOf: r.asOf }));
    seriesByKey[key] = sorted.map((r) => r.value);
  }
  let signalProfiles = 0;
  const signalProfilesOut: SignalIntelligenceProfile[] = [];
  for (const key of keys) {
    const others: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(seriesByKey)) if (k !== key) others[k] = v;
    const profile = buildSignalProfile(key, obsByKey[key] ?? [], others, now, { weightBounds: { ...SIGNAL_WEIGHT_BOUNDS }, currentWeight: 1 });
    await lr.signalProfiles.upsert(key, profile);
    signalProfilesOut.push(profile);
    signalProfiles += 1;
  }

  // ---- model profiles: resolved predictions + model output failures ----
  const registry = await lr.modelRegistry.all();
  const predictions = await lr.inputs.resolvedPredictions();
  const outputs = await lr.inputs.modelOutputsRecent(5000);
  const predsByModel = new Map<string, ModelPrediction[]>();
  for (const p of predictions) {
    const k = `${p.modelName}@${p.modelVersion}`;
    (predsByModel.get(k) ?? predsByModel.set(k, []).get(k)!).push({
      predicted: p.confidence ?? 0.5, realized: null, correct: p.correct === true, latencyMs: p.latencyMs, costUsd: p.costUsd ?? 0,
      regime: regimeAt(p.asOf), symbol: p.symbol, strategy: p.kind,
    });
  }
  const outputsByModel = new Map<string, typeof outputs>();
  for (const o of outputs) {
    const k = `${o.modelName}@${o.modelVersion}`;
    (outputsByModel.get(k) ?? outputsByModel.set(k, []).get(k)!).push(o);
  }
  let modelProfiles = 0;
  for (const k of new Set([...predsByModel.keys(), ...outputsByModel.keys()])) {
    const [modelName, modelVersion] = k.split("@") as [string, string];
    const preds = predsByModel.get(k) ?? [];
    const outs = outputsByModel.get(k) ?? [];
    const routingWeight = registry.find((m) => m.name === modelName)?.routingWeight ?? 1;
    const base = buildModelProfile(modelName, modelVersion, preds, {}, now, { routingWeight });
    const profile: ModelIntelligenceProfile = { ...base };
    if (outs.length > 0) {
      profile.failureRate = outs.filter((o) => !o.valid).length / outs.length;
      profile.costUsd += outs.reduce((s, o) => s + (o.costUsd ?? 0), 0);
      if (profile.latencyMsP50 === null) {
        const lat = outs.map((o) => o.latencyMs).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
        profile.latencyMsP50 = lat.length ? lat[Math.floor(lat.length / 2)]! : null;
      }
    }
    await lr.modelProfiles.upsert(modelName, modelVersion, profile);
    modelProfiles += 1;
  }

  // ---- agent profiles: committee votes joined to reviewed trade outcomes (scoped lookups) ----
  const agents = await lr.agentRegistry.all();
  const obsByAgent = new Map<string, AgentDecisionObservation[]>();
  const reviewCache = new Map<string, boolean | null>();
  for (const o of outputs) {
    if (!o.thesisId || !o.userId || !o.brokerAccountId) continue;
    const scope = { userId: o.userId, brokerAccountId: o.brokerAccountId };
    const cacheKey = `${scopeKey(scope)}:${o.thesisId}`;
    let success = reviewCache.get(cacheKey);
    if (success === undefined) {
      const thesis = await repos.theses.byId(scope, o.thesisId);
      const review = thesis?.tradeId ? await lr.reviews.forTrade(scope, thesis.tradeId) : undefined;
      const r = review?.review as { returnPct?: number } | undefined;
      success = r && typeof r.returnPct === "number" ? r.returnPct > 0 : null;
      reviewCache.set(cacheKey, success);
    }
    if (success === null) continue;
    const out = (o.output ?? {}) as { vote?: string; verdict?: string; confidence?: number };
    const vote = out.vote ?? out.verdict;
    const agentVote: AgentDecisionObservation["agentVote"] = vote === "strong_buy" || vote === "buy" || vote === "proceed" ? "for" : vote === "sell" || vote === "reduce" || vote === "reject" || vote === "wait" ? "against" : "abstain";
    (obsByAgent.get(o.agentName) ?? obsByAgent.set(o.agentName, []).get(o.agentName)!).push({ agentVote, finalOutcomeSuccess: success, includedInDecision: o.valid, confidence: typeof out.confidence === "number" ? out.confidence : 0.5 });
  }
  let agentProfiles = 0;
  for (const name of new Set([...agents.map((a) => a.name), ...obsByAgent.keys()])) {
    const influenceWeight = agents.find((a) => a.name === name)?.influenceWeight ?? 1;
    const profile: AgentIntelligenceProfile = buildAgentProfile(name, obsByAgent.get(name) ?? [], now, { influenceWeight });
    await lr.agentProfiles.upsert(name, profile);
    agentProfiles += 1;
  }

  return { strategyProfiles, signalProfiles, modelProfiles, agentProfiles, sharedByStrategy };
}
