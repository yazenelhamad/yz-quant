import { ExecutionAgentOutputSchema } from "@yz/core";
import type { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderJson, runAgent, type AgentOptions } from "./shared.js";

export type ExecutionAgentOutput = z.infer<typeof ExecutionAgentOutputSchema>;

export interface ExecutionAgentInput {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  quantity: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  adv: number | null;
  relativeVolume: number | null;
  realizedVolPct: number | null;
  marketSession: "closed" | "pre" | "regular" | "post" | "overnight";
  urgencyHint: "low" | "normal" | "high";
  minutesToClose: number | null;
}

export const EXECUTION_PROMPT_VERSION = "execution.v1";
export const EXECUTION_ROLE = "fast" as const;

export const EXECUTION_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Execution specialist recommending how (not whether) an already-approved order should be worked.",
  task: "Recommend order type, limit offset, urgency, optional staging and expected slippage from the deterministic liquidity numbers.",
  outputRules: [
    "Prefer limit orders when spread is wide or volume is thin; market only when spread is tight and urgency is high.",
    "Staging (slices) when the order is a large fraction of ADV; null otherwise.",
    "limitOffsetBps is relative to the near touch; keep it within +/-50 for liquid names.",
    "The deterministic execution engine may override you; you cannot send orders.",
  ],
});

export async function executionAgent(input: ExecutionAgentInput, client: StructuredModelClient, opts: AgentOptions = {}): Promise<StructuredResult<ExecutionAgentOutput>> {
  const user = renderJson("Order and liquidity context (deterministic)", input);
  return runAgent(client, {
    agent: "execution",
    promptVersion: EXECUTION_PROMPT_VERSION,
    role: EXECUTION_ROLE,
    system: EXECUTION_SYSTEM_PROMPT,
    user,
    schema: ExecutionAgentOutputSchema,
    defaultMaxTokens: 1024,
  }, opts);
}
