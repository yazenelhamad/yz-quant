import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http/app.js";
import { conflict, unavailable } from "../http/errors.js";
import { coreServices } from "../services/registry.js";
import { maskAccountNumber, redactSecrets } from "../security/secrets.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function page(title: string, body: string, redirectTo: string | null): string {
  const refresh = redirectTo ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(redirectTo)}">` : "";
  const script = redirectTo ? `<script>setTimeout(function(){window.location.replace(${JSON.stringify(redirectTo)});},800);</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${refresh}<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:32rem;padding:2rem;border:1px solid #30363d;border-radius:12px;background:#111821}a{color:#58a6ff}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;line-height:1.5}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main>${script}</body></html>`;
}

export const OAUTH_CALLBACK_PATH = "/api/broker/oauth/callback";

export async function registerBrokerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { guards, audit, env } = ctx;
  const settingsUrl = (params: string) => `${env.APP_ORIGIN}/settings?${params}`;

  app.get("/api/accounts/:accountId/broker/status", async (req) => {
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const { broker } = coreServices(ctx);
    let s = await broker.status(scope);
    if (s.status === "connecting" && s.tools) {
      // The client reports "connecting" until its first data call; a successful authenticated tools/list proves the connection.
      s = { ...s, status: "connected", detail: `connected (${s.tools.length} tools advertised; no data call yet)` };
    }
    return { ...s, kind: account.kind, agenticAccountNumberMasked: account.agenticAllowed ? maskAccountNumber(account.accountNumber) : null, agenticAllowed: account.agenticAllowed, simulated: account.kind === "simulated" };
  });

  app.post("/api/accounts/:accountId/broker/connect", async (req) => {
    guards.requireStepUp(req);
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    if (account.kind !== "robinhood_agentic") throw conflict("Only Robinhood Agentic accounts can be connected; simulated accounts need no connection");
    const { broker } = coreServices(ctx);
    try {
      const { authorizationUrl } = await broker.beginConnect(scope, `${env.API_ORIGIN}${OAUTH_CALLBACK_PATH}`);
      return { authorizationUrl };
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      await audit.record({ category: "broker", action: "connect_start_failed", result: "error", brokerAccountId: scope.brokerAccountId, error: message }, req);
      throw unavailable(`Could not start the Robinhood authorization: ${message}`);
    }
  });

  /**
   * Browser redirect back from robinhood.com. The session cookie is SameSite=Strict, so it is NOT
   * sent on this cross-site navigation: the flow completes purely on the server-side `state`,
   * which was bound to (user, account) when the connection started and is single-use.
   */
  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    reply.type("text/html; charset=utf-8");
    reply.header("cache-control", "no-store");
    const state = typeof q.state === "string" ? q.state : "";
    if (q.error) {
      const msg = redactSecrets(`${q.error}${q.error_description ? `: ${q.error_description}` : ""}`).slice(0, 300);
      await audit.record({ category: "broker", action: "connect_denied", result: "rejected", error: msg, detail: { statePresent: state.length > 0 } }, req);
      return reply.status(400).send(page("Robinhood connection was not completed", `<p>Robinhood reported: ${escapeHtml(msg)}</p><p><a href="${escapeHtml(settingsUrl("connected=0"))}">Back to settings</a></p>`, null));
    }
    if (!state || typeof q.code !== "string" || q.code.length === 0) {
      await audit.record({ category: "broker", action: "connect_callback_invalid", result: "rejected", error: "missing code or state" }, req);
      return reply.status(400).send(page("Invalid authorization callback", `<p>The callback did not carry an authorization code and state. Start the connection again from settings.</p><p><a href="${escapeHtml(settingsUrl("connected=0"))}">Back to settings</a></p>`, null));
    }
    const { broker } = coreServices(ctx);
    try {
      const { scope, accountNumberMasked } = await broker.completeConnect(state, q.code);
      await audit.record({ category: "broker", action: "connect_callback_completed", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { accountNumber: accountNumberMasked } }, req);
      const to = settingsUrl(`connected=1&account=${encodeURIComponent(scope.brokerAccountId)}`);
      return reply.status(200).send(page("Robinhood connected", `<p>Agentic account ${escapeHtml(accountNumberMasked)} is now connected. Returning to the dashboard&hellip;</p><p><a href="${escapeHtml(to)}">Continue</a></p>`, to));
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
      await audit.record({ category: "broker", action: "connect_callback_failed", result: "error", error: message, detail: { statePresent: true } }, req);
      return reply.status(400).send(page("Robinhood connection failed", `<p>${escapeHtml(message)}</p><p><a href="${escapeHtml(settingsUrl("connected=0"))}">Back to settings</a></p>`, null));
    }
  });

  app.post("/api/accounts/:accountId/broker/disconnect", async (req) => {
    const { user } = guards.requireStepUp(req);
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    if (account.kind !== "robinhood_agentic") throw conflict("Simulated accounts have no broker connection to remove");
    const { broker } = coreServices(ctx);
    await broker.disconnect(scope, user.id);
    return { ok: true };
  });

  app.post("/api/accounts/:accountId/broker/sync", async (req) => {
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    const { broker } = coreServices(ctx);
    const r = await broker.sync(scope);
    await audit.record({ category: "broker", action: "sync_requested", result: r.ok ? "ok" : "error", brokerAccountId: scope.brokerAccountId, error: r.error, detail: { status: r.status, positions: r.positions, orders: r.orders, fills: r.fills, reconciliationOk: r.reconciliation?.ok ?? null } }, req);
    if (!r.ok) throw unavailable(r.status === "not_connected" ? `${account.kind === "simulated" ? "Simulated account" : "Robinhood"}: not connected` : `Sync failed: ${r.detail}`);
    return {
      portfolio: r.portfolio,
      positions: r.positions,
      orders: r.orders,
      fills: r.fills,
      reconciliation: r.reconciliation ? { ok: r.reconciliation.ok, mismatches: r.reconciliation.reasons, action: r.reconciliation.action } : null,
      status: r.status,
      paused: r.paused,
      simulated: account.kind === "simulated",
    };
  });
}
