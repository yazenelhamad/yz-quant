import type {
  AdaptationProposal,
  CalibrationProfile,
  IsoTimestamp,
  ModelIntelligenceProfile,
  SignalIntelligenceProfile,
  StrategyIntelligenceProfile,
  TenantScope,
} from "../types/index.js";
import { CrossTenantError, ScopeError, sameScope } from "../types/index.js";
import { calibrationAdjustment } from "./calibration.js";
import { clamp, isFiniteNumber, pct } from "./math.js";
import { MAX_ALLOCATION_DELTA } from "./profiles.js";

export type AdaptationTarget = AdaptationProposal["target"];
export type LearningTier = "fast" | "medium" | "slow";

export interface AdaptationBounds {
  min: number;
  max: number;
  maxStepPerDay: number;
}

/** Targets the learning engine may change on its own (within bounds). Nothing else is ever auto-applied. */
export const AUTO_APPLICABLE_TARGETS: ReadonlySet<AdaptationTarget> = new Set([
  "signal_weight",
  "strategy_allocation",
  "confidence_calibration",
  "execution_preference",
  "model_routing",
  "strategy_ranking",
]);

/** Default learning speed by target. Slow-tier items (risk limits, philosophy) are never among these targets. */
export const DEFAULT_TIER_BY_TARGET: Readonly<Record<AdaptationTarget, LearningTier>> = Object.freeze({
  signal_weight: "fast",
  execution_preference: "fast",
  strategy_allocation: "medium",
  confidence_calibration: "medium",
  model_routing: "medium",
  strategy_ranking: "medium",
});

export const STRATEGY_ALLOCATION_MAX_STEP = MAX_ALLOCATION_DELTA;
export const MIN_SIGNAL_SAMPLES = 30;

export interface ExecutionStat {
  /** e.g. "limit_at_mid:low" (preference key : liquidity bucket) */
  key: string;
  avgSlippageBps: number | null;
  expectedSlippageBps: number | null;
  fillRate: number | null;
  samples: number;
}

export interface ProposeAdaptationsInput {
  scope: TenantScope | null;
  strategyProfiles: StrategyIntelligenceProfile[];
  signalProfiles: SignalIntelligenceProfile[];
  calibrations: CalibrationProfile[];
  executionStats: ExecutionStat[];
  modelProfiles?: ModelIntelligenceProfile[];
  /** Current values keyed by "<target>:<key>". Proposals are only made for keys present here. */
  currentValues: Record<string, number>;
  /** Bounds keyed by "<target>:<key>" or by target. */
  bounds: Record<string, AdaptationBounds>;
  /** Tier keyed by "<target>:<key>" or by target; defaults to DEFAULT_TIER_BY_TARGET. */
  tier: Record<string, LearningTier>;
  now: IsoTimestamp;
  idFn?: (target: AdaptationTarget, key: string) => string;
}

export function proposalKey(target: AdaptationTarget, key: string): string {
  return `${target}:${key}`;
}

export function resolveBounds(bounds: Record<string, AdaptationBounds>, target: AdaptationTarget, key: string): AdaptationBounds | null {
  return bounds[proposalKey(target, key)] ?? bounds[target] ?? null;
}

export function resolveTier(tier: Record<string, LearningTier>, target: AdaptationTarget, key: string): LearningTier {
  return tier[proposalKey(target, key)] ?? tier[target] ?? DEFAULT_TIER_BY_TARGET[target];
}

/** Clamp a desired value to the bounds and to one day's maximum step from the current value. */
export function clampProposal(current: number, desired: number, bounds: AdaptationBounds): number {
  const step = clamp(desired - current, -bounds.maxStepPerDay, bounds.maxStepPerDay);
  return clamp(current + step, bounds.min, bounds.max);
}

export function isWithinBounds(current: number, proposed: number, bounds: AdaptationBounds, eps = 1e-9): boolean {
  return proposed >= bounds.min - eps && proposed <= bounds.max + eps && Math.abs(proposed - current) <= bounds.maxStepPerDay + eps;
}

interface Draft {
  target: AdaptationTarget;
  key: string;
  desired: number;
  evidence: string;
}

function evidenceScopeAllowed(profileScope: TenantScope | null, callerScope: TenantScope | null, context: string): boolean {
  if (profileScope === null) return true; // shared evidence may inform any scope
  if (callerScope === null) return false; // user-specific evidence never drives shared proposals
  if (!sameScope(profileScope, callerScope)) throw new CrossTenantError(`Cross-tenant evidence in ${context}`, callerScope, profileScope);
  return true;
}

/**
 * Turns intelligence profiles into bounded parameter proposals. Every proposal is clamped to its
 * bounds and its daily step; strategy allocation steps are additionally capped at +/-0.05.
 * Slow-tier keys always require the validation pipeline and are never auto-applicable.
 */
export function proposeAdaptations(input: ProposeAdaptationsInput): AdaptationProposal[] {
  const drafts: Draft[] = [];

  for (const p of input.strategyProfiles) {
    if (!evidenceScopeAllowed(p.scope, input.scope, "proposeAdaptations(strategyProfile)")) continue;
    const a = p.assessment;
    if (a.recommendedStatus !== "insufficient_data" && a.recommendedAllocationDelta !== 0) {
      const cur = input.currentValues[proposalKey("strategy_allocation", p.strategyKey)];
      if (isFiniteNumber(cur)) {
        const delta = clamp(a.recommendedAllocationDelta, -STRATEGY_ALLOCATION_MAX_STEP, STRATEGY_ALLOCATION_MAX_STEP);
        drafts.push({ target: "strategy_allocation", key: p.strategyKey, desired: cur + delta, evidence: `${p.strategyKey}: ${a.recommendedStatus.replace(/_/g, " ")} over ${p.overall.trades} trades (expectancy ${pct(p.overall.expectancyPct)}, recent ${pct(p.recent.expectancyPct)}, trend ${a.edgeTrend}).` });
      }
    }
    if (a.recommendedStatus !== "insufficient_data" && a.edgeTrend !== "unknown" && a.edgeTrend !== "stable") {
      const cur = input.currentValues[proposalKey("strategy_ranking", p.strategyKey)];
      if (isFiniteNumber(cur)) {
        const b = resolveBounds(input.bounds, "strategy_ranking", p.strategyKey);
        const step = b ? b.maxStepPerDay : 0.05;
        drafts.push({ target: "strategy_ranking", key: p.strategyKey, desired: cur + (a.edgeTrend === "improving" ? step : -step), evidence: `${p.strategyKey}: edge trend ${a.edgeTrend} (degradation score ${p.degradation.score.toFixed(2)}).` });
      }
    }
  }

  for (const s of input.signalProfiles) {
    const cur = input.currentValues[proposalKey("signal_weight", s.signalKey)];
    if (!isFiniteNumber(cur) || s.sampleSize < MIN_SIGNAL_SAMPLES) continue;
    const hist = s.historicalPredictiveValue;
    const recent = s.recentPredictiveValue;
    if (hist === null || recent === null) continue;
    // Relative change proportional to the IC gap, capped at +/-20% of the current weight.
    const relative = clamp((recent - hist) * 2, -0.2, 0.2);
    let desired = cur * (1 + relative);
    if (recent < 0 && hist > 0) desired = Math.min(desired, cur * 0.8);
    desired = clamp(desired, s.weightBounds.min, s.weightBounds.max);
    if (Math.abs(desired - cur) < 1e-9) continue;
    drafts.push({ target: "signal_weight", key: s.signalKey, desired, evidence: `${s.signalKey}: recent IC ${recent.toFixed(3)} vs historical ${hist.toFixed(3)} over ${s.sampleSize} observations.` });
  }

  for (const c of input.calibrations) {
    const cur = input.currentValues[proposalKey("confidence_calibration", c.key)];
    if (!isFiniteNumber(cur)) continue;
    const desired = calibrationAdjustment(c);
    if (Math.abs(desired - cur) < 1e-9) continue;
    drafts.push({ target: "confidence_calibration", key: c.key, desired, evidence: `${c.key}: overconfidence ratio ${c.overconfidenceRatio === null ? "n/a" : c.overconfidenceRatio.toFixed(2)}, ECE ${c.expectedCalibrationError === null ? "n/a" : c.expectedCalibrationError.toFixed(3)} over ${c.sampleSize} predictions.` });
  }

  for (const x of input.executionStats) {
    const cur = input.currentValues[proposalKey("execution_preference", x.key)];
    if (!isFiniteNumber(cur) || x.samples < 20 || x.avgSlippageBps === null || x.expectedSlippageBps === null || x.expectedSlippageBps <= 0) continue;
    const ratio = x.avgSlippageBps / x.expectedSlippageBps;
    let desired = cur;
    if (ratio > 1.5) desired = cur * 0.9;
    else if (ratio < 0.75 && (x.fillRate ?? 1) >= 0.8) desired = cur * 1.1;
    if (Math.abs(desired - cur) < 1e-9) continue;
    drafts.push({ target: "execution_preference", key: x.key, desired, evidence: `${x.key}: realised slippage ${x.avgSlippageBps.toFixed(1)} bps vs expected ${x.expectedSlippageBps.toFixed(1)} bps over ${x.samples} fills${x.fillRate !== null ? `, fill rate ${(x.fillRate * 100).toFixed(0)}%` : ""}.` });
  }

  for (const m of input.modelProfiles ?? []) {
    const cur = input.currentValues[proposalKey("model_routing", m.modelName)];
    if (!isFiniteNumber(cur) || m.accuracy === null || m.calibration.sampleSize < MIN_SIGNAL_SAMPLES) continue;
    const relative = clamp((m.accuracy - 0.5) * 0.4 - (m.failureRate ?? 0) * 0.5, -0.2, 0.2);
    const desired = cur * (1 + relative);
    if (Math.abs(desired - cur) < 1e-9) continue;
    drafts.push({ target: "model_routing", key: m.modelName, desired, evidence: `${m.modelName}@${m.modelVersion}: accuracy ${(m.accuracy * 100).toFixed(0)}%, failure rate ${((m.failureRate ?? 0) * 100).toFixed(1)}% over ${m.calibration.sampleSize} predictions.` });
  }

  const proposals: AdaptationProposal[] = [];
  for (const d of drafts) {
    const bounds = resolveBounds(input.bounds, d.target, d.key);
    if (!bounds) continue; // no bounds => no proposal; unbounded change is never allowed
    const effectiveBounds: AdaptationBounds = d.target === "strategy_allocation" ? { ...bounds, maxStepPerDay: Math.min(bounds.maxStepPerDay, STRATEGY_ALLOCATION_MAX_STEP) } : bounds;
    const current = input.currentValues[proposalKey(d.target, d.key)] as number;
    const proposed = clampProposal(current, d.desired, effectiveBounds);
    if (Math.abs(proposed - current) < 1e-9) continue;
    const tier = resolveTier(input.tier, d.target, d.key);
    const slow = tier === "slow";
    proposals.push({
      id: input.idFn ? input.idFn(d.target, d.key) : `adapt:${d.target}:${d.key}:${input.now}`,
      scope: input.scope,
      target: d.target,
      key: d.key,
      currentValue: current,
      proposedValue: proposed,
      bounds: effectiveBounds,
      evidence: `${d.evidence}${Math.abs(proposed - d.desired) > 1e-9 ? ` Desired ${d.desired.toFixed(4)} clamped to ${proposed.toFixed(4)}.` : ""}${slow ? " Slow-tier parameter: requires the validation pipeline." : ""}`,
      autoApplicable: !slow && AUTO_APPLICABLE_TARGETS.has(d.target) && isWithinBounds(current, proposed, effectiveBounds),
      requiresValidationPipeline: slow || !AUTO_APPLICABLE_TARGETS.has(d.target),
      createdAt: input.now,
      appliedAt: null,
    });
  }
  return proposals;
}

export class AdaptationBoundsError extends Error {
  override readonly name = "AdaptationBoundsError";
  constructor(message: string, readonly proposal: AdaptationProposal) {
    super(message);
  }
}

export interface ApplyProposalsResult {
  values: Record<string, number>;
  applied: AdaptationProposal[];
  skipped: { proposal: AdaptationProposal; reason: "not_auto_applicable" | "requires_validation" | "stale_current_value" | "already_applied" }[];
}

/**
 * Applies auto-applicable proposals to a value map and returns the new map. Pure: neither the
 * map nor the proposals are mutated. Refuses (throws) any proposal from a different scope or
 * outside its bounds; skips proposals that are not auto-applicable, already applied or stale.
 */
export function applyProposals(current: Record<string, number>, proposals: readonly AdaptationProposal[], scope: TenantScope | null, now: IsoTimestamp | null = null): ApplyProposalsResult {
  const values = { ...current };
  const applied: AdaptationProposal[] = [];
  const skipped: ApplyProposalsResult["skipped"] = [];
  for (const p of proposals) {
    if (p.scope === null && scope !== null) throw new ScopeError(`Shared proposal ${p.id} cannot be applied inside user scope ${scope.userId}`);
    if (p.scope !== null && scope === null) throw new ScopeError(`Scoped proposal ${p.id} cannot be applied to shared state`);
    if (p.scope !== null && scope !== null && !sameScope(p.scope, scope)) throw new CrossTenantError(`Proposal ${p.id} belongs to another tenant`, scope, p.scope);
    if (!isWithinBounds(p.currentValue, p.proposedValue, p.bounds)) throw new AdaptationBoundsError(`Proposal ${p.id} is outside its bounds`, p);
    if (p.target === "strategy_allocation" && Math.abs(p.proposedValue - p.currentValue) > STRATEGY_ALLOCATION_MAX_STEP + 1e-9) throw new AdaptationBoundsError(`Proposal ${p.id} exceeds the allocation step cap`, p);
    if (p.appliedAt !== null) {
      skipped.push({ proposal: p, reason: "already_applied" });
      continue;
    }
    if (p.requiresValidationPipeline) {
      skipped.push({ proposal: p, reason: "requires_validation" });
      continue;
    }
    if (!p.autoApplicable) {
      skipped.push({ proposal: p, reason: "not_auto_applicable" });
      continue;
    }
    const k = proposalKey(p.target, p.key);
    const live = values[k];
    if (isFiniteNumber(live) && Math.abs(live - p.currentValue) > 1e-9) {
      skipped.push({ proposal: p, reason: "stale_current_value" });
      continue;
    }
    values[k] = p.proposedValue;
    applied.push({ ...p, bounds: { ...p.bounds }, appliedAt: now ?? p.createdAt });
  }
  return { values, applied, skipped };
}
