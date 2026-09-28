import type { ModelIntelligenceProfile } from "@yz/core";
import type { ModelRole } from "../llm/contract.js";
import { DEFAULT_MODELS } from "../llm/anthropicClient.js";
import type { Budget } from "./budget.js";

/**
 * MODEL ROUTER — decides which kind of handler a task goes to. It never executes anything.
 *
 * Hard rules (cannot be changed by configuration, profiles or budget):
 *   - `risk` and `accounting` are ALWAYS deterministic. No model output ever touches them.
 *   - `fast_decision` is deterministic (the fast brain). An LLM "fast" role may be attached only
 *     as an advisory verification when the situation is flagged unusual; it cannot decide.
 *   - `numeric_forecast` -> statistical, `pattern_detection` -> ml.
 * Soft rules: research / unusual_situation / thesis / news / post-trade review go to the LLM roles,
 * with alternatives chosen when a model's intelligence profile shows negative value-add or a high
 * failure rate, and with a daily cost guard (`Budget`).
 */
export type TaskKind =
  | "fast_decision"
  | "numeric_forecast"
  | "pattern_detection"
  | "research"
  | "unusual_situation"
  | "thesis"
  | "news_interpretation"
  | "post_trade_review"
  | "risk"
  | "accounting";

export type TaskUrgency = "low" | "normal" | "high" | "critical";
export type Handler = "deterministic" | "statistical" | "ml" | "llm";

export interface RouteTask {
  kind: TaskKind;
  urgency: TaskUrgency;
  /** Per-task spend cap; combined with the daily Budget when provided. */
  budgetUsd?: number;
  modelProfiles?: ModelIntelligenceProfile[];
  /** For fast_decision: the fast brain flagged the situation as unusual and a verification is wanted. */
  flagged?: boolean;
}

export interface RouteDecision {
  handler: Handler;
  role?: ModelRole;
  model?: string;
  /** Model output is advisory only (cannot change a deterministic decision). */
  advisoryOnly?: boolean;
  /** The preferred LLM route was unavailable (budget/profile); deterministic path continues. */
  degraded?: boolean;
  reason: string;
}

export interface RouterOptions {
  budget?: Budget;
  /** Role -> model id (for looking up model profiles). Defaults to DEFAULT_MODELS. */
  models?: Partial<Record<ModelRole, string>>;
  /** Estimated cost of one LLM call for the guard. Default 0.25 USD. */
  estimatedCallCostUsd?: number;
  /** Failure-rate threshold above which a model is avoided. Default 0.25. */
  maxFailureRate?: number;
}

export const NEVER_LLM_TASKS: ReadonlySet<TaskKind> = new Set<TaskKind>(["risk", "accounting"]);

const ALTERNATIVE_ROLE: Record<ModelRole, ModelRole> = { slow_brain: "research", research: "slow_brain", fast: "research" };

export function routeTask(task: RouteTask, options: RouterOptions = {}): RouteDecision {
  const models: Record<ModelRole, string> = { ...DEFAULT_MODELS, ...stripUndefined(options.models ?? {}) };

  if (NEVER_LLM_TASKS.has(task.kind)) {
    return { handler: "deterministic", reason: `${task.kind} is always deterministic; model output is never consulted` };
  }
  if (task.kind === "numeric_forecast") return { handler: "statistical", reason: "numeric forecasts use statistical models, not language models" };
  if (task.kind === "pattern_detection") return { handler: "ml", reason: "pattern detection uses the ML/feature pipeline" };

  if (task.kind === "fast_decision") {
    if (!task.flagged) return { handler: "deterministic", reason: "fast decisions are made by the deterministic fast brain" };
    const verify = pickLlm("fast", task, models, options);
    if (verify.handler === "llm") {
      return { ...verify, advisoryOnly: true, reason: `deterministic fast brain decides; ${verify.reason} attached as advisory verification only` };
    }
    return { handler: "deterministic", degraded: true, reason: `fast brain decides without verification: ${verify.reason}` };
  }

  const preferred: ModelRole =
    task.kind === "research" || task.kind === "post_trade_review" || task.kind === "news_interpretation" ? "research" : "slow_brain";
  return pickLlm(preferred, task, models, options);
}

function pickLlm(preferred: ModelRole, task: RouteTask, models: Record<ModelRole, string>, options: RouterOptions): RouteDecision {
  const estimate = options.estimatedCallCostUsd ?? 0.25;
  if (task.budgetUsd !== undefined && task.budgetUsd < estimate) {
    return { handler: "deterministic", degraded: true, reason: `task budget ${task.budgetUsd.toFixed(2)} USD below estimated call cost ${estimate.toFixed(2)} USD; llm skipped` };
  }
  if (options.budget && !options.budget.canSpend(estimate)) {
    return {
      handler: "deterministic",
      degraded: true,
      reason: `daily model budget exhausted (${options.budget.spentTodayUsd().toFixed(2)}/${options.budget.dailyLimitUsd.toFixed(2)} USD); llm skipped`,
    };
  }

  const reasons: string[] = [];
  const candidates: ModelRole[] = [preferred, ALTERNATIVE_ROLE[preferred]];
  for (const role of candidates) {
    const model = models[role];
    const problem = profileProblem(model, task.modelProfiles ?? [], options.maxFailureRate ?? 0.25);
    if (problem) {
      reasons.push(`${role} (${model}) avoided: ${problem}`);
      continue;
    }
    const prefix = reasons.length > 0 ? `${reasons.join("; ")}; ` : "";
    return { handler: "llm", role, model, reason: `${prefix}${task.kind} routed to llm role ${role} (${model})` };
  }
  // Every candidate has a poor profile: still allow the preferred role but mark degraded, so the caller can down-weight it.
  return {
    handler: "llm",
    role: preferred,
    model: models[preferred],
    degraded: true,
    reason: `${reasons.join("; ")}; no healthy alternative, using ${preferred} with reduced trust`,
  };
}

function profileProblem(model: string, profiles: ModelIntelligenceProfile[], maxFailureRate: number): string | null {
  const profile = profiles.find((p) => p.modelName === model);
  if (!profile) return null;
  if (profile.valueAdded !== null && profile.valueAdded < 0) return `valueAdded ${profile.valueAdded.toFixed(3)} < 0`;
  if (profile.failureRate !== null && profile.failureRate > maxFailureRate) return `failureRate ${profile.failureRate.toFixed(2)} > ${maxFailureRate}`;
  if (profile.routingWeight <= 0) return "routingWeight is 0";
  return null;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
