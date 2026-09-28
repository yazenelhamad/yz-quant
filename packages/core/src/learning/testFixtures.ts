/** Test-only fixture builders for the learning engine. Not exported from the package barrel. */
import type { ExecutionOutcome, PostTradeReview, RejectedTrade, TenantScope, TradeMemoryEntry, TradeRecord } from "../types/index.js";
import type { ThesisSummary } from "./postTradeReview.js";

export const SCOPE_A: TenantScope = { userId: "user-a", brokerAccountId: "acct-a" };
export const SCOPE_B: TenantScope = { userId: "user-b", brokerAccountId: "acct-b" };
export const NOW = "2026-09-28T15:00:00.000Z";

export function isoDaysAgo(days: number, from: string = NOW): string {
  return new Date(Date.parse(from) - days * 86_400_000).toISOString();
}

/** Deterministic pseudo-random generator (mulberry32) so tests never depend on Math.random. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeTrade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "trade-1",
    scope: SCOPE_A,
    mode: "live",
    symbol: "AAPL",
    strategyId: "strat-1",
    strategyVersionId: "sv-1",
    thesisId: "thesis-1",
    state: "closed",
    direction: "long",
    entryQuantity: 10,
    openQuantity: 0,
    averageEntryPrice: 100,
    averageExitPrice: 104,
    realizedPnl: 40,
    fees: 0,
    maxAdverseExcursionPct: -1,
    maxFavorableExcursionPct: 5,
    initialConfidence: 0.7,
    expectedEdge: 0.3,
    expectedDownsidePct: 3,
    regimeAtEntry: "bull_trend",
    openedAt: isoDaysAgo(10),
    closedAt: isoDaysAgo(2),
    exitReason: "target",
    createdAt: isoDaysAgo(10),
    updatedAt: isoDaysAgo(2),
    ...over,
  };
}

export function makeMemory(over: Partial<TradeMemoryEntry> = {}): TradeMemoryEntry {
  return {
    tradeId: "trade-1",
    scope: SCOPE_A,
    mode: "live",
    symbol: "AAPL",
    sector: "tech",
    strategyKey: "xs_momentum",
    regime: "bull_trend",
    signals: { momentum_12_1: 0.6, vwap_zscore: -0.2 },
    features: { momentum_20: 0.05, realized_vol_20: 0.2, liquidity_score: 0.8, breadth: 0.55 },
    entryPrice: 100,
    exitPrice: 104,
    holdingDays: 8,
    positionPct: 0.05,
    confidence: 0.7,
    expectedEdge: 0.3,
    predictedDownsidePct: 3,
    actualReturnPct: 4,
    maePct: -1,
    mfePct: 5,
    slippageBps: 4,
    executionQuality: 1,
    exitReason: "target",
    reviewClassification: null,
    lessons: [],
    openedAt: isoDaysAgo(10),
    closedAt: isoDaysAgo(2),
    ...over,
  };
}

export function makeThesis(over: Partial<ThesisSummary> = {}): ThesisSummary {
  return {
    expectedEdge: 0.3,
    confidence: 0.7,
    expectedHoldingDays: 10,
    expectedUpsidePct: 6,
    expectedDownsidePct: 3,
    invalidationPrice: 97,
    targetPrice: 106,
    exitConditions: ["target reached", "invalidation", "time stop 20 days"],
    ...over,
  };
}

export function makeOutcome(over: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return {
    scope: SCOPE_A,
    brokerOrderId: "ord-1",
    symbol: "AAPL",
    side: "buy",
    expectedPrice: 100,
    arrivalPrice: 100,
    fillPrice: 100.04,
    expectedSlippageBps: 5,
    actualSlippageBps: 4,
    timeToFillSeconds: 12,
    partial: false,
    missed: false,
    reprices: 0,
    cancelled: false,
    liquidityBucket: "high",
    session: "regular",
    at: isoDaysAgo(10),
    ...over,
  };
}

export function makeReview(over: Partial<PostTradeReview> = {}): PostTradeReview {
  return {
    id: "review-1",
    scope: SCOPE_A,
    tradeId: "trade-1",
    thesisCorrect: true,
    timingCorrect: true,
    sizingCorrect: true,
    executionEfficient: true,
    strategyBehavedAsIntended: true,
    confidenceCalibrated: true,
    signalsHelped: ["momentum_12_1"],
    signalsHurt: [],
    wouldTakeAgain: true,
    classification: "good_win",
    returnPct: 4,
    expectedEdge: 0.3,
    initialConfidence: 0.7,
    maePct: -1,
    mfePct: 5,
    slippageBps: 4,
    regimeAtEntry: "bull_trend",
    regimeAtExit: "bull_trend",
    narrative: "ok",
    reviewedAt: NOW,
    reviewerVersion: "review-1.0.0",
    ...over,
  };
}

export function makeRejected(over: Partial<RejectedTrade> = {}): RejectedTrade {
  return {
    id: "rej-1",
    scope: SCOPE_A,
    candidateId: "cand-1",
    symbol: "MSFT",
    strategyId: "strat-1",
    reasons: ["insufficient_confidence"],
    detail: "confidence 0.55 < 0.6",
    expectedEdge: 0.2,
    confidence: 0.55,
    regime: "bull_trend",
    priceAtRejection: 100,
    rejectedAt: isoDaysAgo(25),
    subsequentReturnPct: null,
    reviewVerdict: null,
    ...over,
  };
}

export interface SeriesOptions {
  n: number;
  meanPct: number;
  sdPct: number;
  seed?: number;
  scope?: TenantScope;
  strategyKey?: string;
  regime?: string | ((i: number) => string);
  mode?: "live" | "shadow";
  confidence?: number | ((i: number) => number);
  holdingDays?: number;
  /** Oldest trade closed this many days ago; trades are spread evenly until 1 day ago. */
  spanDays?: number;
  /** Optional transform on the generated return by index (e.g. to make the tail deteriorate). */
  returnShift?: (i: number, n: number) => number;
}

/** Generates a chronological memory series with approximately normal returns (Box-Muller). */
export function makeSeries(opts: SeriesOptions): TradeMemoryEntry[] {
  const r = rng(opts.seed ?? 1);
  const span = opts.spanDays ?? 180;
  const out: TradeMemoryEntry[] = [];
  for (let i = 0; i < opts.n; i++) {
    const u1 = Math.max(r(), 1e-12);
    const u2 = r();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ret = opts.meanPct + opts.sdPct * z + (opts.returnShift ? opts.returnShift(i, opts.n) : 0);
    const closedDaysAgo = span - (i / Math.max(opts.n - 1, 1)) * (span - 1);
    const holding = opts.holdingDays ?? 5;
    const confidence = typeof opts.confidence === "function" ? opts.confidence(i) : opts.confidence ?? 0.7;
    const regime = typeof opts.regime === "function" ? opts.regime(i) : opts.regime ?? "bull_trend";
    out.push(makeMemory({
      tradeId: `${opts.strategyKey ?? "xs_momentum"}-${opts.scope?.userId ?? "user-a"}-${i}`,
      scope: opts.scope ?? SCOPE_A,
      mode: opts.mode ?? "live",
      strategyKey: opts.strategyKey ?? "xs_momentum",
      regime,
      confidence,
      holdingDays: holding,
      actualReturnPct: Math.round(ret * 100) / 100,
      exitPrice: 100 * (1 + ret / 100),
      maePct: -Math.abs(Math.min(ret, 0)) - 0.5,
      mfePct: Math.max(ret, 0) + 0.5,
      openedAt: isoDaysAgo(closedDaysAgo + holding),
      closedAt: isoDaysAgo(closedDaysAgo),
      features: { momentum_20: 0.02 + 0.01 * z, realized_vol_20: 0.18 + 0.05 * r(), liquidity_score: 0.5 + 0.4 * r(), breadth: 0.5 + 0.2 * (r() - 0.5) },
      signals: { momentum_12_1: 0.3 + 0.5 * r(), vwap_zscore: -0.5 + r() },
    }));
  }
  return out;
}
