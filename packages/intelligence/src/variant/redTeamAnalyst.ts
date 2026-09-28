import { VariantViewSchema } from "@yz/core";
import type { Catalyst, ConsensusModel, DataEnvelope, Evidence, InternalForecast, Scenario, VariantView } from "@yz/core";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";
import { envelopesBlock, jsonData, runAnalyst, systemPrompt } from "./prompts.js";

export const RED_TEAM_PROMPT_VERSION = "vp-red-team-1.0.0";

export const RedTeamSchema = VariantViewSchema.shape.redTeam.unwrap();
export type RedTeam = NonNullable<VariantView["redTeam"]>;

export interface RedTeamInput {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  forecast: InternalForecast;
  catalysts: Catalyst[];
  scenarios: Scenario[];
  evidence: Evidence[];
  sourceDisagreements: VariantView["sourceDisagreements"];
  envelopes: DataEnvelope[];
  impliedExpectations: VariantView["impliedExpectations"];
  timing: VariantView["timing"];
  crowding: number | null;
}

export function buildRedTeamRequest(input: RedTeamInput): StructuredRequest<RedTeam> {
  const system = systemPrompt(
    "red team",
    "Attack the internal forecast and the trade built on it. Your job is to find legitimate flaws, not to disagree for its own sake: every item must point at specific evidence, a specific assumption or a specific structural weakness (valuation, timing, crowding, hidden exposure, catalyst structure, data quality). If the thesis survives an honest attack, say so and keep `severity` low. `severity` (0..1) is your judgement of how badly the flaws you found damage the trade: 0.2 = cosmetic, 0.5 = size down, 0.8 = do not proceed. `legitimateFlaws` lists only the flaws you would defend in front of the investment committee.",
  );
  const user = [
    `Ticker: ${input.ticker}. Decision time: ${input.asOf}.`,
    jsonData("consensus_model", input.consensus, 0.9),
    jsonData("internal_forecast", input.forecast, 0.8),
    jsonData("catalysts", input.catalysts, 0.8),
    jsonData("scenarios", input.scenarios, 0.8),
    jsonData("evidence", input.evidence, 0.9),
    jsonData("source_disagreements", input.sourceDisagreements, 1),
    jsonData("reverse_dcf", input.impliedExpectations, 1),
    jsonData("timing_and_crowding", { timing: input.timing, crowding: input.crowding }, 1),
    "External documents:",
    envelopesBlock(input.envelopes, 25, 1800),
  ].join("\n\n");
  return { agent: "variant_perception.red_team", promptVersion: RED_TEAM_PROMPT_VERSION, role: "slow_brain", system, user, schema: RedTeamSchema, toolName: "emit_red_team", maxTokens: 3000, temperature: 0.3 };
}

export function runRedTeamAnalyst(input: RedTeamInput, client: StructuredModelClient): Promise<StructuredResult<RedTeam>> {
  return runAnalyst(client, buildRedTeamRequest(input), RedTeamSchema);
}
