import {
  assertSameScope,
  type AgentName,
  type AgentVote,
  type DataEnvelope,
  type HistoricalAnalog,
  type ModelIntelligenceProfile,
  type RegimeAssessment,
  type TenantScope,
  type TradeCandidate,
} from "@yz/core";
import type { ModelRole, ModelUsage, StructuredModelClient, StructuredResult } from "../llm/contract.js";
import { MODELS_NOT_CONFIGURED_MESSAGE } from "../llm/notConfiguredClient.js";
import { routeTask, type RouteDecision, type TaskUrgency } from "../router/modelRouter.js";
import type { Budget } from "../router/budget.js";
import { summarizeSuspicion } from "../defense/envelope.js";
import { marketRegimeAgent } from "../agents/marketRegimeAgent.js";
import { quantAgent } from "../agents/quantAgent.js";
import { marketStructureAgent } from "../agents/marketStructureAgent.js";
import { fundamentalAgent } from "../agents/fundamentalAgent.js";
import { newsAgent } from "../agents/newsAgent.js";
import { PORTFOLIO_MANAGER_PROMPT_VERSION, portfolioManagerAgent, type PortfolioAssessmentInput, type ScopedPortfolioManagerOutput } from "../agents/portfolioManagerAgent.js";
import { devilsAdvocateAgent, type DevilsAdvocateOutput } from "../agents/devilsAdvocateAgent.js";
import { thesisWriter, type ThesisDraft, type ThesisNumbers } from "../agents/thesisWriter.js";
import type { AgentLogger, AgentOptions } from "../agents/shared.js";

/**
 * INVESTMENT COMMITTEE — orchestrates the slow-brain agents for one candidate.
 *
 * - Shared agents (regime, quant, structure, fundamental, news, devil's advocate) run ONCE.
 * - The portfolio manager runs once PER tenant scope with only that scope's assessment.
 * - Outputs are advisory: votes, a devil's advocate verdict, thesis text. Nothing here reaches a
 *   broker, and the deterministic engines decide regardless of what this returns.
 * - When the model client is not configured, it returns votes=[] and the warning
 *   "AI models not configured" so deterministic engines carry on.
 */
export type ScopeKey = `${string}:${string}`;

export function scopeKey(scope: TenantScope): ScopeKey {
  return `${scope.userId}:${scope.brokerAccountId}`;
}

export function parseScopeKey(key: string): TenantScope {
  const idx = key.indexOf(":");
  if (idx <= 0 || idx === key.length - 1) throw new Error(`Invalid scope key "${key}"`);
  return { userId: key.slice(0, idx), brokerAccountId: key.slice(idx + 1) };
}

export interface CommitteeInput {
  symbol: string;
  candidate: TradeCandidate;
  regime: RegimeAssessment;
  features: Record<string, number | null>;
  structure?: Record<string, number | null>;
  envelopes: {
    news: DataEnvelope[];
    fundamentals: DataEnvelope[];
    filings: DataEnvelope[];
    macro?: DataEnvelope[];
    financials?: DataEnvelope[];
    analystRatings?: DataEnvelope[];
  };
  /** Keyed by scopeKey(scope). The assessment's own scope must match the key. */
  portfolioAssessmentsByScope: Record<string, PortfolioAssessmentInput>;
  /** Deterministic thesis numbers per scope (size differs per account). Thesis text is only written for scopes present here. */
  thesisNumbersByScope?: Record<string, ThesisNumbers>;
  priorAnalogs: HistoricalAnalog[];
  strategyPerfInRegime: { trades: number; winRate: number | null; expectancyPct: number | null; profitFactor: number | null } | null;
  agentWeights: Partial<Record<AgentName, number>>;
  enabledAgents: AgentName[];
  priorKnownNews?: Array<{ contentHash: string; summary?: string; observedAt?: string }>;
  daysToNextEvent?: number | null;
  urgency?: TaskUrgency;
  modelProfiles?: ModelIntelligenceProfile[];
}

export interface WeightedVote extends AgentVote {
  weight: number;
}

export interface ModelOutputLogEntry {
  agent: string;
  scopeKey?: ScopeKey;
  modelName: string | null;
  modelVersion: string | null;
  promptVersion: string;
  valid: boolean;
  error?: string;
  /** The provider's or validator's own message for a failed call (diagnostics; never shown to the model). */
  message?: string;
  latencyMs: number | null;
  usage: ModelUsage | null;
}

export interface CommitteeResult {
  configured: boolean;
  votes: WeightedVote[];
  devilsAdvocate: DevilsAdvocateOutput | null;
  portfolioByScope: Record<string, ScopedPortfolioManagerOutput | null>;
  thesisTextByScope: Record<string, ThesisDraft | null>;
  /** Weighted dispersion of votes in [0, 1]. */
  disagreement: number;
  /** Weighted mean vote in [-1, 1]. */
  consensusScore: number;
  unknownCount: number;
  warnings: string[];
  modelOutputsLog: ModelOutputLogEntry[];
  route: RouteDecision;
}

export interface CommitteeDeps {
  client: StructuredModelClient;
  budget?: Budget;
  logger?: AgentLogger;
  agentOptions?: AgentOptions;
}

const VOTE_SCORE: Record<AgentVote["vote"], number | null> = { strong_buy: 1, buy: 0.5, neutral: 0, reduce: -0.5, sell: -1, abstain: null };

export const NOT_CONFIGURED_WARNING = "AI models not configured";

export async function runCommittee(input: CommitteeInput, deps: CommitteeDeps): Promise<CommitteeResult> {
  const { client, budget, logger } = deps;
  const warnings: string[] = [];
  const log: ModelOutputLogEntry[] = [];
  const empty = (route: RouteDecision): CommitteeResult => ({
    configured: client.configured,
    votes: [],
    devilsAdvocate: null,
    portfolioByScope: Object.fromEntries(Object.keys(input.portfolioAssessmentsByScope).map((k) => [k, null])),
    thesisTextByScope: Object.fromEntries(Object.keys(input.thesisNumbersByScope ?? {}).map((k) => [k, null])),
    disagreement: 0,
    consensusScore: 0,
    unknownCount: 0,
    warnings,
    modelOutputsLog: log,
    route,
  });

  // Scope integrity first: a mismatched assessment is a bug upstream and must not run.
  for (const [key, assessment] of Object.entries(input.portfolioAssessmentsByScope)) {
    assertSameScope(parseScopeKey(key), assessment.scope, `runCommittee portfolioAssessmentsByScope[${key}]`);
  }
  for (const key of Object.keys(input.thesisNumbersByScope ?? {})) parseScopeKey(key);

  const route = routeTask(
    { kind: "thesis", urgency: input.urgency ?? "normal", ...(input.modelProfiles ? { modelProfiles: input.modelProfiles } : {}) },
    budget ? { budget } : {},
  );

  if (!client.configured) {
    warnings.push(NOT_CONFIGURED_WARNING, MODELS_NOT_CONFIGURED_MESSAGE);
    return empty(route);
  }
  if (route.handler !== "llm") {
    warnings.push(`committee skipped: ${route.reason}`);
    return empty(route);
  }
  if (route.degraded) warnings.push(`model routing degraded: ${route.reason}`);

  const suspicion = summarizeSuspicion([
    ...input.envelopes.news,
    ...input.envelopes.fundamentals,
    ...input.envelopes.filings,
    ...(input.envelopes.macro ?? []),
    ...(input.envelopes.financials ?? []),
    ...(input.envelopes.analystRatings ?? []),
  ]);
  if (suspicion.suspiciousCount > 0) {
    warnings.push(`${suspicion.suspiciousCount} external item(s) contain instruction-like text (${suspicion.flags.join(", ")}); treated as data`);
  }

  const enabled = new Set<AgentName>(input.enabledAgents);
  const opts: AgentOptions = { ...(deps.agentOptions ?? {}), ...(logger ? { logger } : {}), ...(route.role ? { role: route.role } : {}) };
  const weight = (agent: AgentName): number => Math.max(0, input.agentWeights[agent] ?? 1);
  const votes: WeightedVote[] = [];

  const record = <T>(agent: string, promptVersion: string, result: StructuredResult<T>, key?: ScopeKey): T | null => {
    budget?.record(result.usage?.costUsd ?? null);
    log.push({
      agent,
      ...(key ? { scopeKey: key } : {}),
      modelName: result.modelName,
      modelVersion: result.ok ? result.modelVersion : null,
      promptVersion,
      valid: result.ok,
      ...(result.ok ? {} : { error: result.error, message: result.message }),
      latencyMs: result.usage?.latencyMs ?? null,
      usage: result.usage,
    });
    if (!result.ok) {
      warnings.push(`${agent}${key ? `[${key}]` : ""}: ${result.error} — ${result.message}`);
      return null;
    }
    return result.output;
  };

  const c = input.candidate;
  const ens = c.ensemble;

  // ---- Shared agents: run ONCE ----
  const shared = await Promise.all([
    enabled.has("market_regime")
      ? marketRegimeAgent({ regime: input.regime, macro: input.envelopes.macro ?? [] }, client, opts).then((r) => record("market_regime", "market_regime.v1", r))
      : null,
    enabled.has("quant")
      ? quantAgent({ symbol: input.symbol, regime: input.regime.primary, features: input.features, asOf: ens.asOf }, client, opts).then((r) => record("quant", "quant.v1", r))
      : null,
    enabled.has("market_structure")
      ? marketStructureAgent({ symbol: input.symbol, structure: input.structure ?? {}, asOf: ens.asOf }, client, opts).then((r) => record("market_structure", "market_structure.v1", r))
      : null,
    enabled.has("fundamental")
      ? fundamentalAgent(
          { symbol: input.symbol, fundamentals: input.envelopes.fundamentals, financials: input.envelopes.financials ?? [], analystRatings: input.envelopes.analystRatings ?? [], filings: input.envelopes.filings },
          client,
          opts,
        ).then((r) => record("fundamental", "fundamental.v1", r))
      : null,
    enabled.has("news")
      ? newsAgent({ symbol: input.symbol, news: input.envelopes.news, priorKnown: input.priorKnownNews ?? [], asOf: ens.asOf }, client, opts).then((r) => record("news", "news.v1", r))
      : null,
  ]);
  const agentNames: AgentName[] = ["market_regime", "quant", "market_structure", "fundamental", "news"];
  shared.forEach((output, i) => {
    const name = agentNames[i]!;
    if (output) votes.push({ ...(output as AgentVote), agent: name, weight: weight(name) });
  });

  // ---- Devil's advocate: sees the votes ----
  let devilsAdvocate: DevilsAdvocateOutput | null = null;
  if (enabled.has("devils_advocate")) {
    const result = await devilsAdvocateAgent(
      {
        symbol: input.symbol,
        candidate: {
          direction: c.direction,
          strategyKey: c.strategyKey,
          expectedEdge: ens.expectedEdge,
          confidence: ens.confidence,
          disagreement: ens.disagreement,
          uncertainty: ens.uncertainty,
          expectedUpsidePct: c.expectedUpsidePct,
          expectedDownsidePct: c.expectedDownsidePct,
          holdingPeriodDays: c.holdingPeriodDays,
          catalyst: c.catalyst,
          catalystAt: c.catalystAt,
          regime: ens.regime,
          regimeFit: c.regimeFit,
        },
        votes,
        priorAnalogs: input.priorAnalogs,
        strategyPerfInRegime: input.strategyPerfInRegime,
        evidence: [...input.envelopes.news, ...input.envelopes.filings],
        daysToNextEvent: input.daysToNextEvent ?? null,
      },
      client,
      opts,
    );
    devilsAdvocate = record("devils_advocate", "devils_advocate.v1", result);
  }

  // ---- Portfolio manager: once PER scope, with that scope's data only ----
  const portfolioByScope: Record<string, ScopedPortfolioManagerOutput | null> = {};
  if (enabled.has("portfolio_manager")) {
    await Promise.all(
      Object.entries(input.portfolioAssessmentsByScope).map(async ([key, assessment]) => {
        const scope = parseScopeKey(key);
        const result = await portfolioManagerAgent(
          {
            scope,
            symbol: input.symbol,
            candidate: { direction: c.direction, expectedEdge: ens.expectedEdge, confidence: ens.confidence, expectedUpsidePct: c.expectedUpsidePct, expectedDownsidePct: c.expectedDownsidePct, holdingPeriodDays: c.holdingPeriodDays, strategyKey: c.strategyKey },
            assessment,
          },
          client,
          opts,
        );
        const output = record("portfolio_manager", PORTFOLIO_MANAGER_PROMPT_VERSION, result, key as ScopeKey);
        if (output) assertSameScope(scope, output.scope, `runCommittee portfolio_manager output[${key}]`);
        portfolioByScope[key] = output;
      }),
    );
  } else {
    for (const key of Object.keys(input.portfolioAssessmentsByScope)) portfolioByScope[key] = null;
  }

  // ---- Thesis text per scope ----
  const thesisTextByScope: Record<string, ThesisDraft | null> = {};
  const evidence = [...input.envelopes.news, ...input.envelopes.filings, ...input.envelopes.fundamentals];
  await Promise.all(
    Object.entries(input.thesisNumbersByScope ?? {}).map(async ([key, numbers]) => {
      const result = await thesisWriter({ numbers, votes, devilsAdvocate, evidence, ensembleExplanation: ens.explanation }, client, opts);
      thesisTextByScope[key] = record("thesis_writer", "thesis_writer.v1", result, key as ScopeKey);
    }),
  );

  const { disagreement, consensusScore } = voteStatistics(votes);
  const unknownCount = votes.filter((v) => v.unknown).length;

  return {
    configured: true,
    votes,
    devilsAdvocate,
    portfolioByScope,
    thesisTextByScope,
    disagreement,
    consensusScore,
    unknownCount,
    warnings,
    modelOutputsLog: log,
    route,
  };
}

/** Weighted mean and dispersion of non-abstaining votes. Dispersion is the weighted std dev, max 1. */
export function voteStatistics(votes: ReadonlyArray<WeightedVote>): { disagreement: number; consensusScore: number } {
  const scored = votes.map((v) => ({ score: VOTE_SCORE[v.vote], weight: v.weight })).filter((v): v is { score: number; weight: number } => v.score !== null && v.weight > 0);
  const totalWeight = scored.reduce((s, v) => s + v.weight, 0);
  if (totalWeight === 0) return { disagreement: 0, consensusScore: 0 };
  const mean = scored.reduce((s, v) => s + v.score * v.weight, 0) / totalWeight;
  const variance = scored.reduce((s, v) => s + v.weight * (v.score - mean) ** 2, 0) / totalWeight;
  return { disagreement: Math.min(1, Math.sqrt(variance)), consensusScore: mean };
}

export type { ModelRole };
