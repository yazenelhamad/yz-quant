import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { conflict, forbidden, unavailable, validation } from "../http/errors.js";
import { tradingService } from "../services/trading/index.js";

const CloseSchema = z.object({ reason: z.string().min(1).max(300) });
const SYMBOL_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

/**
 * POST /api/accounts/:accountId/positions/:symbol/close {reason} — human-initiated exit through the
 * risk engine's "exit" path and the execution engine. 503 when the broker is not connected, 409 when
 * there is nothing sellable. Owner only (an admin cannot trade another user's account).
 */
export async function registerPositionsCloseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/api/accounts/:accountId/positions/:symbol/close", async (req) => {
    const params = req.params as { accountId: string; symbol: string };
    const { user } = ctx.guards.requireAuth(req);
    const { scope, account } = await ctx.guards.resolveScope(req, params.accountId, "write");
    if (account.userId !== user.id) throw forbidden("Only the account owner can close positions");
    if (!SYMBOL_RE.test(params.symbol)) throw validation("Invalid symbol");
    const body = CloseSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    const svc = tradingService(ctx);
    const result = await svc.closePosition(scope, params.symbol.toUpperCase(), body.data.reason, user.id);
    await ctx.audit.record({ category: "order", action: "manual_close_requested", result: result.ok ? "ok" : "rejected", brokerAccountId: scope.brokerAccountId, detail: { symbol: params.symbol.toUpperCase(), reason: body.data.reason, outcome: result.ok ? { tradeId: result.tradeId, orderId: result.orderId } : result.reason } }, req);
    if (!result.ok) {
      if (result.code === "broker_not_connected") throw unavailable(`Broker not connected: ${result.reason}`);
      throw conflict(result.reason);
    }
    return { tradeId: result.tradeId, orderId: result.orderId, quantity: result.quantity };
  });
}
