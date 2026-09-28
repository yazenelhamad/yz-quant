import type { FastifyInstance } from "fastify";
import type { EnsembleResult, PerformanceStats, StrategyIntelligenceProfile } from "@yz/core";
import { STRATEGY_LIBRARY } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { tradingService } from "../services/trading/index.js";
import { pctPointsToFraction } from "../lib/units.js";

export interface OpportunityView {
  candidateId: string;
  symbol: string;
  strategyKey: string;
  strategyName: string;
  expectedEdge: number;
  confidence: number;
  calibratedConfidence: number;
  /** FRACTION (0.03 = 3%). */
  potentialDownsidePct: number | null;
  /** FRACTION. */
  potentialUpsidePct: number | null;
  holdingPeriodDays: number;
  regimeFit: number;
  liquidityScore: number;
  catalyst: string | null;
  catalystAt: string | null;
  risk: { score: number; notes: string[] };
  portfolioFit: number | null;
  historicalSimilarity: unknown;
  strategyPerformance: PerformanceStats | null;
  variantScore: number | null;
  finalStatus: string;
  reasons: string[];
  createdAt: string;
  expiresAt: string;
  ensemble: { components: EnsembleResult["components"]; explanation: string[]; disagreement: number; uncertainty: number };
  mode: string | null;
  proposedQuantity: number | null;
}

const NAMES = new Map(STRATEGY_LIBRARY.map((s) => [s.descriptor.key, s.descriptor.name]));
const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/**
 * GET /api/accounts/:accountId/opportunities — shared candidates joined with THIS account's
 * evaluation (portfolio fit, size and final status are per account; other accounts are never read).
 */
export async function registerOpportunityRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/accounts/:accountId/opportunities", async (req) => {
    const { scope } = await ctx.guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const svc = tradingService(ctx);
    const now = svc.runtime.clock().toISOString();
    const candidates = await svc.store.freshCandidates(now, 200);
    const evaluations = new Map((await svc.store.evaluationsForCandidates(scope, candidates.map((c) => c.id))).map((e) => [e.candidateId, e]));
    const profiles = new Map<string, StrategyIntelligenceProfile | null>();
    const opportunities: OpportunityView[] = [];
    for (const c of candidates) {
      const ens = c.ensemble as EnsembleResult;
      const ev = evaluations.get(c.id);
      const detail = (ev?.detail && typeof ev.detail === "object" ? ev.detail : {}) as { reasons?: string[]; calibratedConfidence?: number; mode?: string; quantity?: number; risk?: { reasons?: string[] } };
      if (!profiles.has(c.strategyKey)) profiles.set(c.strategyKey, ((await svc.store.systemStrategyProfile(c.strategyKey))?.profile as StrategyIntelligenceProfile | undefined) ?? null);
      const profile = profiles.get(c.strategyKey) ?? null;
      const downsideFraction = pctPointsToFraction(c.expectedDownsidePct);
      // Heuristic 0..1 risk score: expected downside (5% => 0.5) plus half the ensemble uncertainty, capped.
      const riskScore = clamp01((downsideFraction ?? 0) * 10 * 0.5 + 0.5 * ens.uncertainty);
      const riskNotes = (detail.risk?.reasons ?? []).filter((r) => !r.startsWith("warning")).slice(0, 5);
      opportunities.push({
        candidateId: c.id, symbol: c.symbol, strategyKey: c.strategyKey, strategyName: NAMES.get(c.strategyKey) ?? c.strategyKey,
        expectedEdge: ens.expectedEdge, confidence: ens.confidence, calibratedConfidence: detail.calibratedConfidence ?? ens.confidence,
        potentialDownsidePct: downsideFraction, potentialUpsidePct: pctPointsToFraction(c.expectedUpsidePct), holdingPeriodDays: c.holdingPeriodDays, regimeFit: c.regimeFit, liquidityScore: c.liquidityScore,
        catalyst: c.catalyst, catalystAt: c.catalystAt, risk: { score: riskScore, notes: riskNotes }, portfolioFit: ev ? ev.portfolioFit : null, historicalSimilarity: c.historicalSimilarity,
        strategyPerformance: profile?.overall ?? null, variantScore: null, finalStatus: ev ? ev.finalStatus : "pending", reasons: detail.reasons ?? [], createdAt: c.createdAt, expiresAt: c.expiresAt,
        ensemble: { components: ens.components, explanation: ens.explanation, disagreement: ens.disagreement, uncertainty: ens.uncertainty }, mode: detail.mode ?? null, proposedQuantity: ev ? ev.proposedQuantity : null,
      });
    }
    opportunities.sort((a, b) => b.expectedEdge * b.calibratedConfidence - a.expectedEdge * a.calibratedConfidence);
    return { opportunities };
  });
}
