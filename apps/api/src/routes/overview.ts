import type { FastifyInstance } from "fastify";
import type { EnsembleResult, Freshness } from "@yz/core";
import { DEFAULT_FRESHNESS_POLICY, TERMINAL_ORDER_STATES, ageSeconds, classifyAge, worstFreshnessOf, type BrokerOrderState } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { buildAccountSummary } from "../services/accountSummary.js";
import { dataPlaneRepo } from "../services/pipeline/common.js";
import { PIPELINE_SERVICE_KEY, type PipelineServices } from "../services/pipeline/index.js";
import { rowToAssessment, type RegimeRow } from "../services/pipeline/regime.js";
import { alertView } from "../services/pipeline/views.js";
import { buildPositionViews } from "./positions.js";
import { stateFromRow } from "../services/survival/service.js";
import { appNow, service } from "../services/registry.js";
import type { TradingService } from "../services/trading/index.js";

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export async function registerOverviewRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;

  app.get("/api/accounts/:accountId/overview", async (req) => {
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const now = appNow(ctx);
    const nowIso = now.toISOString();
    const dp = dataPlaneRepo(ctx);
    const [owner, summary, snapshot, settings, positions, regimeRow, alertsRows, open, recentOrders, evaluations, userSettings, ks, survivalRow] = await Promise.all([
      repos.users.byId(account.userId),
      buildAccountSummary(repos, account, undefined),
      repos.snapshots.latest(scope),
      repos.riskSettings.get(scope),
      buildPositionViews(ctx, scope, now),
      repos.market.latestRegime(),
      repos.alerts.forScope(scope, 100),
      repos.orders.open(scope),
      dp.ordersSince(scope, new Date(now.getTime() - 24 * 3_600_000).toISOString(), 500),
      dp.candidateEvaluations(scope, 200),
      dp.userStrategySettings(scope),
      repos.killSwitches.get(scope),
      repos.survival.latest(scope),
    ]);
    summary.owner = { id: account.userId, displayName: owner?.displayName ?? "unknown" };
    // The simulated book behind SHADOW mode: shown whenever the account runs in shadow or has shadow history.
    let shadowBook: { startingCapital: number; totalValue: number; cash: number; buyingPower: number; equityValue: number; positions: number; realizedPnl: number; unrealizedPnl: number; totalPnl: number; dailyPnl: number | null; dailyPnlPct: number | null; drawdownPct: number; asOf: string } | null = null;
    try {
      const trading = ctx.services["trading"] ? service<TradingService>(ctx, "trading") : null;
      const shadowTrades = trading ? (await repos.trades.list(scope, { mode: "shadow", limit: 1 })).length : 0;
      if (trading && (account.autonomyLevel === "shadow" || account.autonomyLevel === "research_only" || shadowTrades > 0 || trading.shadowBooks.has(scope))) {
        const b = await trading.shadowBooks.bookState(scope, account);
        shadowBook = { startingCapital: b.startingCapital, totalValue: b.totalValue, cash: b.cash, buyingPower: b.buyingPower, equityValue: b.equityValue, positions: b.positions.length, realizedPnl: b.realizedPnl, unrealizedPnl: b.unrealizedPnl, totalPnl: b.totalPnl, dailyPnl: b.dailyPnl, dailyPnlPct: b.dailyPnlPct, drawdownPct: b.drawdownPct, asOf: b.asOf };
      }
    } catch { shadowBook = null; }
    const totalValue = snapshot?.totalValue ?? null;

    // Exposure is measured on one book: the real account's live positions against its snapshot
    // value, or, when the account runs in shadow (or holds only shadow positions), the shadow
    // book's positions against the shadow book's value. Mixing them would divide simulated
    // notional by a real balance.
    const shadowViews = positions.filter((p) => p.view.mode === "shadow");
    const liveViews = positions.filter((p) => p.view.mode !== "shadow");
    const useShadow = shadowBook !== null && (account.autonomyLevel === "shadow" || account.autonomyLevel === "research_only" || (liveViews.length === 0 && shadowViews.length > 0));
    const exposureViews = useShadow ? shadowViews : liveViews;
    const exposureBase = useShadow ? shadowBook!.totalValue : totalValue;

    // Exposure by sector and portfolio beta (only from positions with a known mark / beta; never guessed).
    const bySector: Record<string, number> = {};
    let gross = 0;
    let betaWeight = 0;
    let betaSum = 0;
    for (const { view } of exposureViews) {
      if (view.marketValue == null) continue;
      gross += Math.abs(view.marketValue);
      if (exposureBase) {
        const sector = view.sector ?? "unknown";
        bySector[sector] = (bySector[sector] ?? 0) + Math.abs(view.marketValue) / exposureBase;
        if (view.beta != null) { betaWeight += view.marketValue / exposureBase; betaSum += (view.marketValue / exposureBase) * view.beta; }
      }
    }
    const grossPct = exposureBase ? gross / exposureBase : null;
    const beta = betaWeight > 0 ? betaSum : null;
    const maxSector = Object.values(bySector).reduce((m, v) => Math.max(m, v), 0);
    const unmarked = exposureViews.filter((p) => p.view.marketValue == null).length;

    const dailyPnl = snapshot?.dailyPnl ?? null;
    const totalPnl = snapshot?.totalPnl ?? null;
    const pnl = {
      daily: dailyPnl, total: totalPnl,
      dailyPct: dailyPnl != null && totalValue && totalValue - dailyPnl > 0 ? dailyPnl / (totalValue - dailyPnl) : null,
      totalPct: totalPnl != null && totalValue && totalValue - totalPnl > 0 ? totalPnl / (totalValue - totalPnl) : null,
    };
    const drawdownPct = snapshot?.drawdownPct ?? null;
    const dailyLossUsed = dailyPnl != null && totalValue ? Math.max(0, -dailyPnl / (totalValue - dailyPnl)) : null;
    const utilization: Record<string, { used: number | null; limit: number }> = {
      positions: { used: positions.length, limit: settings.maxSimultaneousPositions },
      capitalDeployed: { used: grossPct, limit: settings.maxCapitalDeployedPct },
      dailyLoss: { used: dailyLossUsed, limit: settings.maxDailyLossPct },
      drawdown: { used: drawdownPct, limit: settings.maxDrawdownPct },
      sectorMax: { used: Object.keys(bySector).length ? maxSector : (positions.length ? null : 0), limit: settings.maxSectorPct },
      portfolioBeta: { used: beta, limit: settings.maxPortfolioBeta },
    };
    const ratios = Object.values(utilization).filter((u) => u.used != null && u.limit > 0).map((u) => 1 - (u.used as number) / u.limit);
    const capacity = ratios.length ? clamp01(Math.min(...ratios)) : null;

    // Active strategies for this account (user settings joined with the shared library).
    const enabled = userSettings.filter((s) => s.enabled);
    const stratRows = await dp.strategiesByIds(enabled.map((s) => s.strategyId));
    const activeStrategies = enabled.map((s) => {
      const st = stratRows.find((r) => r.id === s.strategyId);
      return { id: s.strategyId, key: st?.key ?? null, name: st?.name ?? null, stage: s.stage, globalStage: st?.stage ?? null, allocation: s.capitalAllocation, globallyDisabled: st?.globallyDisabled ?? false };
    }).filter((s) => s.key !== null);

    // Top opportunities: this account's evaluations of shared candidates, ranked by edge × confidence.
    const candidates = new Map((await dp.candidatesByIds(evaluations.map((e) => e.candidateId))).map((c) => [c.id, c]));
    const topOpportunities = evaluations
      .map((e) => ({ e, c: candidates.get(e.candidateId) }))
      .filter((x): x is { e: typeof evaluations[number]; c: NonNullable<typeof x.c> } => !!x.c && Date.parse(x.c.expiresAt) > now.getTime())
      .map(({ e, c }) => {
        const ens = c.ensemble as EnsembleResult;
        const edge = typeof ens?.expectedEdge === "number" ? ens.expectedEdge : 0;
        const conf = typeof ens?.confidence === "number" ? ens.confidence : 0;
        const detail = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
        return {
          candidateId: c.id, symbol: c.symbol, strategyKey: c.strategyKey, strategyName: stratRows.find((r) => r.id === c.strategyId)?.name ?? null, direction: c.direction,
          expectedEdge: edge, confidence: conf, calibratedConfidence: typeof detail["calibratedConfidence"] === "number" ? (detail["calibratedConfidence"] as number) : conf,
          potentialDownsidePct: c.expectedDownsidePct, expectedUpsidePct: c.expectedUpsidePct, holdingPeriodDays: c.holdingPeriodDays, regimeFit: c.regimeFit, liquidityScore: c.liquidityScore,
          catalyst: c.catalyst, catalystAt: c.catalystAt, risk: { score: typeof detail["riskScore"] === "number" ? (detail["riskScore"] as number) : null, notes: Array.isArray(detail["riskNotes"]) ? (detail["riskNotes"] as string[]) : [] },
          portfolioFit: e.portfolioFit, historicalSimilarity: c.historicalSimilarity, strategyPerformance: detail["strategyPerformance"] ?? null, variantScore: typeof detail["variantScore"] === "number" ? (detail["variantScore"] as number) : null,
          finalStatus: e.finalStatus, reasons: Array.isArray(detail["reasons"]) ? (detail["reasons"] as string[]) : (ens?.explanation ?? []),
          ensemble: ens ? { components: ens.components ?? [], explanation: ens.explanation ?? [], disagreement: ens.disagreement, uncertainty: ens.uncertainty } : undefined,
          createdAt: c.createdAt, score: Math.max(0, edge) * conf,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    // Upcoming catalysts: earnings for held symbols in the next 14 days (persisted from the broker calendar; never invented).
    const heldSymbols = positions.map((p) => p.view.symbol);
    const earnings = await repos.market.upcomingEarnings(heldSymbols, nowIso, new Date(now.getTime() + 14 * 86_400_000).toISOString());
    const upcomingCatalysts = earnings.sort((a, b) => a.reportAt.localeCompare(b.reportAt)).map((e) => ({ symbol: e.symbol, kind: "earnings", at: e.reportAt, description: `${e.symbol} earnings${e.timing === "bmo" ? " (before open)" : e.timing === "amc" ? " (after close)" : ""}${e.epsEstimate != null ? `, EPS est. ${e.epsEstimate}` : ""}`, source: e.source }));

    // Execution issues: rejected/failed in the last 24 h plus open orders older than 30 minutes.
    const executionIssues: { orderId: string; symbol: string; issue: string; at: string; state: string }[] = [];
    for (const o of recentOrders) if (o.state === "rejected" || o.state === "failed") executionIssues.push({ orderId: o.id, symbol: o.symbol, issue: `${o.side} ${o.state}${o.error ? `: ${o.error}` : ""}`, at: o.updatedAt, state: o.state });
    for (const o of open) {
      if (TERMINAL_ORDER_STATES.has(o.state as BrokerOrderState)) continue;
      const ageMin = (now.getTime() - Date.parse(o.submittedAt ?? o.createdAt)) / 60_000;
      if (ageMin > 30) executionIssues.push({ orderId: o.id, symbol: o.symbol, issue: `${o.side} ${o.type} open for ${ageMin.toFixed(0)} min (${o.state})`, at: o.submittedAt ?? o.createdAt, state: o.state });
    }

    // Broker status: cached live check when the pipeline runs, else the persisted account state.
    const pipeline = ctx.services[PIPELINE_SERVICE_KEY] as PipelineServices | undefined;
    const cached = pipeline?.brokerStatuses.get(account.id);
    const broker = { status: cached?.status ?? account.status, detail: cached?.detail ?? account.statusDetail ?? null, lastHealthyAt: cached?.lastHealthyAt ?? account.lastHealthyAt, checkedAt: cached?.checkedAt ?? account.updatedAt, simulated: account.kind === "simulated" };

    // Data quality: quotes (held symbols), daily bars (held symbols, else SPY), regime age.
    const quotesFreshness: Freshness = positions.length ? worstFreshnessOf(...positions.map((p) => p.view.dataFreshness)) : "unknown";
    const barSymbols = heldSymbols.length ? heldSymbols : ["SPY"];
    const barTimes = await dp.latestBarTimes(barSymbols, "day");
    const barFresh = barSymbols.map((s) => classifyAge(ageSeconds(barTimes.get(s) ?? null, nowIso), (DEFAULT_FRESHNESS_POLICY.barsAgingDays + 1.5) * 86_400, (DEFAULT_FRESHNESS_POLICY.barsStaleDays + 1.5) * 86_400));
    const regimeAge = ageSeconds(regimeRow?.asOf ?? null, nowIso);
    const dataQuality = {
      quotes: quotesFreshness, bars: worstFreshnessOf(...barFresh),
      regime: classifyAge(regimeAge, DEFAULT_FRESHNESS_POLICY.regimeAgingMinutes * 60, DEFAULT_FRESHNESS_POLICY.regimeStaleMinutes * 60),
      notes: [positions.length === 0 ? "no positions: quote freshness not applicable" : null, unmarked > 0 ? `${unmarked} position(s) without a mark` : null, regimeRow ? null : "no regime assessment yet"].filter((n): n is string => n !== null),
    };

    return {
      account: summary,
      portfolio: summary.portfolio,
      pnl,
      positionsCount: positions.length,
      exposure: { grossPct, bySector, beta, unmarkedPositions: unmarked },
      regime: regimeRow ? rowToAssessment(regimeRow as RegimeRow) : null,
      drawdownPct,
      risk: { utilization, capacity, killSwitchActive: !!ks?.active, killSwitchReasons: ks?.reasons ?? [], tradingPaused: account.tradingPaused, pausedReason: account.pausedReason },
      activeStrategies,
      topOpportunities,
      upcomingCatalysts,
      alerts: alertsRows.filter((a) => !a.acknowledged).map(alertView),
      executionIssues,
      broker,
      dataQuality,
      shadowBook,
      survival: (() => { const sv = stateFromRow(survivalRow); return sv ? { mode: sv.mode, modeSince: sv.modeSince, fitnessScore: sv.fitnessScore, riskMultiplier: sv.riskMultiplier, minEdgeMultiplier: sv.minEdgeMultiplier, hurdleBps: sv.hurdleBps, maxNewPositions: sv.maxNewPositions, allowLiveEntries: sv.allowLiveEntries, runwayDays: sv.runway.days, alphaPct: sv.alpha.alphaPct, benchmark: sv.alpha.label, mandate: sv.mandate, reasons: sv.reasons, hurdles: sv.hurdles, computedAt: sv.computedAt } : null; })(),
      asOf: nowIso,
    };
  });
}
