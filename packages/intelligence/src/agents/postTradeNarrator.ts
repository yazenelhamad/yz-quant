import type { PostTradeReview } from "@yz/core";
import { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderJson, runAgent, type AgentOptions } from "./shared.js";

export const PostTradeNarrativeSchema = z.object({
  narrative: z.string().max(2000),
  keyTakeaways: z.array(z.string().max(300)).max(6),
  unknown: z.boolean(),
});
export type PostTradeNarrative = z.infer<typeof PostTradeNarrativeSchema>;

/** Deterministic review fields (everything except the narrative, which this agent writes). */
export type PostTradeNarratorInput = Omit<PostTradeReview, "narrative"> & { lessons?: string[] };

export interface PostTradeNarration extends PostTradeNarrative {
  /** Copied from the deterministic review; the model cannot reclassify. */
  classification: PostTradeReview["classification"];
  tradeId: string;
}

export const POST_TRADE_NARRATOR_PROMPT_VERSION = "post_trade_narrator.v1";
export const POST_TRADE_NARRATOR_ROLE = "research" as const;

export const POST_TRADE_NARRATOR_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Post-trade reviewer writing the plain-English narrative of a closed trade.",
  task: "Explain, for a human reader, what happened and why the deterministic review classified the outcome as it did (good/bad win, good loss, bad thesis/timing/execution, oversized, unexpected event, model/data error, regime change). Then list key takeaways.",
  outputRules: [
    "Do not dispute or change the classification or any number; explain them.",
    "Distinguish process from outcome: a profitable trade can be a bad process and vice versa.",
    "unknown=true when the review has too many null fields to explain.",
  ],
});

export async function postTradeNarrator(
  input: PostTradeNarratorInput,
  client: StructuredModelClient,
  opts: AgentOptions = {},
): Promise<StructuredResult<PostTradeNarration>> {
  const { scope: _scope, ...review } = input;
  const user = renderJson("Post-trade review (deterministic)", review);
  const result = await runAgent(client, {
    agent: "post_trade_narrator",
    promptVersion: POST_TRADE_NARRATOR_PROMPT_VERSION,
    role: POST_TRADE_NARRATOR_ROLE,
    system: POST_TRADE_NARRATOR_SYSTEM_PROMPT,
    user,
    schema: PostTradeNarrativeSchema,
  }, opts);
  if (!result.ok) return result;
  return { ...result, output: { ...result.output, classification: input.classification, tradeId: input.tradeId } };
}
