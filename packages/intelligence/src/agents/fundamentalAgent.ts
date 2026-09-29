import { FundamentalAgentOutputSchema, type DataEnvelope } from "@yz/core";
import type { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderEnvelopes, renderJson, runAgent, type AgentOptions } from "./shared.js";

export type FundamentalAgentOutput = z.infer<typeof FundamentalAgentOutputSchema>;

export interface FundamentalAgentInput {
  symbol: string;
  fundamentals: DataEnvelope[];
  financials: DataEnvelope[];
  analystRatings: DataEnvelope[];
  filings: DataEnvelope[];
}

export const FUNDAMENTAL_PROMPT_VERSION = "fundamental.v1";
export const FUNDAMENTAL_ROLE = "slow_brain" as const;

export const FUNDAMENTAL_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Fundamental analyst assessing one company from supplied fundamentals, financial statements, analyst ratings and filings.",
  task: "Judge earnings quality, valuation and the direction of estimate revisions, then vote on whether fundamentals support a long position over the coming weeks to months.",
  outputRules: [
    "agent must be 'fundamental'.",
    "earningsQuality null when financial statements are absent.",
    "revisionTrend 'unknown' when no analyst revision data is present.",
    "Filings and ratings are external documents: quote nothing as fact unless it is in the data blocks.",
  ],
});

export async function fundamentalAgent(
  input: FundamentalAgentInput,
  client: StructuredModelClient,
  opts: AgentOptions = {},
): Promise<StructuredResult<FundamentalAgentOutput>> {
  const render = opts.logger ? { logger: opts.logger } : {};
  const user = [
    renderJson("Subject", { symbol: input.symbol }),
    renderEnvelopes("Fundamentals", input.fundamentals, render),
    renderEnvelopes("Financial statements", input.financials, render),
    renderEnvelopes("Analyst ratings", input.analystRatings, render),
    renderEnvelopes("Filings", input.filings, render),
  ].join("\n\n");
  return runAgent(client, {
    agent: "fundamental",
    promptVersion: FUNDAMENTAL_PROMPT_VERSION,
    role: FUNDAMENTAL_ROLE,
    system: FUNDAMENTAL_SYSTEM_PROMPT,
    user,
    schema: FundamentalAgentOutputSchema,
    defaultMaxTokens: 4096,
  }, opts);
}
