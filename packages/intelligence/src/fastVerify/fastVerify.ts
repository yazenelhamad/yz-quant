import type { FastBrainInput, FastBrainOutput } from "@yz/core";
import { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderJson, runAgent, type AgentOptions } from "../agents/shared.js";

/**
 * FAST VERIFY — optional LLM sanity check of a deterministic FastBrainOutput in unusual situations.
 *
 * The result is ADVISORY ONLY. It cannot change the action, cannot bypass risk, and cannot raise
 * conviction. The only effect it may have (via `applyFastVerification`) is to LOWER conviction when
 * the verifier disagrees, so downstream sizing/approval logic sees more caution. Everything else
 * about the deterministic decision is preserved verbatim.
 */
export const FastVerifyOutputSchema = z.object({
  agree: z.boolean(),
  concern: z.string().max(600).nullable(),
  confidence: z.number().min(0).max(1),
});
export type FastVerifyOutput = z.infer<typeof FastVerifyOutputSchema>;

export interface FastVerifyInput {
  decision: FastBrainOutput;
  context: FastBrainInput;
  /** Why the situation was flagged unusual (from the router / fast brain). */
  reasonFlagged: string;
}

export const FAST_VERIFY_PROMPT_VERSION = "fast_verify.v1";
export const FAST_VERIFY_ROLE = "fast" as const;

export const FAST_VERIFY_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Sanity checker for a deterministic fast-brain decision in an unusual situation.",
  task: "Given the decision inputs and the chosen action with its probabilities, say whether the action is reasonable (agree) and, if not, the single most important concern. You are advisory: you cannot change the action.",
  outputRules: [
    "agree=false only when a specific input contradicts the action (e.g. stale data with a BUY, invalidated thesis with a HOLD).",
    "confidence reflects how sure you are of your own judgement, not of the trade.",
  ],
});

export async function fastVerify(input: FastVerifyInput, client: StructuredModelClient, opts: AgentOptions = {}): Promise<StructuredResult<FastVerifyOutput>> {
  const { scope: _scope, ...context } = input.context;
  const user = [
    renderJson("Reason flagged", { reasonFlagged: input.reasonFlagged }),
    renderJson("Fast brain inputs (deterministic)", context),
    renderJson("Fast brain decision (deterministic)", {
      action: input.decision.action,
      conviction: input.decision.conviction,
      probabilities: input.decision.probabilities,
      reasons: input.decision.reasons,
      modelVersion: input.decision.modelVersion,
    }),
  ].join("\n\n");
  return runAgent(client, {
    agent: "fast_verify",
    promptVersion: FAST_VERIFY_PROMPT_VERSION,
    role: FAST_VERIFY_ROLE,
    system: FAST_VERIFY_SYSTEM_PROMPT,
    user,
    schema: FastVerifyOutputSchema,
    defaultMaxTokens: 512,
  }, opts);
}

export interface VerifiedFastDecision {
  decision: FastBrainOutput;
  verification: StructuredResult<FastVerifyOutput> | null;
  /** True when conviction was lowered because the verifier disagreed. */
  convictionLowered: boolean;
  note: string;
}

/**
 * Applies a verification to a decision. Action, probabilities and reasons are never changed; only
 * `conviction` may be reduced (multiplied by 1 - confidence * 0.5, floored at 0) when the verifier
 * disagrees. A failed or missing verification leaves the decision untouched.
 */
export function applyFastVerification(decision: FastBrainOutput, verification: StructuredResult<FastVerifyOutput> | null): VerifiedFastDecision {
  if (!verification) return { decision, verification: null, convictionLowered: false, note: "no verification requested" };
  if (!verification.ok) return { decision, verification, convictionLowered: false, note: `verification unavailable (${verification.error}); deterministic decision unchanged` };
  if (verification.output.agree) return { decision, verification, convictionLowered: false, note: "verifier agrees; decision unchanged" };
  const factor = Math.max(0, 1 - verification.output.confidence * 0.5);
  const lowered = Math.min(decision.conviction, decision.conviction * factor);
  return {
    decision: { ...decision, conviction: lowered, reasons: [...decision.reasons, `fast_verify disagreed (advisory): ${verification.output.concern ?? "no concern given"}`] },
    verification,
    convictionLowered: lowered < decision.conviction,
    note: "verifier disagreed; conviction lowered, action unchanged",
  };
}
