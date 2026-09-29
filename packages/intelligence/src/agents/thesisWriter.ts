import { EvidenceSchema, type AgentVote, type DataEnvelope } from "@yz/core";
import { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import type { DevilsAdvocateOutput } from "./devilsAdvocateAgent.js";
import { buildSystemPrompt, renderEnvelopes, renderJson, runAgent, type AgentOptions } from "./shared.js";

/**
 * Text fields of a TradeThesis. Partial on purpose: numbers (edge, confidence, size, prices)
 * are never produced by the model. They are passed in and copied verbatim into the draft.
 */
export const ThesisTextSchema = z.object({
  entryLogic: z.string().max(2000),
  plainEnglish: z.string().max(2000),
  supportingEvidence: z.array(EvidenceSchema).max(12),
  contradictingEvidence: z.array(EvidenceSchema).max(12),
  invalidationPoint: z.string().max(600),
  exitConditions: z.array(z.string().max(300)).max(8),
  unknown: z.boolean(),
});
export type ThesisText = z.infer<typeof ThesisTextSchema>;

/** Deterministic numbers the thesis is built around. Copied, never invented. */
export interface ThesisNumbers {
  symbol: string;
  strategyKey: string;
  direction: "long" | "reduce" | "exit";
  marketRegime: string;
  expectedEdge: number;
  confidence: number;
  calibratedConfidence: number;
  expectedUpsidePct: number;
  expectedDownsidePct: number;
  expectedHoldingPeriodDays: number;
  proposedQuantity: number;
  proposedNotional: number;
  invalidationPrice: number | null;
  targetPrice: number | null;
  maxAcceptableLossPct: number;
  referencePrice: number | null;
  catalyst: string | null;
  catalystAt: string | null;
}

export interface ThesisWriterInput {
  numbers: ThesisNumbers;
  votes: AgentVote[];
  devilsAdvocate: DevilsAdvocateOutput | null;
  evidence: DataEnvelope[];
  ensembleExplanation: string[];
}

export interface ThesisDraft {
  text: ThesisText;
  /** Verbatim copy of the input numbers. */
  numbers: ThesisNumbers;
}

export const THESIS_WRITER_PROMPT_VERSION = "thesis_writer.v1";
export const THESIS_WRITER_ROLE = "slow_brain" as const;

export const THESIS_WRITER_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Thesis writer producing the written justification of a trade for the journal and the human reviewer.",
  task: "Write entryLogic (why now, in terms of the strategy and evidence), plainEnglish (what we expect and what would prove us wrong, readable by a non-quant), list supporting and contradicting evidence with sources, and state the invalidation point and exit conditions.",
  outputRules: [
    "Reference the deterministic numbers exactly as given; never change, round differently or add numbers that were not provided.",
    "Every evidence item must cite a source that appears in the inputs (a data block source, an agent name or 'internal').",
    "Contradicting evidence must include the devil's advocate findings when present.",
    "unknown=true when the evidence blocks are empty or unreliable.",
  ],
});

export async function thesisWriter(input: ThesisWriterInput, client: StructuredModelClient, opts: AgentOptions = {}): Promise<StructuredResult<ThesisDraft>> {
  const user = [
    renderJson("Deterministic numbers (copy exactly, do not alter)", input.numbers),
    renderJson("Ensemble explanation", input.ensembleExplanation),
    renderJson("Committee votes", input.votes.map((v) => ({ agent: v.agent, vote: v.vote, confidence: v.confidence, unknown: v.unknown, keyPoints: v.keyPoints, risks: v.risks }))),
    renderJson("Devil's advocate", input.devilsAdvocate),
    renderEnvelopes("Evidence", input.evidence, opts.logger ? { logger: opts.logger } : {}),
  ].join("\n\n");
  const result = await runAgent(client, {
    agent: "thesis_writer",
    promptVersion: THESIS_WRITER_PROMPT_VERSION,
    role: THESIS_WRITER_ROLE,
    system: THESIS_WRITER_SYSTEM_PROMPT,
    user,
    schema: ThesisTextSchema,
    defaultMaxTokens: 8000,
  }, opts);
  if (!result.ok) return result;
  // Numbers come from the deterministic input only; the model's text cannot override them.
  return { ...result, output: { text: result.output, numbers: structuredClone(input.numbers) } };
}
