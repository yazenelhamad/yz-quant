import type { AgentName } from "@yz/core";
import type { ModelRole } from "../llm/contract.js";
import { MARKET_REGIME_PROMPT_VERSION, MARKET_REGIME_ROLE } from "../agents/marketRegimeAgent.js";
import { QUANT_PROMPT_VERSION, QUANT_ROLE } from "../agents/quantAgent.js";
import { MARKET_STRUCTURE_PROMPT_VERSION, MARKET_STRUCTURE_ROLE } from "../agents/marketStructureAgent.js";
import { FUNDAMENTAL_PROMPT_VERSION, FUNDAMENTAL_ROLE } from "../agents/fundamentalAgent.js";
import { NEWS_PROMPT_VERSION, NEWS_ROLE } from "../agents/newsAgent.js";
import { PORTFOLIO_MANAGER_PROMPT_VERSION, PORTFOLIO_MANAGER_ROLE } from "../agents/portfolioManagerAgent.js";
import { EXECUTION_PROMPT_VERSION, EXECUTION_ROLE } from "../agents/executionAgent.js";
import { DEVILS_ADVOCATE_PROMPT_VERSION, DEVILS_ADVOCATE_ROLE } from "../agents/devilsAdvocateAgent.js";
import { RESEARCH_PROMPT_VERSION, RESEARCH_ROLE } from "../agents/researchAgent.js";
import { THESIS_WRITER_PROMPT_VERSION, THESIS_WRITER_ROLE } from "../agents/thesisWriter.js";
import { POST_TRADE_NARRATOR_PROMPT_VERSION, POST_TRADE_NARRATOR_ROLE } from "../agents/postTradeNarrator.js";
import { FAST_VERIFY_PROMPT_VERSION, FAST_VERIFY_ROLE } from "../fastVerify/fastVerify.js";

export type PromptAgentName = AgentName | "thesis_writer" | "post_trade_narrator" | "fast_verify";

export interface PromptRegistryEntry {
  agent: PromptAgentName;
  promptVersion: string;
  role: ModelRole;
}

/** Central registry so the API can store the prompt version and model role on every decision. */
export const PROMPT_REGISTRY: ReadonlyArray<PromptRegistryEntry> = Object.freeze([
  { agent: "market_regime", promptVersion: MARKET_REGIME_PROMPT_VERSION, role: MARKET_REGIME_ROLE },
  { agent: "quant", promptVersion: QUANT_PROMPT_VERSION, role: QUANT_ROLE },
  { agent: "market_structure", promptVersion: MARKET_STRUCTURE_PROMPT_VERSION, role: MARKET_STRUCTURE_ROLE },
  { agent: "fundamental", promptVersion: FUNDAMENTAL_PROMPT_VERSION, role: FUNDAMENTAL_ROLE },
  { agent: "news", promptVersion: NEWS_PROMPT_VERSION, role: NEWS_ROLE },
  { agent: "portfolio_manager", promptVersion: PORTFOLIO_MANAGER_PROMPT_VERSION, role: PORTFOLIO_MANAGER_ROLE },
  { agent: "execution", promptVersion: EXECUTION_PROMPT_VERSION, role: EXECUTION_ROLE },
  { agent: "devils_advocate", promptVersion: DEVILS_ADVOCATE_PROMPT_VERSION, role: DEVILS_ADVOCATE_ROLE },
  { agent: "research", promptVersion: RESEARCH_PROMPT_VERSION, role: RESEARCH_ROLE },
  { agent: "thesis_writer", promptVersion: THESIS_WRITER_PROMPT_VERSION, role: THESIS_WRITER_ROLE },
  { agent: "post_trade_narrator", promptVersion: POST_TRADE_NARRATOR_PROMPT_VERSION, role: POST_TRADE_NARRATOR_ROLE },
  { agent: "fast_verify", promptVersion: FAST_VERIFY_PROMPT_VERSION, role: FAST_VERIFY_ROLE },
]);

export function listPromptVersions(): PromptRegistryEntry[] {
  return PROMPT_REGISTRY.map((e) => ({ ...e }));
}

export function promptVersionFor(agent: PromptAgentName): PromptRegistryEntry | null {
  return PROMPT_REGISTRY.find((e) => e.agent === agent) ?? null;
}
