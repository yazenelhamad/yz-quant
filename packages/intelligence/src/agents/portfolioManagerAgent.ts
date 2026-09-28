import { PortfolioManagerOutputSchema, assertSameScope, assertScope, type TenantScope } from "@yz/core";
import type { z } from "zod";
import type { StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { buildSystemPrompt, renderJson, runAgent, type AgentOptions } from "./shared.js";

export type PortfolioManagerOutput = z.infer<typeof PortfolioManagerOutputSchema>;

/**
 * The deterministic portfolio engine's numbers for ONE user's account. Core does not define a
 * PortfolioAssessment type yet, so the intelligence package declares the input shape it consumes.
 * Every field is a number the engine computed; the agent interprets, it never recomputes.
 */
export interface PortfolioAssessmentInput {
  scope: TenantScope;
  asOf: string;
  totalValue: number;
  cash: number;
  buyingPower: number;
  positionCount: number;
  currentSymbolPct: number;
  positionPctAfter: number;
  sectorPctAfter: number;
  sector: string | null;
  correlationToPortfolio: number | null;
  betaAfter: number | null;
  drawdownPct: number;
  riskCapacity: number;
  fitScore: number;
  concentrationTop5Pct: number | null;
  notes: string[];
  /** The account's survival mandate ("earn or die"), computed deterministically from its realised record. */
  mandate?: {
    mode: "thriving" | "earning" | "probation" | "survival" | "hibernation";
    fitnessScore: number;
    riskMultiplier: number;
    minEdgeMultiplier: number;
    hurdleBps: number;
    runwayDays: number | null;
    allowLiveEntries: boolean;
    summary: string;
  };
}

export interface PortfolioManagerAgentInput {
  /** The scope this run is for. Must equal assessment.scope; enforced. */
  scope: TenantScope;
  symbol: string;
  candidate: { direction: "long" | "reduce" | "exit"; expectedEdge: number; confidence: number; expectedUpsidePct: number; expectedDownsidePct: number; holdingPeriodDays: number; strategyKey: string };
  assessment: PortfolioAssessmentInput;
}

/** Output stamped with the tenant scope it was produced for. */
export type ScopedPortfolioManagerOutput = PortfolioManagerOutput & { scope: TenantScope };

export const PORTFOLIO_MANAGER_PROMPT_VERSION = "portfolio_manager.v2";
export const PORTFOLIO_MANAGER_ROLE = "slow_brain" as const;

export const PORTFOLIO_MANAGER_SYSTEM_PROMPT = buildSystemPrompt({
  role: "Portfolio manager for ONE separately managed account, reviewing how a candidate fits that account.",
  task: "Given the deterministic portfolio engine's numbers for this account only, judge fit, suggest a size multiplier (0..1) and list concerns and positives. Verdict 'reject' when the trade materially worsens concentration, correlation or drawdown risk.",
  outputRules: [
    "sizeMultiplier is a fraction of the deterministic proposed size; it can only shrink size, never enlarge it.",
    "fitScore in [-1, 1] should be consistent with the engine's fitScore unless you explain why.",
    "Judge only this account. You have no information about any other account and must not assume any.",
    "SURVIVAL MANDATE: this desk exists to compound capital; activity is not progress. When a mandate is supplied, treat it as binding context: in 'survival' or 'hibernation' the account is losing money, so verdict 'reject' unless the trade is exceptional and clears the stated net-of-cost hurdle with room to spare; in 'probation' prefer smaller size and fewer, better trades; never argue for more size than the deterministic engines proposed.",
    "Ask of every trade: does it pay for its own costs, and is it the best use of scarce risk budget right now? A merely plausible trade is a 'reduce' or 'reject', not a 'proceed'.",
  ],
});

/**
 * Runs once per user scope. It refuses to run when the assessment belongs to another scope
 * (throws CrossTenantError) and stamps the validated output with the scope.
 */
export async function portfolioManagerAgent(
  input: PortfolioManagerAgentInput,
  client: StructuredModelClient,
  opts: AgentOptions = {},
): Promise<StructuredResult<ScopedPortfolioManagerOutput>> {
  assertScope(input.scope, "portfolioManagerAgent");
  assertScope(input.assessment.scope, "portfolioManagerAgent.assessment");
  assertSameScope(input.scope, input.assessment.scope, "portfolioManagerAgent");
  const { scope: _omit, ...assessment } = input.assessment;
  const user = [
    renderJson("Candidate (deterministic)", { symbol: input.symbol, ...input.candidate }),
    renderJson("This account's portfolio assessment (deterministic)", assessment),
  ].join("\n\n");
  const result = await runAgent(client, {
    agent: "portfolio_manager",
    promptVersion: PORTFOLIO_MANAGER_PROMPT_VERSION,
    role: PORTFOLIO_MANAGER_ROLE,
    system: PORTFOLIO_MANAGER_SYSTEM_PROMPT,
    user,
    schema: PortfolioManagerOutputSchema,
  }, opts);
  if (!result.ok) return result;
  return { ...result, output: { ...result.output, scope: { userId: input.scope.userId, brokerAccountId: input.scope.brokerAccountId } } };
}
