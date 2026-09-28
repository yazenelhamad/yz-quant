import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http/app.js";
import { notFound } from "../http/errors.js";
import { tradingService } from "../services/trading/index.js";

export interface RiskUtilization {
  positions: { used: number; limit: number };
  capitalDeployed: { used: number; limit: number };
  dailyLoss: { used: number; limit: number };
  weeklyLoss: { used: number; limit: number };
  drawdown: { used: number; limit: number };
  sector: { used: number; limit: number; sector: string | null };
  beta: { used: number | null; limit: number };
}

/**
 * GET /api/accounts/:accountId/risk — settings, utilisation (same computation as the overview:
 * positions / capital / daily loss / drawdown / sector, all fractions), kill switch, global state,
 * recent decisions and alerts for THIS account.
 */
export async function registerRiskRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/accounts/:accountId/risk", async (req) => {
    const { scope } = await ctx.guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const svc = tradingService(ctx);
    const acct = await svc.accountContext(scope);
    if (!acct) throw notFound("Account not found");
    const s = acct.settings;
    const total = acct.portfolio.totalValue ?? 0;
    const bySector: Record<string, number> = {};
    let betaExposure: number | null = 0;
    for (const p of acct.positions) {
      const mv = Math.abs(p.marketValue ?? 0);
      const info = acct.instruments.get(p.symbol);
      const sector = info?.sector ?? "unknown";
      bySector[sector] = (bySector[sector] ?? 0) + (total > 0 ? mv / total : 0);
      if (betaExposure !== null) betaExposure = info && info.beta !== null && total > 0 ? betaExposure + (info.beta * mv) / total : null;
    }
    const topSector = Object.entries(bySector).sort((a, b) => b[1] - a[1])[0] ?? null;
    const utilization: RiskUtilization = {
      positions: { used: new Set(acct.positions.map((p) => p.symbol)).size, limit: s.maxSimultaneousPositions },
      capitalDeployed: { used: acct.portfolio.deployedPct ?? 0, limit: s.maxCapitalDeployedPct },
      dailyLoss: { used: Math.max(0, -(acct.portfolio.dailyPnlPct ?? 0)), limit: s.maxDailyLossPct },
      weeklyLoss: { used: Math.max(0, -(acct.portfolio.weeklyPnlPct ?? 0)), limit: s.maxWeeklyLossPct },
      drawdown: { used: acct.portfolio.drawdownPct ?? 0, limit: s.maxDrawdownPct },
      sector: { used: topSector ? topSector[1] : 0, limit: s.maxSectorPct, sector: topSector ? topSector[0] : null },
      beta: { used: betaExposure, limit: s.maxPortfolioBeta },
    };
    const [decisions, alerts, globalAlerts] = await Promise.all([ctx.repos.riskDecisions.recent(scope, 20), ctx.repos.alerts.forScope(scope, 30), ctx.repos.alerts.global(10)]);
    const ks = acct.killSwitch;
    return {
      settings: s,
      utilization,
      killSwitch: { active: ks.active, reasons: ks.reasons, allowRiskReducingExits: ks.allowRiskReducingExits, triggeredAt: ks.triggeredAt, triggeredBy: ks.triggeredBy, note: ks.note },
      global: { liveExecutionDisabled: acct.global.liveExecutionDisabled, forceShadowMode: acct.global.forceShadowMode, pausedByAdmin: acct.global.pausedUsers.includes(scope.userId), globalKillSwitch: acct.global.globalKillSwitch.active },
      recentDecisions: decisions.map((d) => ({ id: d.id, candidateId: d.candidateId, tradeId: d.tradeId, symbol: d.symbol, action: d.action, verdict: d.verdict, approvedQuantity: d.approvedQuantity, requestedQuantity: d.requestedQuantity, reasons: d.reasons, decidedAt: d.decidedAt, failedClosed: d.failedClosed })),
      alerts: [...alerts, ...globalAlerts].map((a) => ({ id: a.id, severity: a.severity, code: a.kind, message: `${a.title}: ${a.message}`, at: a.createdAt, acknowledged: a.acknowledged })),
      account: { tradingPaused: acct.account.tradingPaused, pausedReason: acct.account.pausedReason, autonomyLevel: acct.account.autonomyLevel, reconciliationOk: acct.reconciliation.ok, session: acct.session },
    };
  });
}
