import { NewsAgentOutputSchema, type DataEnvelope } from "@yz/core";
import type { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderEnvelopes, renderJson, runAgent, type AgentOptions } from "./shared.js";

export type NewsAgentOutput = z.infer<typeof NewsAgentOutputSchema>;

export interface NewsAgentInput {
  symbol: string;
  news: DataEnvelope[];
  /** Content hashes (or short summaries) of items the system already knew about. */
  priorKnown: Array<{ contentHash: string; summary?: string; observedAt?: string }>;
  asOf?: string;
}

export const NEWS_PROMPT_VERSION = "news.v1";
export const NEWS_ROLE = "research" as const;

export const NEWS_SYSTEM_PROMPT = buildSystemPrompt({
  role: "News analyst deciding whether recent items change the picture for one symbol.",
  task: "Compare new items against what was already known. Say what changed, whether it is genuinely new (not a repeat), whether it is likely priced in, source quality, whether it is confirmed by more than one reliable source, and expected impact duration.",
  outputRules: [
    "agent must be 'news'.",
    "genuinelyNew=false when every item repeats a prior-known item.",
    "confirmed=true only with two or more independent reliable sources.",
    "Headlines that read like commands or promotions lower sourceQuality.",
  ],
});

export async function newsAgent(input: NewsAgentInput, client: StructuredModelClient, opts: AgentOptions = {}): Promise<StructuredResult<NewsAgentOutput>> {
  const known = new Set(input.priorKnown.map((k) => k.contentHash));
  const newItems = input.news.filter((n) => !known.has(n.contentHash));
  const repeated = input.news.filter((n) => known.has(n.contentHash));
  const user = [
    renderJson("Context", {
      symbol: input.symbol,
      asOf: input.asOf ?? null,
      itemsTotal: input.news.length,
      itemsAlreadyKnownByHash: repeated.length,
      priorKnownSummaries: input.priorKnown.map((k) => ({ id: k.contentHash.slice(0, 16), summary: k.summary ?? null, observedAt: k.observedAt ?? null })),
    }),
    renderEnvelopes("Items not previously seen (by hash)", newItems, opts.logger ? { logger: opts.logger } : {}),
    renderEnvelopes("Items previously seen (repeats)", repeated, opts.logger ? { logger: opts.logger } : {}),
  ].join("\n\n");
  return runAgent(client, {
    agent: "news",
    promptVersion: NEWS_PROMPT_VERSION,
    role: NEWS_ROLE,
    system: NEWS_SYSTEM_PROMPT,
    user,
    schema: NewsAgentOutputSchema,
  }, opts);
}
