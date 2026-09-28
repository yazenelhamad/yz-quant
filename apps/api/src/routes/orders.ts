import type { FastifyInstance } from "fastify";
import { TERMINAL_ORDER_STATES, type BrokerOrderState } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { conflict, notFound, unavailable } from "../http/errors.js";
import { coreServices } from "../services/registry.js";
import { orderView } from "../services/pipeline/views.js";

export async function registerOrderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards, audit } = ctx;

  /** Every broker action recorded for this account (platform-placed and external), newest first, raw payloads stripped. */
  app.get("/api/accounts/:accountId/orders", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const raw = Number((req.query as { limit?: string }).limit ?? 100);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(500, Math.floor(raw)) : 100;
    const rows = await repos.orders.recent(scope, limit);
    return { orders: rows.map(orderView) };
  });

  /** Human-initiated cancel. Goes through the account's own adapter; audited whether or not the broker accepts it. */
  app.post("/api/accounts/:accountId/orders/:orderId/cancel", async (req) => {
    const params = req.params as { accountId: string; orderId: string };
    const { scope, account } = await guards.resolveScope(req, params.accountId, "write");
    const order = await repos.orders.byId(scope, params.orderId);
    if (!order) throw notFound("Order not found");
    if (TERMINAL_ORDER_STATES.has(order.state as BrokerOrderState)) throw conflict(`Order is already ${order.state}`);
    if (!order.brokerOrderId) throw conflict("Order has no broker id yet; it cannot be cancelled until the broker acknowledges it");
    const external = !!(order.raw && typeof order.raw === "object" && (order.raw as { external?: unknown }).external === true);
    const { broker } = coreServices(ctx);
    const adapter = await broker.adapterFor(scope);
    if (!adapter || (account.kind === "robinhood_agentic" && account.status !== "connected")) {
      await audit.record({ category: "order", action: "cancel_refused", result: "rejected", brokerAccountId: scope.brokerAccountId, orderId: order.id, error: "broker not connected", detail: { symbol: order.symbol, external } }, req);
      throw unavailable("Broker is not connected; the order cannot be cancelled from here");
    }
    const now = new Date().toISOString();
    try {
      const { accepted } = await adapter.cancelOrder(order.brokerOrderId);
      await repos.orders.update(scope, order.id, { cancelRequestedAt: now, ...(accepted ? { state: order.state === "partially_filled" ? order.state : "pending_cancelled" } : {}) });
      await audit.record({ category: "order", action: "cancel_requested", result: accepted ? "ok" : "rejected", brokerAccountId: scope.brokerAccountId, orderId: order.id, tradeId: order.tradeId, detail: { symbol: order.symbol, brokerOrderId: order.brokerOrderId, accepted, external, previousState: order.state } }, req);
      return { accepted, orderId: order.id, external };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repos.orders.update(scope, order.id, { cancelRequestedAt: now, error: message.slice(0, 300) });
      await audit.record({ category: "order", action: "cancel_failed", result: "error", brokerAccountId: scope.brokerAccountId, orderId: order.id, tradeId: order.tradeId, error: message, detail: { symbol: order.symbol, external } }, req);
      throw unavailable(`Cancel request failed: ${message}`);
    }
  });
}
