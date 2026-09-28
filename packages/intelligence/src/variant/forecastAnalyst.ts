import { z } from "zod";
import { CatalystSchema, InternalForecastSchema, describeFramework } from "@yz/core";
import type { Catalyst, CompanyIntelligenceProfile, ConsensusModel, DataEnvelope, InternalForecast, SectorFramework } from "@yz/core";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";
import { envelopesBlock, jsonData, runAnalyst, systemPrompt } from "./prompts.js";

export const FORECAST_PROMPT_VERSION = "vp-forecast-1.0.0";

export const ForecastAnalystOutputSchema = z.object({
  forecast: InternalForecastSchema,
  /** Catalysts the analyst identifies from the data. Dates must come from the data, never guessed. */
  catalysts: z.array(CatalystSchema).max(8),
});
export type ForecastAnalystOutput = z.infer<typeof ForecastAnalystOutputSchema>;

export interface ForecastAnalystInput {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  envelopes: DataEnvelope[];
  framework: SectorFramework;
  profile: CompanyIntelligenceProfile | null;
  /** Deterministic summary of prior theses ("what did we believe last time"). */
  priorThesesSummary: string;
  /** Catalysts already known from the calendar; the analyst may refine but must not drop them. */
  knownCatalysts: Catalyst[];
}

export function buildForecastRequest(input: ForecastAnalystInput): StructuredRequest<ForecastAnalystOutput> {
  const system = systemPrompt(
    "fundamental forecast analyst",
    "Produce an independent internal forecast for the company. Consensus is given as an input so you know what the market believes; your job is to say what is likely to happen and where you differ. Use the sector framework to decide which metrics matter. For every number, cite in `reasoning` which data block supports it; leave fields null when the data cannot support a number. `confidence` must reflect uncertainty honestly and `evidenceQuality` must reflect the tier of the sources actually used (filings and verified data high; journalism and social low). List the catalysts you can date from the data with your probability, potential impact and how much of each is already priced.",
    [describeFramework(input.framework)],
  );
  const user = [
    `Ticker: ${input.ticker}. Decision time: ${input.asOf}. Output forecast.ticker="${input.ticker}" and forecast.asOf="${input.asOf}".`,
    jsonData("consensus_model", input.consensus, 0.9),
    jsonData("known_catalysts", input.knownCatalysts, 0.9),
    jsonData("prior_theses", { summary: input.priorThesesSummary }, 1),
    input.profile ? jsonData("company_profile", input.profile, 0.8) : "(no company intelligence profile on file)",
    "External documents:",
    envelopesBlock(input.envelopes),
  ].join("\n\n");
  return { agent: "variant_perception.forecast", promptVersion: FORECAST_PROMPT_VERSION, role: "slow_brain", system, user, schema: ForecastAnalystOutputSchema, toolName: "emit_forecast", maxTokens: 4000, temperature: 0.2 };
}

export async function runForecastAnalyst(input: ForecastAnalystInput, client: StructuredModelClient): Promise<StructuredResult<ForecastAnalystOutput>> {
  const result = await runAnalyst(client, buildForecastRequest(input), ForecastAnalystOutputSchema);
  if (!result.ok) return result;
  const forecast: InternalForecast = { ...result.output.forecast, ticker: input.ticker, asOf: input.asOf };
  // Known calendar catalysts are never dropped by the analyst.
  const merged = [...result.output.catalysts];
  for (const k of input.knownCatalysts) {
    if (!merged.some((c) => c.kind === k.kind && c.expectedDate === k.expectedDate)) merged.push(k);
  }
  return { ...result, output: { forecast, catalysts: merged } };
}
