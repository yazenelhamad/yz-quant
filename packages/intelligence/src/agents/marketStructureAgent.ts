import { AgentVoteSchema } from "@yz/core";
import { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderJson, runAgent, type AgentOptions } from "./shared.js";

const note = z.string().max(300);

export const MarketStructureAgentOutputSchema = AgentVoteSchema.extend({
  vwap: note,
  supportResistance: note,
  breakoutStatus: z.enum(["none", "attempting", "confirmed", "failed", "unknown"]),
  relativeVolume: note,
  spreadLiquidity: note,
  executionConditions: z.enum(["good", "acceptable", "poor", "unknown"]),
});
export type MarketStructureAgentOutput = z.infer<typeof MarketStructureAgentOutputSchema>;

export interface MarketStructureAgentInput {
  symbol: string;
  /** Deterministic microstructure numbers: last, vwap, support/resistance levels, relative volume, spread bps, ADV, etc. */
  structure: Record<string, number | null>;
  marketSession?: "closed" | "pre" | "regular" | "post" | "overnight";
  asOf?: string;
}

export const MARKET_STRUCTURE_PROMPT_VERSION = "market_structure.v1";
export const MARKET_STRUCTURE_ROLE = "slow_brain" as const;

export const MARKET_STRUCTURE_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Market structure and execution-conditions analyst for one symbol.",
  task: "From the deterministic microstructure numbers, comment on price vs VWAP, support/resistance, breakout status, relative volume, spread/liquidity and overall execution conditions, and vote on whether structure supports entering now.",
  outputRules: [
    "agent must be 'market_structure'.",
    "executionConditions must be 'poor' when spread or liquidity numbers are missing or adverse.",
  ],
});

export async function marketStructureAgent(
  input: MarketStructureAgentInput,
  client: StructuredModelClient,
  opts: AgentOptions = {},
): Promise<StructuredResult<MarketStructureAgentOutput>> {
  const user = renderJson("Microstructure (deterministic)", {
    symbol: input.symbol,
    asOf: input.asOf ?? null,
    marketSession: input.marketSession ?? "unknown",
    structure: input.structure,
  });
  return runAgent(client, {
    agent: "market_structure",
    promptVersion: MARKET_STRUCTURE_PROMPT_VERSION,
    role: MARKET_STRUCTURE_ROLE,
    system: MARKET_STRUCTURE_SYSTEM_PROMPT,
    user,
    schema: MarketStructureAgentOutputSchema,
  }, opts);
}
