import type { Freshness, TradeThesis } from "@yz/core";
import { marketSessionAt, quoteQuality } from "@yz/core";
import type { OrderRow, TradeRow } from "@yz/db";

/** Order as exposed by the API: the core `BrokerOrder` minus `scope`/`raw`, plus platform fields. Never leaks raw payloads. */
export function orderView(o: OrderRow) {
  const raw = o.raw && typeof o.raw === "object" ? (o.raw as Record<string, unknown>) : {};
  return {
    id: o.id, brokerOrderId: o.brokerOrderId, refId: o.refId, tradeId: o.tradeId, strategyId: o.strategyId, strategyVersionId: o.strategyVersionId,
    symbol: o.symbol, side: o.side, type: o.type, state: o.state, quantity: o.quantity, dollarAmount: o.dollarAmount, limitPrice: o.limitPrice, stopPrice: o.stopPrice,
    timeInForce: o.timeInForce, marketHours: o.marketHours, mode: o.mode, cumulativeQuantity: o.cumulativeQuantity, averagePrice: o.averagePrice, fees: o.fees,
    arrivalPrice: o.arrivalPrice, expectedSlippageBps: o.expectedSlippageBps, reviewedAt: o.reviewedAt, submittedAt: o.submittedAt, lastBrokerSyncAt: o.lastBrokerSyncAt,
    reprices: o.reprices, cancelRequestedAt: o.cancelRequestedAt, error: o.error,
    // Platform-placed orders always belong to a trade; anything else was placed in the Robinhood app or by another agent.
    external: raw["external"] === true || (o.tradeId === null && o.strategyId === null), placedAgent: typeof raw["placedAgent"] === "string" ? (raw["placedAgent"] as string) : typeof raw["placed_agent"] === "string" ? (raw["placed_agent"] as string) : null,
    simulated: raw["simulated"] === true || o.mode === "shadow",
    createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}
export type OrderView = ReturnType<typeof orderView>;

export interface ThesisRowLike { id: string; createdAt: string; status: string; confidence: number; calibratedConfidence: number; expectedEdge: number; thesis: unknown; symbol: string; strategyId: string; tradeId: string | null; marketRegime: string }

export function thesisOf(row: ThesisRowLike | undefined | null): TradeThesis | null {
  if (!row || !row.thesis || typeof row.thesis !== "object") return null;
  return row.thesis as TradeThesis;
}

export function thesisSummary(row: ThesisRowLike) {
  const t = thesisOf(row);
  const summary = (t?.plainEnglish || t?.entryLogic || "").slice(0, 280);
  return { thesisId: row.id, at: row.createdAt, status: row.status, confidence: row.confidence, calibratedConfidence: row.calibratedConfidence, expectedEdge: row.expectedEdge, summary };
}

export function fillView(f: { id: string; orderId: string; brokerOrderId: string | null; tradeId: string | null; symbol: string; side: string; quantity: number; price: number; fees: number; derived: boolean; mode: string; at: string }) {
  return { id: f.id, orderId: f.orderId, brokerOrderId: f.brokerOrderId, tradeId: f.tradeId, symbol: f.symbol, side: f.side, quantity: f.quantity, price: f.price, fees: f.fees, derived: f.derived, mode: f.mode, at: f.at };
}

export function alertView(a: { id: string; severity: string; kind: string; title: string; message: string; createdAt: string; acknowledged: boolean }) {
  return { id: a.id, severity: a.severity, code: a.kind, message: a.title ? `${a.title}: ${a.message}` : a.message, at: a.createdAt, acknowledged: a.acknowledged };
}

export function riskDecisionView(r: { id: string; candidateId: string | null; tradeId: string | null; symbol: string; action: string; verdict: string; requestedQuantity: number; approvedQuantity: number; approvedNotional: number; checks: unknown; reasons: string[]; failedClosed: boolean; riskEngineVersion: string; decidedAt: string }) {
  return { id: r.id, candidateId: r.candidateId, tradeId: r.tradeId, symbol: r.symbol, action: r.action, verdict: r.verdict, requestedQuantity: r.requestedQuantity, approvedQuantity: r.approvedQuantity, approvedNotional: r.approvedNotional, checks: r.checks, reasons: r.reasons, failedClosed: r.failedClosed, riskEngineVersion: r.riskEngineVersion, decidedAt: r.decidedAt };
}

/** Trade row as exposed by the API (tenant columns stripped). */
export function tradeView(t: TradeRow, strategyKey: string | null, thesis: ThesisRowLike | null | undefined) {
  return {
    id: t.id, mode: t.mode, symbol: t.symbol, strategyId: t.strategyId, strategyKey, strategyVersionId: t.strategyVersionId, thesisId: t.thesisId, candidateId: t.candidateId,
    state: t.state, direction: t.direction, entryQuantity: t.entryQuantity, openQuantity: t.openQuantity, averageEntryPrice: t.averageEntryPrice, averageExitPrice: t.averageExitPrice,
    realizedPnl: t.realizedPnl, fees: t.fees, returnPct: tradeReturnFraction(t), maxAdverseExcursionPct: t.maxAdverseExcursionPct, maxFavorableExcursionPct: t.maxFavorableExcursionPct,
    initialConfidence: t.initialConfidence, expectedEdge: t.expectedEdge, expectedDownsidePct: t.expectedDownsidePct, invalidationPrice: t.invalidationPrice, targetPrice: t.targetPrice,
    expectedHoldingDays: t.expectedHoldingDays, regimeAtEntry: t.regimeAtEntry, openedAt: t.openedAt, closedAt: t.closedAt, exitReason: t.exitReason, versions: t.versions,
    thesis: thesis ? thesisSummary(thesis) : null, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

/** Realised return of a trade as a FRACTION of entry notional; null when the entry is unknown. */
export function tradeReturnFraction(t: Pick<TradeRow, "realizedPnl" | "averageEntryPrice" | "entryQuantity" | "averageExitPrice" | "state">): number | null {
  if (t.averageEntryPrice && t.entryQuantity > 0 && t.state === "closed") {
    const basis = t.averageEntryPrice * t.entryQuantity;
    if (basis > 0) return t.realizedPnl / basis;
  }
  if (t.state === "closed" && t.averageEntryPrice && t.averageExitPrice) return t.averageExitPrice / t.averageEntryPrice - 1;
  return null;
}

export function holdingDays(t: Pick<TradeRow, "openedAt" | "closedAt">, now: Date): number | null {
  if (!t.openedAt) return null;
  const end = t.closedAt ? Date.parse(t.closedAt) : now.getTime();
  return Math.max(0, (end - Date.parse(t.openedAt)) / 86_400_000);
}

/** Deterministic plain-English explanation when the thesis carries none. */
export function tradeExplanation(t: TradeRow, thesis: TradeThesis | null, strategyKey: string | null): string {
  if (thesis?.plainEnglish) return thesis.plainEnglish;
  const parts: string[] = [];
  parts.push(`${t.mode === "shadow" ? "Shadow (simulated)" : "Live"} ${t.direction} trade in ${t.symbol}${strategyKey ? ` from strategy ${strategyKey}` : ""}.`);
  parts.push(`Entered with confidence ${(t.initialConfidence * 100).toFixed(0)}% and expected edge ${(t.expectedEdge * 100).toFixed(0)}% in a ${t.regimeAtEntry.replace(/_/g, " ")} regime; expected downside ${(t.expectedDownsidePct * 100).toFixed(1)}%.`);
  if (t.invalidationPrice != null) parts.push(`Invalidation at ${t.invalidationPrice.toFixed(2)}${t.targetPrice != null ? `, target ${t.targetPrice.toFixed(2)}` : ""}.`);
  if (t.state === "closed") parts.push(`Closed${t.exitReason ? ` (${t.exitReason})` : ""} with realised P&L ${t.realizedPnl.toFixed(2)}.`);
  else parts.push(`Current state: ${t.state.replace(/_/g, " ")} with ${t.openQuantity} open.`);
  return parts.join(" ");
}

export function quoteFreshnessAt(observedAt: string | null, reliability: number, now: Date): Freshness {
  return quoteQuality({ observedAt, reliability, marketOpen: marketSessionAt(now) === "regular" }, now.toISOString()).freshness;
}
