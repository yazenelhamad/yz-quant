import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http/app.js";
import { tradingService } from "../services/trading/index.js";

/** GET /api/accounts/:accountId/decisions?limit= — risk decisions and fast-brain decisions for this account. */
export async function registerDecisionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/accounts/:accountId/decisions", async (req) => {
    const { scope } = await ctx.guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const q = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(500, Number(q.limit ?? 100) || 100));
    const svc = tradingService(ctx);
    const [decisions, evaluations] = await Promise.all([ctx.repos.riskDecisions.recent(scope, limit), ctx.repos.candidateEvaluations.recent(scope, limit)]);
    const candidateIds = evaluations.map((e) => e.candidateId);
    const candidates = new Map((await svc.store.freshCandidates(new Date(0).toISOString(), 1)).map((c) => [c.id, c]));
    for (const id of candidateIds) if (!candidates.has(id)) { const c = await svc.store.candidateById(id); if (c) candidates.set(id, c); }
    return {
      decisions: decisions.map((d) => ({ id: d.id, scope, candidateId: d.candidateId, tradeId: d.tradeId, symbol: d.symbol, action: d.action, verdict: d.verdict, approvedQuantity: d.approvedQuantity, approvedNotional: d.approvedNotional, requestedQuantity: d.requestedQuantity, checks: d.checks, reasons: d.reasons, riskEngineVersion: d.riskEngineVersion, decidedAt: d.decidedAt, failedClosed: d.failedClosed })),
      fastBrain: evaluations.filter((e) => e.fastBrain).map((e) => {
        const c = candidates.get(e.candidateId);
        const detail = (e.detail && typeof e.detail === "object" ? e.detail : {}) as { mode?: string };
        return { candidateId: e.candidateId, symbol: c?.symbol ?? null, strategyKey: c?.strategyKey ?? null, finalStatus: e.finalStatus, mode: detail.mode ?? null, portfolioFit: e.portfolioFit, sizeMultiplier: e.sizeMultiplier, proposedQuantity: e.proposedQuantity, riskDecisionId: e.riskDecisionId, decision: e.fastBrain, at: e.createdAt };
      }),
    };
  });
}
