import { z } from "zod";
import { secondOrderChecklist } from "@yz/core";
import type { Catalyst, ConsensusModel, InternalForecast, SectorFramework } from "@yz/core";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";
import { jsonData, runAnalyst, systemPrompt } from "./prompts.js";

export const SECOND_ORDER_PROMPT_VERSION = "vp-second-order-1.0.0";

export const SecondOrderOutputSchema = z.object({
  /** Each item: a second-order consequence and its implication for the trade. */
  considerations: z.array(z.string().max(400)).min(1).max(12),
  /** Checklist questions the analyst could not answer from the data. */
  unanswered: z.array(z.string().max(300)).max(12),
});
export type SecondOrderOutput = z.infer<typeof SecondOrderOutputSchema>;

export interface SecondOrderInput {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  forecast: InternalForecast;
  catalysts: Catalyst[];
  framework: SectorFramework;
}

export function buildSecondOrderRequest(input: SecondOrderInput): StructuredRequest<SecondOrderOutput> {
  const kinds = [...new Set(input.catalysts.map((c) => c.kind))];
  const checklist = [...new Set(kinds.flatMap((k) => secondOrderChecklist(k)))];
  const system = systemPrompt(
    "second-order reasoning analyst",
    "First-order thinking stops at 'good news, stock up'. Work through the second-order consequences of the expected catalysts and of our forecast: who must act, what reverses, what the event does to competitors, suppliers, customers, the multiple and positioning. Answer the checklist questions from the data where possible; list the ones you cannot answer instead of guessing.",
    [`Checklist:\n- ${checklist.join("\n- ")}`],
  );
  const user = [`Ticker: ${input.ticker}. Decision time: ${input.asOf}. Sector framework: ${input.framework.label}.`, jsonData("consensus_model", input.consensus, 0.9), jsonData("internal_forecast", input.forecast, 0.8), jsonData("catalysts", input.catalysts, 0.8)].join("\n\n");
  return { agent: "variant_perception.second_order", promptVersion: SECOND_ORDER_PROMPT_VERSION, role: "slow_brain", system, user, schema: SecondOrderOutputSchema, toolName: "emit_second_order", maxTokens: 2000, temperature: 0.3 };
}

export function runSecondOrderAnalyst(input: SecondOrderInput, client: StructuredModelClient): Promise<StructuredResult<SecondOrderOutput>> {
  return runAnalyst(client, buildSecondOrderRequest(input), SecondOrderOutputSchema);
}
