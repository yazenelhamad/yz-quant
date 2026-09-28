import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { notFound, validation } from "../http/errors.js";
import { buildAccountSummary } from "../services/accountSummary.js";

const GlobalRiskSchema = z.object({
  liveExecutionDisabled: z.boolean().optional(),
  forceShadowMode: z.boolean().optional(),
  pausedUsers: z.array(z.string()).optional(),
  disabledStrategyIds: z.array(z.string()).optional(),
  killSwitchActive: z.boolean().optional(),
  killSwitchNote: z.string().max(500).nullable().optional(),
});

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards, audit } = ctx;

  app.get("/api/admin/comparison", async (req) => {
    guards.requireRole(req, "admin");
    const all = await repos.accounts.listAll();
    const users = new Map((await repos.users.list()).map((u) => [u.id, u]));
    const accounts = [];
    for (const a of all) {
      const scope = { userId: a.userId, brokerAccountId: a.id };
      const summary = await buildAccountSummary(repos, a, users.get(a.userId));
      const positions = await repos.positions.list(scope);
      const settings = await repos.riskSettings.get(scope);
      const snap = await repos.snapshots.latest(scope);
      const openTrades = await repos.trades.list(scope, { states: ["monitoring", "filled", "partially_filled", "reduce"], limit: 500 });
      const strategies = new Set(openTrades.map((t) => t.strategyId));
      const total = snap?.totalValue ?? null;
      const exposure = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
      accounts.push({
        owner: { id: a.userId, displayName: users.get(a.userId)?.displayName ?? "unknown" },
        account: summary,
        dailyPnl: snap?.dailyPnl ?? null,
        totalReturnPct: snap && snap.totalPnl != null && total ? (snap.totalPnl / Math.max(1, total - snap.totalPnl)) * 100 : null,
        drawdownPct: snap?.drawdownPct ?? null,
        exposurePct: total ? (exposure / total) * 100 : null,
        riskUtilization: {
          positions: { used: positions.length, limit: settings.maxSimultaneousPositions },
          capitalDeployed: { used: total ? exposure / total : 0, limit: settings.maxCapitalDeployedPct },
        },
        activeStrategies: strategies.size,
        positions: positions.length,
      });
    }
    return { accounts, note: "Informational comparison. Portfolios are never merged." };
  });

  app.get("/api/admin/global-risk", async (req) => {
    guards.requireRole(req, "admin");
    return repos.globalRisk.get();
  });

  app.put("/api/admin/global-risk", async (req) => {
    const { user } = guards.requireStepUp(req);
    guards.requireRole(req, "admin");
    const body = GlobalRiskSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    const before = await repos.globalRisk.get();
    const patch: Record<string, unknown> = { ...body.data };
    if (body.data.killSwitchActive === true && !before.killSwitchActive) {
      patch["killSwitchReasons"] = ["admin_global"];
      patch["killSwitchTriggeredAt"] = new Date().toISOString();
      patch["killSwitchTriggeredBy"] = user.id;
    }
    if (body.data.killSwitchActive === false) {
      patch["killSwitchReasons"] = [];
      patch["killSwitchTriggeredAt"] = null;
      patch["killSwitchTriggeredBy"] = null;
    }
    const after = await repos.globalRisk.update(patch, user.id);
    await audit.record({ category: "admin", action: "global_risk_changed", result: "ok", detail: { before, after } }, req);
    return after;
  });

  app.get("/api/admin/users", async (req) => {
    guards.requireRole(req, "admin");
    const users = await repos.users.list();
    const out = [];
    for (const u of users) {
      out.push({ id: u.id, username: u.username, email: u.email, displayName: u.displayName, role: u.role, active: u.active, mfaEnabled: u.mfaEnabled, activeSessions: await repos.sessions.countActiveForUser(u.id), lockedUntil: u.lockedUntil, createdAt: u.createdAt });
    }
    return { users: out };
  });

  app.post("/api/admin/users/:id/sessions/revoke", async (req) => {
    guards.requireRole(req, "admin");
    const id = (req.params as { id: string }).id;
    if (!(await repos.users.byId(id))) throw notFound("User not found");
    const revoked = await repos.sessions.revokeAllForUser(id, "admin_revoked");
    await audit.record({ category: "admin", action: "sessions_revoked", result: "ok", userId: id, detail: { revoked } }, req);
    return { ok: true, revoked };
  });

  app.post("/api/admin/users/:id/mfa/reset", async (req) => {
    guards.requireStepUp(req);
    guards.requireRole(req, "admin");
    const id = (req.params as { id: string }).id;
    if (!(await repos.users.byId(id))) throw notFound("User not found");
    await repos.users.update(id, { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] });
    await repos.sessions.revokeAllForUser(id, "mfa_reset");
    await audit.record({ category: "admin", action: "mfa_reset", result: "ok", userId: id }, req);
    return { ok: true };
  });

  app.get("/api/admin/jobs", async (req) => {
    guards.requireRole(req, "admin");
    return { jobs: await repos.jobs.recent(200) };
  });

  app.get("/api/system/events", async (req) => {
    guards.requireRole(req, "admin");
    const limit = Math.min(500, Number((req.query as { limit?: string }).limit ?? 200));
    return { events: await repos.systemEvents.recent(limit) };
  });

  app.get("/api/audit", async (req) => {
    const { user } = guards.requireAuth(req);
    const q = req.query as { userId?: string; accountId?: string; category?: string; limit?: string };
    const limit = Math.min(1000, Number(q.limit ?? 200));
    if (user.role !== "admin") {
      return { logs: await repos.audit.recent({ userId: user.id, category: q.category, limit }) };
    }
    return { logs: await repos.audit.recent({ userId: q.userId, brokerAccountId: q.accountId, category: q.category, limit }) };
  });

  app.get("/api/system/health", async (req) => {
    guards.requireAuth(req);
    const components = await repos.health.all();
    const dbOk = await ctx.dbHandle.ping();
    const all = [
      { name: "database", status: dbOk ? "healthy" : "critical", detail: dbOk ? `${ctx.dbHandle.kind} reachable` : "database unreachable", checkedAt: new Date().toISOString(), metrics: null },
      ...components.map((c) => ({ name: c.name, status: c.status, detail: c.detail, checkedAt: c.checkedAt, metrics: c.metrics })),
    ];
    const rank = { critical: 3, warning: 2, unknown: 1, healthy: 0 } as Record<string, number>;
    const overall = all.reduce((worst, c) => ((rank[c.status] ?? 1) > (rank[worst] ?? 1) ? c.status : worst), "healthy");
    return { overall, components: all };
  });
}
