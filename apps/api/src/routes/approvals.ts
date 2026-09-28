import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { conflict, forbidden, notFound, validation } from "../http/errors.js";
import { tradingService } from "../services/trading/index.js";

const DecideSchema = z.object({ decision: z.enum(["approve", "decline"]) });

/**
 * GET  /api/accounts/:accountId/approvals            — pending (and recently decided) approval requests
 * POST /api/accounts/:accountId/approvals/:approvalId — {decision: approve|decline}; owner only, audited
 */
export async function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/accounts/:accountId/approvals", async (req) => {
    const { scope } = await ctx.guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const svc = tradingService(ctx);
    const rows = await svc.store.approvalsRecent(scope, 100);
    const now = svc.runtime.clock().getTime();
    return {
      approvals: rows.map((a) => ({
        id: a.id, tradeId: a.tradeId, thesisId: a.thesisId, symbol: a.symbol, action: a.action, quantity: a.quantity, notional: a.notional, summary: a.summary,
        status: a.status === "pending" && Date.parse(a.expiresAt) < now ? "expired" : a.status, decidedBy: a.decidedBy, decidedAt: a.decidedAt, expiresAt: a.expiresAt, createdAt: a.createdAt,
      })),
    };
  });

  app.post("/api/accounts/:accountId/approvals/:approvalId", async (req) => {
    const params = req.params as { accountId: string; approvalId: string };
    const { user } = ctx.guards.requireAuth(req);
    const { scope, account } = await ctx.guards.resolveScope(req, params.accountId, "write");
    if (account.userId !== user.id) throw forbidden("Only the account owner can decide approvals");
    const body = DecideSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    const svc = tradingService(ctx);
    const approval = await ctx.repos.approvals.byId(scope, params.approvalId);
    if (!approval) throw notFound("Approval not found");
    const result = await svc.decideApproval(scope, params.approvalId, body.data.decision, user.id);
    await ctx.audit.record({ category: "order", action: `approval_${body.data.decision}_requested`, result: result.ok ? "ok" : "rejected", brokerAccountId: scope.brokerAccountId, tradeId: approval.tradeId, detail: { approvalId: params.approvalId, outcome: result.ok ? result.status : result.reason } }, req);
    if (!result.ok) throw conflict(result.reason);
    return { ok: true, status: result.status, tradeId: result.trade.id, orderId: result.order?.id ?? null, reason: result.reason };
  });
}
