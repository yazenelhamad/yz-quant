import type { IsoTimestamp, StrategyVersion } from "../types/index.js";

const VERSION_RE = /^(\d+)\.(\d+)$/;

export function parseVersion(version: string): { major: number; minor: number } {
  const m = VERSION_RE.exec(version.trim());
  if (!m) throw new Error(`Invalid strategy version "${version}" (expected "<major>.<minor>")`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function bumpVersion(current: string, kind: "minor" | "major"): string {
  const { major, minor } = parseVersion(current);
  return kind === "major" ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va.major - vb.major || va.minor - vb.minor;
}

export interface StrategyVersionChange {
  /** Required when there is no previous version. */
  strategyId?: string;
  kind: "minor" | "major";
  parameters: Record<string, number | string | boolean>;
  changeSummary: string;
  changeReason: string;
  proposedBy: StrategyVersion["proposedBy"];
  backtestResultId?: string | null;
  outOfSampleResultId?: string | null;
  walkForwardResultId?: string | null;
  shadowResultSummary?: Record<string, number> | null;
}

/**
 * Creates the next strategy version as a fresh "proposed" record. The previous version is never
 * mutated; superseding it is a separate, explicit step (`supersedeVersion`).
 */
export function createStrategyVersion(prev: StrategyVersion | null, change: StrategyVersionChange, now: IsoTimestamp, idFn: () => string): StrategyVersion {
  const strategyId = prev?.strategyId ?? change.strategyId;
  if (!strategyId) throw new Error("createStrategyVersion: strategyId is required when there is no previous version");
  if (prev && change.strategyId && change.strategyId !== prev.strategyId) throw new Error(`createStrategyVersion: strategy mismatch (${change.strategyId} vs ${prev.strategyId})`);
  return {
    id: idFn(),
    strategyId,
    version: prev ? bumpVersion(prev.version, change.kind) : "1.0",
    parameters: { ...change.parameters },
    changeSummary: change.changeSummary,
    changeReason: change.changeReason,
    proposedBy: { ...change.proposedBy },
    backtestResultId: change.backtestResultId ?? null,
    outOfSampleResultId: change.outOfSampleResultId ?? null,
    walkForwardResultId: change.walkForwardResultId ?? null,
    shadowResultSummary: change.shadowResultSummary ? { ...change.shadowResultSummary } : null,
    approvalStatus: "proposed",
    approvedBy: null,
    deployedAt: null,
    createdAt: now,
  };
}

/** Returns a copy of `prev` marked superseded. */
export function supersedeVersion(prev: StrategyVersion): StrategyVersion {
  return { ...prev, parameters: { ...prev.parameters }, approvalStatus: "superseded" };
}

export interface DecisionProvenanceInput {
  modelName: string;
  modelVersion: string;
  promptVersion: string;
  featureVersion: string;
  strategyVersion: StrategyVersion | string | null;
  riskEngineVersion: string;
}

export interface DecisionProvenance {
  modelName: string;
  modelVersion: string;
  promptVersion: string;
  featureVersion: string;
  strategyVersion: string;
  riskEngineVersion: string;
}

export const UNVERSIONED = "unversioned";

/** The `versions` record stamped on every thesis, decision and trade so outcomes can be attributed. */
export function decisionProvenance(input: DecisionProvenanceInput): DecisionProvenance {
  const sv = input.strategyVersion;
  return {
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    promptVersion: input.promptVersion,
    featureVersion: input.featureVersion,
    strategyVersion: sv === null ? UNVERSIONED : typeof sv === "string" ? sv : `${sv.version}@${sv.id}`,
    riskEngineVersion: input.riskEngineVersion,
  };
}
