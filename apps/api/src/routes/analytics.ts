import type { FastifyInstance } from "fastify";
import type { PerformanceStats } from "@yz/core";
import { computePerformanceStats } from "@yz/core";
import type { TradeRow } from "@yz/db";
import type { AppContext } from "../http/app.js";
import { validation } from "../http/errors.js";
import { pctPointsToFraction } from "../lib/units.js";
import { coreServices } from "../services/registry.js";
import { dataPlaneRepo } from "../services/pipeline/common.js";
import { holdingDays, tradeReturnFraction } from "../services/pipeline/views.js";

export type AnalyticsPeriod = "day" | "week" | "month" | "all";
const PERIODS = new Set<string>(["day", "week", "month", "all"]);

export function periodStart(period: AnalyticsPeriod, now: Date): string | null {
  if (period === "all") return null;
  const days = period === "day" ? 1 : period === "week" ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Learning-engine stats use percent points; the API contract uses fractions. Convert every *Pct field. */
export function statsToApi(s: PerformanceStats): PerformanceStats {
  return {
    ...s,
    expectancyPct: pctPointsToFraction(s.expectancyPct), avgReturnPct: pctPointsToFraction(s.avgReturnPct), avgWinPct: pctPointsToFraction(s.avgWinPct),
    avgLossPct: pctPointsToFraction(s.avgLossPct), maxDrawdownPct: pctPointsToFraction(s.maxDrawdownPct), netReturnPct: pctPointsToFraction(s.netReturnPct),
  };
}

function observation(t: TradeRow, now: Date): { returnPct: number; holdingDays: number | null } | null {
  const r = tradeReturnFraction(t);
  if (r === null) return null;
  return { returnPct: r * 100, holdingDays: holdingDays(t, now) };
}

export async function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;

  app.get("/api/accounts/:accountId/analytics", async (req) => {
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const q = req.query as { period?: string; mode?: string };
    const period = (q.period ?? "all") as AnalyticsPeriod;
    if (!PERIODS.has(period)) throw validation("period must be day, week, month or all");
    if (q.mode && q.mode !== "live" && q.mode !== "shadow") throw validation("mode must be live or shadow");
    const now = new Date();
    const since = periodStart(period, now);
    const dp = dataPlaneRepo(ctx);
    const closedAll = await dp.closedTradesSince(scope, since, 2000);
    const closed = q.mode ? closedAll.filter((t) => t.mode === q.mode) : closedAll;
    const obs = closed.map((t) => observation(t, now)).filter((o): o is { returnPct: number; holdingDays: number | null } => o !== null);
    const performance = statsToApi(computePerformanceStats(obs));

    const strategies = new Map((await dp.strategiesByIds([...new Set(closed.map((t) => t.strategyId))])).map((s) => [s.id, s]));
    const groups = new Map<string, { name: string | null; obs: { returnPct: number; holdingDays: number | null }[]; realizedPnl: number; trades: number }>();
    for (const t of closed) {
      const key = strategies.get(t.strategyId)?.key ?? t.strategyId;
      const g = groups.get(key) ?? { name: strategies.get(t.strategyId)?.name ?? null, obs: [], realizedPnl: 0, trades: 0 };
      const o = observation(t, now);
      if (o) g.obs.push(o);
      g.realizedPnl += t.realizedPnl;
      g.trades += 1;
      groups.set(key, g);
    }
    const byStrategy = [...groups.entries()].map(([strategyKey, g]) => ({ strategyKey, name: g.name, stats: statsToApi(computePerformanceStats(g.obs)), realizedPnl: g.realizedPnl, trades: g.trades })).sort((a, b) => b.realizedPnl - a.realizedPnl);

    const snapshots = await dp.snapshotsSince(scope, since, 5000);
    const equityCurve = snapshots.map((s) => ({ time: s.asOf, value: s.totalValue }));
    let peak = 0;
    const drawdownCurve = snapshots.map((s) => { peak = Math.max(peak, s.totalValue); return { time: s.asOf, value: peak > 0 ? Math.max(0, (peak - s.totalValue) / peak) : 0 }; });
    const exposureHistory = snapshots.filter((s) => s.exposurePct != null).map((s) => ({ time: s.asOf, value: s.exposurePct as number }));

    let realizedPnlFromBroker: { total: number | null; asOf: string; period: string; note?: string; simulated?: boolean } | null = null;
    const span = period === "all" ? "all" : period;
    if (account.status === "connected") {
      try {
        const { broker } = coreServices(ctx);
        const adapter = await broker.adapterFor(scope);
        if (adapter) {
          const r = await adapter.getRealizedPnl(span);
          realizedPnlFromBroker = { total: r.totalReturns, asOf: r.provenance.receivedAt, period: r.window, ...(account.kind === "simulated" ? { simulated: true, note: "SIMULATED account: realised P&L comes from the shadow simulator, not a broker" } : {}) };
        } else realizedPnlFromBroker = { total: null, asOf: now.toISOString(), period: span, note: "no broker adapter for this account" };
      } catch (err) {
        realizedPnlFromBroker = { total: null, asOf: now.toISOString(), period: span, note: `broker realised P&L unavailable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
      }
    } else {
      realizedPnlFromBroker = { total: null, asOf: now.toISOString(), period: span, note: `broker not connected (${account.status})` };
    }

    const realizedPnlInternal = closed.reduce((s, t) => s + t.realizedPnl, 0);
    return { period, mode: q.mode ?? "all", since, performance, byStrategy, equityCurve, drawdownCurve, exposureHistory, realizedPnlFromBroker, realizedPnlInternal, tradesClosed: closed.length, snapshots: snapshots.length };
  });
}
