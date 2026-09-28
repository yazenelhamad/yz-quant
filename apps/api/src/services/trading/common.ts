import type { Bar, BarInterval, Freshness, Quote, RegimeAssessment, RegimeLabel, StrategyStage, TenantScope } from "@yz/core";
import { DEFAULT_FRESHNESS_POLICY, STRATEGY_STAGE_ORDER, ageSeconds, classifyAge, marketCalendarDay, newYorkDate, unknownRegime } from "@yz/core";

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const scopeKeyOf = (s: TenantScope): string => `${s.userId}/${s.brokerAccountId}`;

export function rowToBar(r: { symbol: string; interval: string; time: string; open: number; high: number; low: number; close: number; volume: number; interpolated: boolean; adjusted: string; source: string; receivedAt: string }): Bar {
  return { symbol: r.symbol, interval: r.interval as BarInterval, time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, interpolated: r.interpolated, adjusted: r.adjusted as Bar["adjusted"], provenance: { source: r.source, observedAt: r.time, receivedAt: r.receivedAt, reliability: 1 } };
}

export function rowToQuote(r: { symbol: string; last: number; bid: number | null; ask: number | null; previousClose: number | null; lastTradeAt: string | null; session: string; instrumentState: string; source: string; observedAt: string; receivedAt: string; reliability: number }): Quote {
  return { symbol: r.symbol, last: r.last, bid: r.bid, ask: r.ask, previousClose: r.previousClose, lastTradeAt: r.lastTradeAt, session: r.session as Quote["session"], instrumentState: r.instrumentState as Quote["instrumentState"], provenance: { source: r.source, observedAt: r.observedAt, receivedAt: r.receivedAt, reliability: r.reliability } };
}

export interface RegimeRowLike {
  asOf: string;
  primary: string;
  probabilities: Record<string, number>;
  confidence: number;
  abnormality: number;
  metrics: unknown;
  familyBias: Record<string, number>;
  explanation: string[];
  dataQuality: string;
}

/** Freshness of a regime row at `now` (age based, using the shared freshness policy). */
export function regimeFreshness(row: RegimeRowLike | null | undefined, nowIso: string): Freshness {
  if (!row) return "unknown";
  const age = ageSeconds(row.asOf, nowIso);
  const byAge = classifyAge(age, DEFAULT_FRESHNESS_POLICY.regimeAgingMinutes * 60, DEFAULT_FRESHNESS_POLICY.regimeStaleMinutes * 60);
  const stored = row.dataQuality as Freshness;
  const rank: Record<Freshness, number> = { fresh: 0, aging: 1, unknown: 2, stale: 3 };
  return rank[stored] > rank[byAge] ? stored : byAge;
}

/** Map a `market_regimes` row to the core `RegimeAssessment`; a missing row fails closed to the unknown regime. */
export function regimeFromRow(row: RegimeRowLike | null | undefined, nowIso: string): RegimeAssessment {
  if (!row) return unknownRegime(nowIso);
  const m = (row.metrics && typeof row.metrics === "object" ? row.metrics : {}) as Partial<RegimeAssessment["metrics"]>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    asOf: row.asOf,
    primary: row.primary as RegimeLabel,
    probabilities: row.probabilities as Partial<Record<RegimeLabel, number>>,
    confidence: row.confidence,
    abnormality: row.abnormality,
    metrics: {
      spyTrend20: num(m.spyTrend20), spyTrend100: num(m.spyTrend100), realizedVol20: num(m.realizedVol20), vix: num(m.vix), breadthPctAbove50: num(m.breadthPctAbove50),
      avgPairwiseCorrelation: num(m.avgPairwiseCorrelation), sectorDispersion: num(m.sectorDispersion), momentumPersistence: num(m.momentumPersistence), meanReversionScore: num(m.meanReversionScore), volumeRatio: num(m.volumeRatio),
    },
    familyBias: row.familyBias ?? {},
    explanation: row.explanation ?? [],
    dataQuality: regimeFreshness(row, nowIso),
  };
}

/** Daily-bar freshness by weekday age of the latest bar (fresh <= 2 weekdays, aging <= 5, else stale). */
export function dailyBarFreshness(latestBarTime: string | null, nowIso: string): Freshness {
  if (!latestBarTime) return "unknown";
  const a = Date.parse(latestBarTime);
  const b = Date.parse(nowIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b + 86_400_000) return "unknown";
  let count = 0;
  const startDay = Date.UTC(new Date(a).getUTCFullYear(), new Date(a).getUTCMonth(), new Date(a).getUTCDate());
  const endDay = Date.UTC(new Date(b).getUTCFullYear(), new Date(b).getUTCMonth(), new Date(b).getUTCDate());
  for (let d = startDay + 86_400_000; d <= endDay; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  if (count <= 2) return "fresh";
  if (count <= 5) return "aging";
  return "stale";
}

export function stageRank(stage: string): number {
  return STRATEGY_STAGE_ORDER.indexOf(stage as StrategyStage);
}

export const LIVE_STAGES: ReadonlySet<string> = new Set(["limited_live", "live"]);
export const SHADOW_OR_LIVE_STAGES: ReadonlySet<string> = new Set(["live_shadow", "limited_live", "live"]);

/** Regular close of the next NYSE trading day strictly after `at` (candidate expiry). */
export function nextTradingDayClose(at: Date): string {
  let cursor = new Date(at.getTime());
  for (let i = 0; i < 10; i += 1) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const day = marketCalendarDay(newYorkDate(cursor));
    if (day.isTradingDay && day.regularClose) return day.regularClose;
  }
  return new Date(at.getTime() + 86_400_000).toISOString();
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function numOrNull(x: unknown): number | null {
  return isFiniteNumber(x) ? x : null;
}

export function utcDayStart(at: Date): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function utcWeekStart(at: Date): Date {
  const d = utcDayStart(at);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
