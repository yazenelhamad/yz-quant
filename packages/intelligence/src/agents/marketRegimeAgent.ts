import { MarketRegimeAgentOutputSchema, type DataEnvelope, type RegimeAssessment } from "@yz/core";
import type { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderEnvelopes, renderJson, runAgent, type AgentOptions } from "./shared.js";

export type MarketRegimeAgentOutput = z.infer<typeof MarketRegimeAgentOutputSchema>;

export interface MarketRegimeAgentInput {
  regime: RegimeAssessment;
  /** Recent macro / market data items (untrusted external content). */
  macro: DataEnvelope[];
}

export const MARKET_REGIME_PROMPT_VERSION = "market_regime.v1";
export const MARKET_REGIME_ROLE = "slow_brain" as const;

export const MARKET_REGIME_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Market regime analyst on the investment committee of a small systematic fund.",
  task: "Assess the current market regime from the deterministic regime engine's metrics and the supplied macro data. Report regime probabilities, whether behaviour is abnormal, which strategy families are favoured/disfavoured, and whether historical analogs remain relevant.",
  outputRules: [
    "agent must be 'market_regime'.",
    "regimes probabilities should sum to about 1.",
    "vote expresses risk appetite for new long exposure in this regime (neutral when the regime is unclear).",
    "dataFreshness must reflect the regime engine's dataQuality and the age of the macro data.",
  ],
});

export async function marketRegimeAgent(
  input: MarketRegimeAgentInput,
  client: StructuredModelClient,
  opts: AgentOptions = {},
): Promise<StructuredResult<MarketRegimeAgentOutput>> {
  const user = [
    renderJson("Regime engine assessment (deterministic)", {
      asOf: input.regime.asOf,
      primary: input.regime.primary,
      probabilities: input.regime.probabilities,
      confidence: input.regime.confidence,
      abnormality: input.regime.abnormality,
      metrics: input.regime.metrics,
      familyBias: input.regime.familyBias,
      dataQuality: input.regime.dataQuality,
      explanation: input.regime.explanation,
    }),
    renderEnvelopes("Recent macro data", input.macro, opts.logger ? { logger: opts.logger } : {}),
  ].join("\n\n");
  return runAgent(client, {
    agent: "market_regime",
    promptVersion: MARKET_REGIME_PROMPT_VERSION,
    role: MARKET_REGIME_ROLE,
    system: MARKET_REGIME_SYSTEM_PROMPT,
    user,
    schema: MarketRegimeAgentOutputSchema,
  }, opts);
}
