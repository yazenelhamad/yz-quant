import type { DataEnvelope } from "@yz/core";
import { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderEnvelopes, renderJson, runAgent, type AgentOptions } from "./shared.js";

/**
 * Research proposals: hypotheses and experiment designs only. The schema deliberately has no
 * symbol/side/quantity/price fields — research output cannot describe, let alone trigger, an order.
 */
export const ResearchProposalSchema = z.object({
  title: z.string().max(120),
  hypothesis: z.string().max(800),
  kind: z.enum(["signal", "strategy_variant", "risk_rule", "execution_rule", "data_source", "calibration"]),
  design: z.string().max(1200),
  expectedEvidence: z.string().max(600),
  risks: z.array(z.string().max(300)).max(8),
});
export type ResearchProposal = z.infer<typeof ResearchProposalSchema>;

export const ResearchAgentOutputSchema = z.object({
  proposals: z.array(ResearchProposalSchema).max(5),
  unknown: z.boolean(),
  confidence: z.number().min(0).max(1),
  notes: z.array(z.string().max(300)).max(8),
});
export type ResearchAgentOutput = z.infer<typeof ResearchAgentOutputSchema>;

export interface ResearchAgentInput {
  /** Deterministic observations (e.g. strategy degradation notes, calibration errors, missed opportunities). */
  observations: string[];
  /** Summaries of strategy / signal profiles as plain records. */
  profiles: Record<string, unknown>;
  /** Optional external material (papers, articles) — untrusted. */
  material: DataEnvelope[];
  focus?: string;
}

export const RESEARCH_PROMPT_VERSION = "research.v1";
export const RESEARCH_ROLE = "research" as const;

export const RESEARCH_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Research lead proposing testable hypotheses for the strategy research pipeline.",
  task: "From the observations and profiles, propose up to five hypotheses with an experiment design (data, method, out-of-sample plan), the evidence that would confirm or refute each, and risks (overfitting, look-ahead, regime dependence).",
  outputRules: [
    "Proposals are experiments, never trade instructions: no tickers to buy, no sizes, no prices.",
    "Every design must state how it avoids look-ahead bias and what out-of-sample test decides it.",
    "Set unknown=true when the observations are too thin to ground a hypothesis.",
  ],
});

export async function researchAgent(input: ResearchAgentInput, client: StructuredModelClient, opts: AgentOptions = {}): Promise<StructuredResult<ResearchAgentOutput>> {
  const user = [
    renderJson("Focus", { focus: input.focus ?? null }),
    renderJson("Observations (deterministic)", input.observations),
    renderJson("Profiles (deterministic)", input.profiles),
    renderEnvelopes("External material", input.material, opts.logger ? { logger: opts.logger } : {}),
  ].join("\n\n");
  return runAgent(client, {
    agent: "research",
    promptVersion: RESEARCH_PROMPT_VERSION,
    role: RESEARCH_ROLE,
    system: RESEARCH_SYSTEM_PROMPT,
    user,
    schema: ResearchAgentOutputSchema,
    defaultMaxTokens: 4000,
  }, opts);
}
