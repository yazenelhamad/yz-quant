import { z } from "zod";
import { ScenarioSchema, describeFramework } from "@yz/core";
import type { Catalyst, ConsensusModel, InternalForecast, Scenario, SectorFramework } from "@yz/core";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";
import { jsonData, runAnalyst, systemPrompt } from "./prompts.js";

export const SCENARIO_PROMPT_VERSION = "vp-scenarios-1.0.0";

export const ScenarioAnalystOutputSchema = z.object({
  scenarios: z.array(ScenarioSchema).length(3),
  notes: z.array(z.string().max(300)).max(8),
});
export type ScenarioAnalystOutput = z.infer<typeof ScenarioAnalystOutputSchema>;

export interface ScenarioAnalystInput {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  forecast: InternalForecast;
  catalysts: Catalyst[];
  framework: SectorFramework;
  holdingPeriodDays: number;
  impliedExpectations?: { impliedGrowthPct: number | null; impliedMarginPct: number | null; comparedToInternal: string } | null;
}

export function buildScenarioRequest(input: ScenarioAnalystInput): StructuredRequest<ScenarioAnalystOutput> {
  const system = systemPrompt(
    "scenario analyst",
    `Build bull, base and bear scenarios for the next ${input.holdingPeriodDays} days. Each scenario needs explicit key assumptions, the fundamental outcome, the valuation it implies and the price impact in percent from today's price. Probabilities must be honest and sum to approximately 1; the base case is not automatically the most likely, and a bear case is not a tail event — it should be a scenario you would not be surprised by. Anchor price impacts to what is priced in: a bull case that only confirms consensus has a small price impact.`,
    [describeFramework(input.framework)],
  );
  const user = [
    `Ticker: ${input.ticker}. Decision time: ${input.asOf}.`,
    jsonData("consensus_model", input.consensus, 0.9),
    jsonData("internal_forecast", input.forecast, 0.8),
    jsonData("catalysts", input.catalysts, 0.8),
    input.impliedExpectations ? jsonData("reverse_dcf", input.impliedExpectations, 0.9) : "(reverse DCF not available)",
  ].join("\n\n");
  return { agent: "variant_perception.scenarios", promptVersion: SCENARIO_PROMPT_VERSION, role: "slow_brain", system, user, schema: ScenarioAnalystOutputSchema, toolName: "emit_scenarios", maxTokens: 3000, temperature: 0.2 };
}

/** Normalise probabilities to sum to 1 when they are within tolerance; reject otherwise (no silent repair). */
export function normaliseScenarios(scenarios: Scenario[], tolerance = 0.1): Scenario[] | null {
  const names = new Set(scenarios.map((s) => s.name));
  if (names.size !== 3) return null;
  const sum = scenarios.reduce((s, x) => s + x.probability, 0);
  if (sum <= 0 || Math.abs(sum - 1) > tolerance) return null;
  return scenarios.map((s) => ({ ...s, probability: Math.round((s.probability / sum) * 1000) / 1000 }));
}

export async function runScenarioAnalyst(input: ScenarioAnalystInput, client: StructuredModelClient): Promise<StructuredResult<ScenarioAnalystOutput>> {
  const result = await runAnalyst(client, buildScenarioRequest(input), ScenarioAnalystOutputSchema);
  if (!result.ok) return result;
  const normalised = normaliseScenarios(result.output.scenarios);
  if (!normalised) {
    return { ok: false, error: "validation_failed", message: "variant_perception.scenarios: scenarios must be one each of bull/base/bear with probabilities summing to ≈1", modelName: result.modelName, usage: result.usage, raw: result.raw };
  }
  return { ...result, output: { ...result.output, scenarios: normalised } };
}
