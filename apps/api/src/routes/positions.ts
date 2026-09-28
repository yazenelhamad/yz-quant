import type { FastifyInstance } from "fastify";
import type { Freshness, TenantScope, TradeThesis } from "@yz/core";
import type { PositionRow, TradeRow } from "@yz/db";
import type { AppContext } from "../http/app.js";
import { notFound } from "../http/errors.js";
import { dataPlaneRepo } from "../services/pipeline/common.js";
import { holdingDays, orderView, quoteFreshnessAt, thesisOf, thesisSummary, type ThesisRowLike } from "../services/pipeline/views.js";

export interface PositionView {
  symbol: string; quantity: number; sharesAvailableForSells: number; averageCost: number | null; markPrice: number | null; marketValue: number | null;
  unrealizedPnl: number | null; unrealizedPnlPct: number | null; strategyKey: string | null; tradeId: string | null; thesisId: string | null; entryReason: string | null;
  initialConfidence: number | null; currentConfidence: number | null; regimeAtEntry: string | null; currentRegime: string | null; expectedHoldingDays: number | null;
  ageDays: number | null; invalidationPrice: number | null; invalidationCondition: string | null; targetPrice: number | null; exitLogic: string | null;
  riskContribution: number | null; external: boolean; dataFreshness: Freshness; asOf: string; sector: string | null; beta: number | null; mode: "live" | "shadow" | null;
}

interface PositionContext { view: PositionView; position: PositionRow; trade: TradeRow | null; thesisRow: ThesisRowLike | null; thesis: TradeThesis | null }

/** Positions joined with their managing trade, latest thesis, quote freshness and instrument beta. Shared by positions and overview. */
export async function buildPositionViews(ctx: AppContext, scope: TenantScope, now = new Date()): Promise<PositionContext[]> {
  const { repos } = ctx;
  const dp = dataPlaneRepo(ctx);
  const positions = await repos.positions.list(scope);
  if (positions.length === 0) return [];
  const symbols = positions.map((p) => p.symbol);
  const [quotes, instruments, snapshot, regime] = await Promise.all([repos.market.latestQuotes(symbols), repos.market.instrumentsFor(symbols), repos.snapshots.latest(scope), repos.market.latestRegime()]);
  const quoteBySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const instBySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const totalValue = snapshot?.totalValue ?? null;
  const out: PositionContext[] = [];
  const strategyIds = new Set<string>();
  const rows: { position: PositionRow; trade: TradeRow | null; thesisRow: ThesisRowLike | null }[] = [];
  for (const p of positions) {
    const trade = p.tradeId ? (await repos.trades.byId(scope, p.tradeId)) ?? null : null;
    let thesisRow: ThesisRowLike | null = null;
    if (trade) {
      thesisRow = (trade.thesisId ? await repos.theses.byId(scope, trade.thesisId) : undefined) ?? (await repos.theses.forTrade(scope, trade.id))[0] ?? null;
    }
    if (trade?.strategyId) strategyIds.add(trade.strategyId);
    if (p.strategyId) strategyIds.add(p.strategyId);
    rows.push({ position: p, trade, thesisRow });
  }
  const strategies = new Map((await dp.strategiesByIds([...strategyIds])).map((s) => [s.id, s]));
  for (const { position: p, trade, thesisRow } of rows) {
    const thesis = thesisOf(thesisRow);
    const q = quoteBySymbol.get(p.symbol);
    const inst = instBySymbol.get(p.symbol);
    const mark = p.markPrice ?? q?.last ?? null;
    const marketValue = p.marketValue ?? (mark != null ? mark * p.quantity : null);
    const basis = p.averageCost != null ? p.averageCost * p.quantity : null;
    const unrealizedPnl = p.unrealizedPnl ?? (marketValue != null && basis != null ? marketValue - basis : null);
    const strategyId = trade?.strategyId ?? p.strategyId ?? null;
    const strategyKey = strategyId ? strategies.get(strategyId)?.key ?? null : null;
    const beta = inst?.beta ?? null;
    const view: PositionView = {
      symbol: p.symbol, quantity: p.quantity, sharesAvailableForSells: p.sharesAvailableForSells, averageCost: p.averageCost, markPrice: mark, marketValue, unrealizedPnl,
      unrealizedPnlPct: unrealizedPnl != null && basis ? unrealizedPnl / basis : null,
      strategyKey, tradeId: trade?.id ?? null, thesisId: thesisRow?.id ?? trade?.thesisId ?? null,
      entryReason: thesis?.entryLogic ?? null, initialConfidence: trade?.initialConfidence ?? null, currentConfidence: thesisRow?.calibratedConfidence ?? null,
      regimeAtEntry: trade?.regimeAtEntry ?? null, currentRegime: regime?.primary ?? null, expectedHoldingDays: trade?.expectedHoldingDays ?? thesis?.expectedHoldingPeriodDays ?? null,
      ageDays: trade ? holdingDays(trade, now) : null,
      invalidationPrice: trade?.invalidationPrice ?? thesis?.invalidationPrice ?? null, invalidationCondition: thesis?.invalidationPoint ?? null,
      targetPrice: trade?.targetPrice ?? thesis?.targetPrice ?? null, exitLogic: thesis?.exitConditions?.length ? thesis.exitConditions.join("; ") : null,
      riskContribution: marketValue != null && totalValue && beta != null ? (marketValue / totalValue) * beta : null,
      external: !trade, dataFreshness: q ? quoteFreshnessAt(q.observedAt, q.reliability, now) : "unknown", asOf: p.asOf, sector: inst?.sector ?? null, beta,
      mode: trade?.mode ?? null,
    };
    out.push({ view, position: p, trade, thesisRow, thesis });
  }
  return out;
}

/** Deterministic hold/exit reasons from price vs. thesis levels, regime match, age and P&L. Never model-generated. */
export function holdExitReasons(v: PositionView, thesis: TradeThesis | null, expectedDownsidePct: number | null): { reasonsToHold: string[]; reasonsToExit: string[] } {
  const hold: string[] = [];
  const exit: string[] = [];
  if (v.external) return { reasonsToHold: ["External position: opened outside the platform, not managed by a trade thesis"], reasonsToExit: [] };
  const status = thesis?.status ?? null;
  if (status === "active") hold.push(`Thesis active (calibrated confidence ${((v.currentConfidence ?? 0) * 100).toFixed(0)}%)`);
  else if (status === "invalidated") exit.push("Thesis has been invalidated");
  else if (status === "superseded") exit.push("Thesis superseded by a newer assessment");
  else if (status) hold.push(`Thesis status: ${status}`);
  if (v.markPrice != null && v.invalidationPrice != null) {
    const d = v.markPrice / v.invalidationPrice - 1;
    if (v.markPrice <= v.invalidationPrice) exit.push(`Price ${v.markPrice.toFixed(2)} at or below invalidation ${v.invalidationPrice.toFixed(2)}`);
    else hold.push(`Price ${(d * 100).toFixed(1)}% above invalidation ${v.invalidationPrice.toFixed(2)}`);
  }
  if (v.markPrice != null && v.targetPrice != null) {
    if (v.markPrice >= v.targetPrice) exit.push(`Target ${v.targetPrice.toFixed(2)} reached`);
    else hold.push(`${((v.targetPrice / v.markPrice - 1) * 100).toFixed(1)}% remaining to target ${v.targetPrice.toFixed(2)}`);
  }
  if (v.regimeAtEntry && v.currentRegime) {
    if (v.regimeAtEntry === v.currentRegime) hold.push(`Regime unchanged since entry (${v.currentRegime.replace(/_/g, " ")})`);
    else exit.push(`Regime changed from ${v.regimeAtEntry.replace(/_/g, " ")} to ${v.currentRegime.replace(/_/g, " ")}`);
  }
  if (v.ageDays != null && v.expectedHoldingDays != null) {
    if (v.ageDays > v.expectedHoldingDays) exit.push(`Held ${v.ageDays.toFixed(1)} days versus expected ${v.expectedHoldingDays.toFixed(0)}`);
    else hold.push(`Within expected holding period (${v.ageDays.toFixed(1)} of ${v.expectedHoldingDays.toFixed(0)} days)`);
  }
  if (v.unrealizedPnlPct != null && expectedDownsidePct != null && expectedDownsidePct > 0 && v.unrealizedPnlPct < -expectedDownsidePct) {
    exit.push(`Unrealised loss ${(v.unrealizedPnlPct * 100).toFixed(1)}% exceeds expected downside ${(expectedDownsidePct * 100).toFixed(1)}%`);
  }
  if (v.dataFreshness === "stale" || v.dataFreshness === "unknown") exit.push(`Quote data is ${v.dataFreshness}; levels cannot be verified`);
  return { reasonsToHold: hold, reasonsToExit: exit };
}

export async function registerPositionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;

  app.get("/api/accounts/:accountId/positions", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const rows = await buildPositionViews(ctx, scope);
    return { positions: rows.map((r) => r.view) };
  });

  app.get("/api/accounts/:accountId/positions/:symbol", async (req) => {
    const params = req.params as { accountId: string; symbol: string };
    const { scope } = await guards.resolveScope(req, params.accountId, "read");
    const symbol = params.symbol.toUpperCase();
    const rows = await buildPositionViews(ctx, scope);
    const row = rows.find((r) => r.view.symbol === symbol);
    if (!row) throw notFound(`No position in ${symbol}`);
    const { view, trade, thesis } = row;
    const history = trade ? await repos.theses.forTrade(scope, trade.id) : await repos.theses.forSymbol(scope, symbol, 10);
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const news = await repos.market.newsFor(symbol, since, 30);
    const orders = trade ? await repos.orders.forTrade(scope, trade.id) : (await repos.orders.recent(scope, 200)).filter((o) => o.symbol === symbol);
    const { reasonsToHold, reasonsToExit } = holdExitReasons(view, thesis, trade?.expectedDownsidePct ?? thesis?.expectedDownsidePct ?? null);
    return {
      ...view,
      thesis,
      thesisHistory: history.map(thesisSummary),
      modelVotes: thesis?.modelVotes ?? [],
      news: news.map((n) => ({ source: n.source, headline: n.headline, at: n.publishedAt, url: n.url ?? undefined, sentiment: sentimentOf(n.interpretation), genuinelyNew: n.genuinelyNew ?? undefined })),
      reasonsToHold, reasonsToExit,
      similarTrades: thesis?.similarHistoricalTrades ?? [],
      orders: orders.map(orderView),
    };
  });
}

function sentimentOf(interpretation: unknown): string | undefined {
  if (interpretation && typeof interpretation === "object" && typeof (interpretation as { sentiment?: unknown }).sentiment === "string") return (interpretation as { sentiment: string }).sentiment;
  return undefined;
}
