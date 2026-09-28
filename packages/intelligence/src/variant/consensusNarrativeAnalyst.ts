import { z } from "zod";
import { describeFramework } from "@yz/core";
import type { ConsensusModel, DataEnvelope, SectorFramework } from "@yz/core";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";
import { envelopesBlock, findEnvelope, jsonData, runAnalyst, systemPrompt } from "./prompts.js";

export const CONSENSUS_NARRATIVE_PROMPT_VERSION = "vp-consensus-narrative-1.0.0";

export const ConsensusNarrativeOutputSchema = z.object({
  /** What analysts and the sell side formally expect. */
  consensusNarrative: z.string().max(800),
  /** The story the market is actually trading on right now (may differ from the formal consensus). */
  currentMarketNarrative: z.string().max(800),
  expectedCatalyst: z.string().max(300).nullable(),
  /** Narrative label and sentiment per document, keyed by the document id (contentHash). */
  tags: z.array(z.object({ id: z.string(), narratives: z.array(z.string().max(80)).max(5), sentiment: z.number().min(-1).max(1).nullable() })).max(60),
  /** Whether the market narrative is consistent with the formal consensus numbers. */
  narrativeVsNumbers: z.enum(["consistent", "narrative_ahead", "narrative_behind", "unknown"]),
  notes: z.array(z.string().max(300)).max(10),
});
export type ConsensusNarrativeOutput = z.infer<typeof ConsensusNarrativeOutputSchema>;

export interface ConsensusNarrativeInput {
  ticker: string;
  asOf: string;
  consensus: ConsensusModel;
  envelopes: DataEnvelope[];
  framework: SectorFramework;
}

export function buildConsensusNarrativeRequest(input: ConsensusNarrativeInput): StructuredRequest<ConsensusNarrativeOutput> {
  const system = systemPrompt(
    "consensus and narrative analyst",
    "Describe, without adopting, what the market believes: the formal consensus narrative (numbers, guidance, sell-side framing) and the dominant narrative actually being traded. Tag every external document with the narrative labels it supports (short, reusable labels such as 'AI capex beneficiary' or 'margin compression') and a sentiment towards the company from -1 to 1 (null when the document has no view). Use each document's id attribute as the tag id. Do not evaluate whether the narrative is right; that is another analyst's job.",
    [describeFramework(input.framework)],
  );
  const user = [`Ticker: ${input.ticker}. Decision time: ${input.asOf}.`, jsonData("consensus_model", input.consensus, 0.9), "External documents:", envelopesBlock(input.envelopes)].join("\n\n");
  return { agent: "variant_perception.consensus_narrative", promptVersion: CONSENSUS_NARRATIVE_PROMPT_VERSION, role: "slow_brain", system, user, schema: ConsensusNarrativeOutputSchema, toolName: "emit_narrative", maxTokens: 3000, temperature: 0.1 };
}

export async function runConsensusNarrativeAnalyst(input: ConsensusNarrativeInput, client: StructuredModelClient): Promise<StructuredResult<ConsensusNarrativeOutput>> {
  const result = await runAnalyst(client, buildConsensusNarrativeRequest(input), ConsensusNarrativeOutputSchema);
  if (!result.ok) return result;
  // Only tags that refer to a supplied document are kept: no invented sources.
  const tags = result.output.tags.flatMap((t) => {
    const env = findEnvelope(input.envelopes, t.id);
    return env ? [{ ...t, id: env.contentHash }] : [];
  });
  return { ...result, output: { ...result.output, tags } };
}
