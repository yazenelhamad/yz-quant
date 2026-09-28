import { VariantViewSchema } from "@yz/core";
import type { Catalyst, ConsensusModel, InternalForecast, Scenario, VariantView } from "@yz/core";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";
import { jsonData, runAnalyst, systemPrompt } from "./prompts.js";

export const PRE_MORTEM_PROMPT_VERSION = "vp-pre-mortem-1.0.0";

export const PreMortemSchema = VariantViewSchema.shape.preMortem.unwrap();
export type PreMortem = NonNullable<VariantView["preMortem"]>;

export interface PreMortemInput {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  forecast: InternalForecast;
  catalysts: Catalyst[];
  scenarios: Scenario[];
  timing: VariantView["timing"];
  expectedSurprise: VariantView["expectedSurprise"];
  pricedInScore: number;
  crowding: number | null;
  holdingPeriodDays: number;
}

export function buildPreMortemRequest(input: PreMortemInput): StructuredRequest<PreMortem> {
  const system = systemPrompt(
    "pre-mortem analyst",
    `Assume it is ${input.holdingPeriodDays} days from now and this trade has lost money. Write the most likely story of how that happened: what was misunderstood, which risk was ignored, which assumption was optimistic. Then answer the four structural questions honestly (already priced? weak catalyst? bad timing? crowded?) and give a verdict: proceed, reduce, wait or reject. The verdict must follow from the flags: a trade that is already priced with a weak catalyst does not get 'proceed'.`,
  );
  const user = [
    `Ticker: ${input.ticker}. Decision time: ${input.asOf}.`,
    jsonData("consensus_model", input.consensus, 0.9),
    jsonData("internal_forecast", input.forecast, 0.8),
    jsonData("catalysts", input.catalysts, 0.8),
    jsonData("scenarios", input.scenarios, 0.8),
    jsonData("timing_assessment", input.timing, 1),
    jsonData("expected_surprise", input.expectedSurprise, 1),
    jsonData("priced_in_and_crowding", { pricedInScore: input.pricedInScore, crowding: input.crowding }, 1),
  ].join("\n\n");
  return { agent: "variant_perception.pre_mortem", promptVersion: PRE_MORTEM_PROMPT_VERSION, role: "slow_brain", system, user, schema: PreMortemSchema, toolName: "emit_pre_mortem", maxTokens: 2000, temperature: 0.3 };
}

export function runPreMortemAnalyst(input: PreMortemInput, client: StructuredModelClient): Promise<StructuredResult<PreMortem>> {
  return runAnalyst(client, buildPreMortemRequest(input), PreMortemSchema);
}
