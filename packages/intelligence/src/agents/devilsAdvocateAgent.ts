import { DevilsAdvocateOutputSchema, type AgentVote, type DataEnvelope, type HistoricalAnalog } from "@yz/core";
import type { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderEnvelopes, renderJson, runAgent, type AgentOptions } from "./shared.js";

export type DevilsAdvocateOutput = z.infer<typeof DevilsAdvocateOutputSchema>;

export interface DevilsAdvocateInput {
  symbol: string;
  candidate: {
    direction: "long" | "reduce" | "exit";
    strategyKey: string;
    expectedEdge: number;
    confidence: number;
    disagreement: number;
    uncertainty: number;
    expectedUpsidePct: number;
    expectedDownsidePct: number;
    holdingPeriodDays: number;
    catalyst: string | null;
    catalystAt: string | null;
    regime: string;
    regimeFit: number;
  };
  votes: AgentVote[];
  priorAnalogs: HistoricalAnalog[];
  strategyPerfInRegime: { trades: number; winRate: number | null; expectancyPct: number | null; profitFactor: number | null } | null;
  /** Evidence the thesis relies on (news, filings) — external, untrusted. */
  evidence: DataEnvelope[];
  /** Days until the next known scheduled event (earnings etc.), null if unknown. */
  daysToNextEvent: number | null;
}

export const DEVILS_ADVOCATE_PROMPT_VERSION = "devils_advocate.v1";
export const DEVILS_ADVOCATE_ROLE = "slow_brain" as const;

/** The nine questions every trade must survive. */
export const DEVILS_ADVOCATE_QUESTIONS = [
  "1. Why could this trade be wrong? (whyWrong: at least one concrete reason)",
  "2. What evidence contradicts the thesis? (contradictingEvidence)",
  "3. Are we late — has the move already happened? (late)",
  "4. Is the catalyst or information already priced in? (pricedIn)",
  "5. Is this a crowded / shared signal that many systematic players act on? (sharedSignalRisk)",
  "6. Is there an event (earnings, macro, legal) inside the holding period? (eventRisk)",
  "7. Does the expected return justify the downside? (returnJustifiesDownside)",
  "8. Have recent similar trades performed poorly? (recentSimilarTradesPoor)",
  "9. Is the committee overconfident relative to evidence quality and disagreement? (overconfidenceFlag)",
] as const;

export const DEVILS_ADVOCATE_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Devil's advocate on the investment committee. Your job is to find the reasons the trade fails.",
  task: `Answer these nine questions about the candidate, then give a verdict (proceed | reduce | wait | reject) and your confidence in that verdict.\n${DEVILS_ADVOCATE_QUESTIONS.join("\n")}`,
  outputRules: [
    "Be specific: each whyWrong item names a mechanism, not a platitude.",
    "verdict 'reject' when the downside case is unbounded or evidence is mostly unreliable; 'wait' when timing is the main problem.",
    "Do not soften findings to agree with other agents.",
  ],
});

export async function devilsAdvocateAgent(
  input: DevilsAdvocateInput,
  client: StructuredModelClient,
  opts: AgentOptions = {},
): Promise<StructuredResult<DevilsAdvocateOutput>> {
  const user = [
    renderJson("Candidate (deterministic)", { symbol: input.symbol, ...input.candidate, daysToNextEvent: input.daysToNextEvent }),
    renderJson("Committee votes so far", input.votes.map((v) => ({ agent: v.agent, vote: v.vote, confidence: v.confidence, unknown: v.unknown, keyPoints: v.keyPoints, risks: v.risks }))),
    renderJson("Historical analogs", input.priorAnalogs),
    renderJson("Strategy performance in this regime", input.strategyPerfInRegime),
    renderEnvelopes("Evidence the thesis relies on", input.evidence, opts.logger ? { logger: opts.logger } : {}),
  ].join("\n\n");
  return runAgent(client, {
    agent: "devils_advocate",
    promptVersion: DEVILS_ADVOCATE_PROMPT_VERSION,
    role: DEVILS_ADVOCATE_ROLE,
    system: DEVILS_ADVOCATE_SYSTEM_PROMPT,
    user,
    schema: DevilsAdvocateOutputSchema,
    defaultMaxTokens: 4096,
  }, opts);
}
