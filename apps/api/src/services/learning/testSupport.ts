/** Test-only helpers for the learning & research plane (synthetic bars are allowed only here). */
import type { TenantScope } from "@yz/core";
import type { Repos } from "../../http/app.js";

export const DAY = 86_400_000;

/** Deterministic weekday timestamps ending at `end`, count bars back. */
export function weekdaysEndingAt(end: string, count: number): string[] {
  const out: string[] = [];
  let t = Date.parse(end);
  while (out.length < count) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21)).toISOString());
    t -= DAY;
  }
  return out.reverse();
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Synthetic daily bars with a gentle drift (tests only; production never fabricates bars). */
export function syntheticBarRows(symbol: string, times: string[], opts: { start?: number; drift?: number; vol?: number; seed?: number } = {}) {
  const rng = mulberry(opts.seed ?? 7);
  let close = opts.start ?? 100;
  const drift = opts.drift ?? 0.0006;
  const vol = opts.vol ?? 0.01;
  return times.map((time) => {
    const open = close;
    close = Math.max(1, close * (1 + drift + vol * (rng() * 2 - 1)));
    const high = Math.max(open, close) * (1 + 0.003 * rng());
    const low = Math.min(open, close) * (1 - 0.003 * rng());
    return { symbol, interval: "day", time, open, high, low, close, volume: 1_000_000 + Math.floor(rng() * 500_000), interpolated: false, adjusted: "split", source: "test", receivedAt: time };
  });
}

export async function storeSyntheticBars(repos: Repos, symbol: string, times: string[], opts: Parameters<typeof syntheticBarRows>[2] = {}): Promise<void> {
  await repos.market.upsertBars(syntheticBarRows(symbol, times, opts));
}

export interface ClosedTradeFixture { tradeId: string; thesisId: string }

/** A closed long trade with thesis, order, execution outcome, features and regime rows in ONE scope. */
export async function seedClosedTrade(repos: Repos, scope: TenantScope, input: { strategyId: string; strategyKey: string; symbol: string; openedAt: string; closedAt: string; entry: number; exit: number; confidence?: number; mode?: "live" | "shadow"; candidateId?: string | null }): Promise<ClosedTradeFixture> {
  const trade = await repos.trades.create(scope, {
    mode: input.mode ?? "shadow", symbol: input.symbol, strategyId: input.strategyId, state: "closed", entryQuantity: 10, openQuantity: 0, averageEntryPrice: input.entry, averageExitPrice: input.exit,
    realizedPnl: (input.exit - input.entry) * 10, fees: 0, maxAdverseExcursionPct: -1, maxFavorableExcursionPct: Math.max(0, (input.exit / input.entry - 1) * 100 + 1),
    initialConfidence: input.confidence ?? 0.7, expectedEdge: 0.3, expectedDownsidePct: 3, expectedHoldingDays: 10, regimeAtEntry: "bull_trend", openedAt: input.openedAt, closedAt: input.closedAt, exitReason: input.exit >= input.entry ? "target" : "invalidation",
    candidateId: input.candidateId ?? null,
  });
  const thesisId = await repos.theses.create(scope, {
    tradeId: trade.id, symbol: input.symbol, strategyId: input.strategyId, direction: "long", expectedEdge: 0.3, confidence: input.confidence ?? 0.7, calibratedConfidence: 0.65, marketRegime: "bull_trend", status: "closed",
    thesis: { strategyKey: input.strategyKey, expectedHoldingPeriodDays: 10, expectedUpsidePct: 6, expectedDownsidePct: 3, invalidationPrice: input.entry * 0.97, targetPrice: input.entry * 1.06, exitConditions: ["target", "invalidation"], portfolioImpact: { sector: "tech" } },
    modelName: "test", modelVersion: "1", promptVersion: "1",
  });
  const order = await repos.orders.create(scope, { refId: `ref-${trade.id}`, tradeId: trade.id, accountNumber: "SIM", symbol: input.symbol, side: "buy", type: "limit", quantity: 10, limitPrice: input.entry, mode: input.mode ?? "shadow", state: "filled" });
  await repos.executionOutcomes.record(scope, { orderId: order.id, brokerOrderId: null, symbol: input.symbol, side: "buy", expectedPrice: input.entry, arrivalPrice: input.entry, fillPrice: input.entry * 1.0003, expectedSlippageBps: 5, actualSlippageBps: 3, timeToFillSeconds: 20, partial: false, missed: false, reprices: 0, cancelled: false, liquidityBucket: "high", session: "regular", mode: input.mode ?? "shadow", at: input.openedAt });
  await repos.market.upsertFeatures({ symbol: input.symbol, asOf: input.openedAt, featureVersion: "feat-test", values: { momentum_20: 0.04, realized_vol_20: 0.2, liquidity_score: 0.8, rsi_14: 60, spread_bps: 4 }, freshness: "fresh" });
  return { tradeId: trade.id, thesisId };
}
