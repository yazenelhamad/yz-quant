import type { AdaptationProposal, CalibrationProfile, ModelIntelligenceProfile, SignalIntelligenceProfile, StrategyIntelligenceProfile, TenantScope } from "@yz/core";
import { applyProposals, proposeAdaptations, proposalKey, type AdaptationBounds, type ExecutionStat, type LearningTier } from "@yz/core";
import type { AdaptationProposalRow } from "@yz/db";
import { listScopes, type LearningContext } from "./context.js";
import { calibrationRowToProfile, executionOutcomeRowToOutcome, proposalRowToProposal } from "./mapping.js";

/**
 * Bounds for every adaptable parameter. `maxStepPerDay` is the largest single change one daily run
 * may apply. Anything without bounds is never proposed (the core engine refuses unbounded change).
 */
export const ADAPTATION_BOUNDS: Readonly<Record<AdaptationProposal["target"], AdaptationBounds>> = Object.freeze({
  signal_weight: { min: 0.25, max: 2, maxStepPerDay: 0.1 },
  strategy_allocation: { min: 0, max: 1, maxStepPerDay: 0.05 },
  confidence_calibration: { min: 0.6, max: 1.1, maxStepPerDay: 0.05 },
  execution_preference: { min: 0.5, max: 1.5, maxStepPerDay: 0.1 },
  model_routing: { min: 0.25, max: 2, maxStepPerDay: 0.1 },
  strategy_ranking: { min: 0.5, max: 1.5, maxStepPerDay: 0.05 },
});

/**
 * Learning tiers. Only signal weights and allocation deltas (per-user `adaptiveOverrides`) and the
 * calibration adjustment are ever applied automatically. Execution preferences, model routing and
 * strategy ranking are slow-tier here: they are surfaced as proposals for the validation pipeline.
 */
export const ADAPTATION_TIERS: Readonly<Record<AdaptationProposal["target"], LearningTier>> = Object.freeze({
  signal_weight: "fast",
  strategy_allocation: "medium",
  confidence_calibration: "medium",
  execution_preference: "slow",
  model_routing: "slow",
  strategy_ranking: "slow",
});

export interface AdaptationRunResult {
  proposed: number;
  applied: number;
  skipped: number;
  frozen: boolean;
  byScope: Record<string, { proposed: number; applied: number }>;
}

export async function executionStatsForScope(ctx: LearningContext, scope: TenantScope): Promise<ExecutionStat[]> {
  const rows = await ctx.lr.inputs.executionOutcomesForScope(scope);
  const outcomes = rows.map(executionOutcomeRowToOutcome);
  const buckets = new Map<string, typeof outcomes>();
  for (const o of outcomes) (buckets.get(o.liquidityBucket) ?? buckets.set(o.liquidityBucket, []).get(o.liquidityBucket)!).push(o);
  const out: ExecutionStat[] = [];
  for (const [bucket, list] of buckets) {
    const filled = list.filter((o) => !o.missed && !o.cancelled && typeof o.actualSlippageBps === "number");
    const avg = filled.length ? filled.reduce((s, o) => s + (o.actualSlippageBps as number), 0) / filled.length : null;
    const exp = list.length ? list.reduce((s, o) => s + o.expectedSlippageBps, 0) / list.length : null;
    out.push({ key: `patience:${bucket}`, avgSlippageBps: avg, expectedSlippageBps: exp, fillRate: list.length ? filled.length / list.length : null, samples: list.length });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

async function persistProposals(ctx: LearningContext, proposals: AdaptationProposal[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const p of proposals) {
    const id = await ctx.lr.proposals.create(p.scope, {
      target: p.target, key: p.key, currentValue: p.currentValue, proposedValue: p.proposedValue, bounds: p.bounds, evidence: p.evidence,
      autoApplicable: p.autoApplicable, requiresValidationPipeline: p.requiresValidationPipeline, createdAt: p.createdAt,
    });
    ids.set(p.id, id);
  }
  return ids;
}

/**
 * Applies proposal rows inside `scope` (null = shared state). Refuses, audits and rethrows when a
 * proposal belongs to another scope or is outside its bounds. Returns the applied proposals.
 */
export async function applyProposalRows(ctx: LearningContext, scope: TenantScope | null, rows: AdaptationProposalRow[], frozen: boolean): Promise<{ applied: AdaptationProposal[]; skipped: number }> {
  const proposals = rows.map(proposalRowToProposal);
  if (proposals.length === 0) return { applied: [], skipped: 0 };
  const now = ctx.clock().toISOString();
  if (frozen) {
    await ctx.audit.record({ category: "learning", action: "adaptation_skipped_frozen", result: "info", userId: scope?.userId ?? null, brokerAccountId: scope?.brokerAccountId ?? null, actorUserId: null, detail: { proposals: proposals.length } });
    return { applied: [], skipped: proposals.length };
  }
  const current = await currentValuesFor(ctx, scope);
  let result: ReturnType<typeof applyProposals>;
  try {
    result = applyProposals(current.values, proposals, scope, now);
  } catch (err) {
    await ctx.audit.record({
      category: "learning", action: "adaptation_refused", result: "rejected", userId: scope?.userId ?? null, brokerAccountId: scope?.brokerAccountId ?? null, actorUserId: null,
      error: err instanceof Error ? err.message : String(err), detail: { proposalIds: rows.map((r) => r.id), name: err instanceof Error ? err.name : "Error" },
    });
    throw err;
  }
  for (const p of result.applied) {
    await writeAppliedValue(ctx, scope, p, current);
    await ctx.lr.proposals.setStatus(p.id, "applied", now);
    await ctx.audit.record({
      category: "learning", action: "adaptation_applied", result: "ok", userId: scope?.userId ?? null, brokerAccountId: scope?.brokerAccountId ?? null, actorUserId: null,
      detail: { proposalId: p.id, target: p.target, key: p.key, from: p.currentValue, to: p.proposedValue, bounds: p.bounds, evidence: p.evidence },
    });
  }
  return { applied: result.applied, skipped: result.skipped.length };
}

interface CurrentValues {
  values: Record<string, number>;
  /** proposal key -> strategy id whose settings row carries the override (scoped only). */
  ownerStrategy: Record<string, string>;
}

async function currentValuesFor(ctx: LearningContext, scope: TenantScope | null): Promise<CurrentValues> {
  const values: Record<string, number> = {};
  const ownerStrategy: Record<string, string> = {};
  if (scope === null) {
    for (const c of await ctx.lr.calibration.all()) values[proposalKey("confidence_calibration", c.key)] = c.adjustment;
    for (const m of await ctx.lr.modelRegistry.all()) values[proposalKey("model_routing", m.name)] = m.routingWeight;
    return { values, ownerStrategy };
  }
  const strategies = await ctx.lr.catalog.list();
  const byId = new Map(strategies.map((s) => [s.id, s]));
  const byKey = new Map(strategies.map((s) => [s.key, s]));
  const settings = await ctx.lr.settings.listForScope(scope);
  const signalOwner = await ctx.lr.inputs.signalStrategyKeys();
  for (const row of settings) {
    const s = byId.get(row.strategyId);
    if (!s) continue;
    const ov = row.adaptiveOverrides ?? {};
    const alloc = proposalKey("strategy_allocation", s.key);
    values[alloc] = typeof ov[alloc] === "number" ? ov[alloc] : row.capitalAllocation;
    ownerStrategy[alloc] = s.id;
    const rank = proposalKey("strategy_ranking", s.key);
    values[rank] = typeof ov[rank] === "number" ? ov[rank] : 1;
    ownerStrategy[rank] = s.id;
    for (const [sig, strategyKey] of Object.entries(signalOwner)) {
      if (strategyKey !== s.key) continue;
      const k = proposalKey("signal_weight", sig);
      values[k] = typeof ov[k] === "number" ? ov[k] : 1;
      ownerStrategy[k] = s.id;
    }
    // Overrides already learned for keys we no longer derive (kept so they can still be adapted).
    for (const [k, v] of Object.entries(ov)) if (!(k in values) && typeof v === "number") { values[k] = v; ownerStrategy[k] = s.id; }
  }
  void byKey;
  return { values, ownerStrategy };
}

async function writeAppliedValue(ctx: LearningContext, scope: TenantScope | null, p: AdaptationProposal, current: CurrentValues): Promise<void> {
  if (scope === null) {
    if (p.target === "confidence_calibration") { await ctx.lr.calibration.setAdjustment(p.key, p.proposedValue); return; }
    throw new Error(`shared target ${p.target} is never auto-applied`);
  }
  if (p.target !== "signal_weight" && p.target !== "strategy_allocation") throw new Error(`scoped target ${p.target} is never auto-applied`);
  const key = proposalKey(p.target, p.key);
  const strategyId = current.ownerStrategy[key];
  if (!strategyId) throw new Error(`no strategy settings row owns ${key} in this scope`);
  const row = await ctx.lr.settings.get(scope, strategyId);
  if (!row) throw new Error(`strategy settings ${strategyId} missing in scope`);
  await ctx.lr.settings.setAdaptiveOverrides(scope, strategyId, { ...(row.adaptiveOverrides ?? {}), [key]: p.proposedValue });
}

/** Daily adaptation: propose per scope and shared, persist everything, apply only the bounded auto-applicable subset inside its own scope. */
export async function runAdaptation(ctx: LearningContext, frozen: boolean): Promise<AdaptationRunResult> {
  const { lr } = ctx;
  const now = ctx.clock().toISOString();
  await lr.proposals.expireOlderThan(new Date(ctx.clock().getTime() - 7 * 86_400_000).toISOString());
  const result: AdaptationRunResult = { proposed: 0, applied: 0, skipped: 0, frozen, byScope: {} };
  const calibrations: CalibrationProfile[] = (await lr.calibration.all()).map(calibrationRowToProfile);
  const signalProfiles: SignalIntelligenceProfile[] = (await lr.signalProfiles.all()).map((r) => r.profile as SignalIntelligenceProfile);
  const modelProfiles: ModelIntelligenceProfile[] = (await lr.modelProfiles.all()).map((r) => r.profile as ModelIntelligenceProfile);
  const sharedStrategyProfiles = (await lr.strategyProfiles.shared()).filter((r) => r.mode === "all").map((r) => r.profile as StrategyIntelligenceProfile);
  const idFn = (target: AdaptationProposal["target"], key: string) => `adapt:${target}:${key}:${now}`;

  const runFor = async (scope: TenantScope | null): Promise<void> => {
    const current = await currentValuesFor(ctx, scope);
    const scoped = scope ? (await lr.strategyProfiles.forScope(scope)).filter((r) => r.mode === "all").map((r) => r.profile as StrategyIntelligenceProfile) : [];
    const proposals = proposeAdaptations({
      scope,
      strategyProfiles: scope ? [...scoped, ...sharedStrategyProfiles] : [],
      signalProfiles: scope ? signalProfiles : [],
      calibrations: scope ? [] : calibrations,
      executionStats: scope ? await executionStatsForScope(ctx, scope) : [],
      modelProfiles: scope ? [] : modelProfiles,
      currentValues: current.values,
      bounds: { ...ADAPTATION_BOUNDS },
      tier: { ...ADAPTATION_TIERS },
      now,
      idFn,
    });
    const ids = await persistProposals(ctx, proposals);
    const rows = (await Promise.all([...ids.values()].map((id) => lr.proposals.byId(id)))).filter((r): r is AdaptationProposalRow => !!r);
    const auto = rows.filter((r) => r.autoApplicable && !r.requiresValidationPipeline);
    const applied = await applyProposalRows(ctx, scope, auto, frozen);
    const key = scope ? `${scope.userId}/${scope.brokerAccountId}` : "shared";
    result.byScope[key] = { proposed: proposals.length, applied: applied.applied.length };
    result.proposed += proposals.length;
    result.applied += applied.applied.length;
    result.skipped += applied.skipped + (rows.length - auto.length);
  };
  await runFor(null);
  for (const scope of await listScopes(ctx)) await runFor(scope);
  return result;
}
