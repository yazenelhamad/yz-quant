import { AgentVoteSchema, type RegimeLabel } from "@yz/core";
import { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderJson, runAgent, type AgentOptions } from "./shared.js";

const note = z.string().max(300);

export const QuantAgentOutputSchema = AgentVoteSchema.extend({
  momentum: note,
  meanReversion: note,
  relativeStrength: note,
  volatility: note,
  breadth: note,
  correlation: note,
  anomaly: note,
});
export type QuantAgentOutput = z.infer<typeof QuantAgentOutputSchema>;

export interface QuantAgentInput {
  symbol: string;
  regime: RegimeLabel | string;
  /** Feature record from the deterministic feature engine (numbers only). */
  features: Record<string, number | null>;
  featureVersion?: string;
  asOf?: string;
}

export const QUANT_PROMPT_VERSION = "quant.v1";
export const QUANT_ROLE = "slow_brain" as const;

export const QUANT_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Quantitative analyst interpreting a feature vector for one symbol.",
  task: "Read the deterministic features and give a vote plus one short note per dimension: momentum, meanReversion, relativeStrength, volatility, breadth, correlation, anomaly. Notes describe what the numbers say; do not restate them all.",
  outputRules: [
    "agent must be 'quant'.",
    "Use only the numbers provided. A missing (null) feature means unknown, not zero.",
    "anomaly: state whether any feature is outside its usual range and what that implies.",
  ],
});

export async function quantAgent(input: QuantAgentInput, client: StructuredModelClient, opts: AgentOptions = {}): Promise<StructuredResult<QuantAgentOutput>> {
  const user = renderJson("Symbol features (deterministic)", {
    symbol: input.symbol,
    regime: input.regime,
    asOf: input.asOf ?? null,
    featureVersion: input.featureVersion ?? null,
    features: input.features,
  });
  return runAgent(client, {
    agent: "quant",
    promptVersion: QUANT_PROMPT_VERSION,
    role: QUANT_ROLE,
    system: QUANT_SYSTEM_PROMPT,
    user,
    schema: QuantAgentOutputSchema,
  }, opts);
}
