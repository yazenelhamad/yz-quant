import type { FastifyInstance } from "fastify";
import type { TradeLifecycleState } from "@yz/core";
import { TRADE_TRANSITIONS } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { notFound, validation } from "../http/errors.js";
import { dataPlaneRepo } from "../services/pipeline/common.js";
import { fillView, orderView, riskDecisionView, thesisOf, tradeExplanation, tradeReturnFraction, tradeView, type ThesisRowLike } from "../services/pipeline/views.js";

const STATES = new Set<string>(Object.keys(TRADE_TRANSITIONS));

function clampLimit(raw: string | undefined, dflt: number, max: number): number {
  const n = Number(raw ?? dflt);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.floor(n));
}

export async function registerTradeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;
  const dp = () => dataPlaneRepo(ctx);

  app.get("/api/accounts/:accountId/trades", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const q = req.query as { state?: string; mode?: string; limit?: string };
    const states = q.state ? q.state.split(",").map((s) => s.trim()).filter(Boolean) : [];
    for (const s of states) if (!STATES.has(s)) throw validation(`Unknown trade state ${s}`);
    if (q.mode && q.mode !== "live" && q.mode !== "shadow") throw validation("mode must be live or shadow");
    const trades = await repos.trades.list(scope, { states: states as TradeLifecycleState[], mode: q.mode as "live" | "shadow" | undefined, limit: clampLimit(q.limit, 100, 500) });
    const strategies = new Map((await dp().strategiesByIds([...new Set(trades.map((t) => t.strategyId))])).map((s) => [s.id, s]));
    const out = [];
    for (const t of trades) {
      const thesis = t.thesisId ? await repos.theses.byId(scope, t.thesisId) : (await repos.theses.forTrade(scope, t.id))[0];
      out.push(tradeView(t, strategies.get(t.strategyId)?.key ?? null, thesis ?? null));
    }
    return { trades: out };
  });

  app.get("/api/accounts/:accountId/trades/:tradeId", async (req) => {
    const params = req.params as { accountId: string; tradeId: string };
    const { scope } = await guards.resolveScope(req, params.accountId, "read");
    const trade = await repos.trades.byId(scope, params.tradeId);
    if (!trade) throw notFound("Trade not found");
    const [strategy] = await dp().strategiesByIds([trade.strategyId]);
    const thesisRow: ThesisRowLike | null = (trade.thesisId ? await repos.theses.byId(scope, trade.thesisId) : undefined) ?? (await repos.theses.forTrade(scope, trade.id))[0] ?? null;
    const thesis = thesisOf(thesisRow);
    const [events, orders, decisions, review, lessons] = await Promise.all([
      repos.trades.events(scope, trade.id), repos.orders.forTrade(scope, trade.id), repos.riskDecisions.recent(scope, 500), dp().postTradeReview(scope, trade.id), dp().tradeLessons(scope, trade.id),
    ]);
    const fills = (await Promise.all(orders.map((o) => repos.fills.forOrder(scope, o.id)))).flat().sort((a, b) => a.at.localeCompare(b.at));
    return {
      trade: tradeView(trade, strategy?.key ?? null, thesisRow),
      thesis,
      events: events.map((e) => ({ at: e.at, from: e.fromState, to: e.toState, note: e.reason, detail: e.detail ?? null })),
      orders: orders.map(orderView),
      fills: fills.map(fillView),
      riskDecisions: decisions.filter((d) => d.tradeId === trade.id || (trade.candidateId && d.candidateId === trade.candidateId)).map(riskDecisionView),
      review: review ? { ...(review.review as Record<string, unknown>), id: review.id, tradeId: review.tradeId, classification: review.classification, reviewedAt: review.reviewedAt, reviewerVersion: review.reviewerVersion } : null,
      lessons: lessons.map(lessonView),
      explanation: tradeExplanation(trade, thesis, strategy?.key ?? null),
    };
  });

  app.get("/api/accounts/:accountId/journal", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const limit = clampLimit((req.query as { limit?: string }).limit, 50, 500);
    const closed = await dp().closedTradesSince(scope, null, limit);
    const ids = closed.map((t) => t.id);
    const [reviews, lessons, strategies] = await Promise.all([dp().postTradeReviewsFor(scope, ids), dp().tradeLessonsFor(scope, ids), dp().strategiesByIds([...new Set(closed.map((t) => t.strategyId))])]);
    const reviewByTrade = new Map(reviews.map((r) => [r.tradeId, r]));
    const lessonByTrade = new Map<string, string>();
    for (const l of lessons) if (l.tradeId && !lessonByTrade.has(l.tradeId)) lessonByTrade.set(l.tradeId, l.lesson);
    const stratById = new Map(strategies.map((s) => [s.id, s.key]));
    const entries = [];
    for (const t of closed) {
      const thesisRow = (t.thesisId ? await repos.theses.byId(scope, t.thesisId) : undefined) ?? (await repos.theses.forTrade(scope, t.id))[0];
      const thesis = thesisOf(thesisRow);
      entries.push({
        tradeId: t.id, symbol: t.symbol, mode: t.mode, strategyKey: stratById.get(t.strategyId) ?? null, openedAt: t.openedAt, closedAt: t.closedAt,
        returnPct: tradeReturnFraction(t), realizedPnl: t.realizedPnl, exitReason: t.exitReason,
        classification: reviewByTrade.get(t.id)?.classification ?? null,
        thesisSummary: (thesis?.plainEnglish || thesis?.entryLogic || "").slice(0, 280) || null,
        lesson: lessonByTrade.get(t.id) ?? null,
      });
    }
    return { entries };
  });

  app.get("/api/accounts/:accountId/rejections", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const limit = clampLimit((req.query as { limit?: string }).limit, 100, 500);
    const rows = await repos.rejected.recent(scope, limit);
    const strategies = new Map((await dp().strategiesByIds([...new Set(rows.map((r) => r.strategyId))])).map((s) => [s.id, s.key]));
    return {
      rejections: rows.map((r) => ({
        id: r.id, candidateId: r.candidateId, symbol: r.symbol, strategyId: r.strategyId, strategyKey: strategies.get(r.strategyId) ?? null, reasons: r.reasons, detail: r.detail,
        expectedEdge: r.expectedEdge, confidence: r.confidence, regime: r.regime, priceAtRejection: r.priceAtRejection, rejectedAt: r.rejectedAt,
        subsequentReturnPct: r.subsequentReturnPct ? Object.fromEntries(Object.entries(r.subsequentReturnPct).map(([k, v]) => [k, v / 100])) : null,
        reviewVerdict: r.reviewVerdict, reviewedAt: r.reviewedAt,
      })),
    };
  });
}

export function lessonView(l: { id: string; tradeId: string | null; strategyKey: string; regime: string; setup: string; expected: string; actual: string; lesson: string; action: string; tags: Record<string, string>; confidenceImpact: number; timesConfirmed: number; timesContradicted: number; createdAt: string }) {
  return { id: l.id, tradeId: l.tradeId, strategyKey: l.strategyKey, regime: l.regime, setup: l.setup, expected: l.expected, actual: l.actual, lesson: l.lesson, action: l.action, tags: l.tags, confidenceImpact: l.confidenceImpact, timesConfirmed: l.timesConfirmed, timesContradicted: l.timesContradicted, createdAt: l.createdAt };
}
