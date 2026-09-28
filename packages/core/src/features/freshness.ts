import type { Bar, BarInterval, Freshness, IsoTimestamp } from "../types/index.js";

/** Seconds per bar interval. */
export const INTERVAL_SECONDS: Readonly<Record<BarInterval, number>> = {
  minute: 60,
  "5minute": 300,
  "10minute": 600,
  "15minute": 900,
  "30minute": 1800,
  hour: 3600,
  "4hour": 14_400,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
};

export function parseTime(iso: IsoTimestamp): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Number of weekdays strictly after `from` up to and including the calendar day of `to`
 * (UTC dates). A cheap trading-day approximation: no holiday calendar (pure, no I/O).
 */
export function weekdaysBetween(from: IsoTimestamp, to: IsoTimestamp): number | null {
  const a = parseTime(from);
  const b = parseTime(to);
  if (a === null || b === null) return null;
  if (b <= a) return 0;
  const start = new Date(a);
  const end = new Date(b);
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  let count = 0;
  for (let d = startDay + 86_400_000; d <= endDay; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/**
 * Bars usable at `asOf`: strictly at or before asOf, non-interpolated, ascending by time.
 * Look-ahead protection lives here; every consumer goes through it.
 */
export function usableBars(bars: readonly Bar[] | null | undefined, asOf: IsoTimestamp): Bar[] {
  if (!bars || bars.length === 0) return [];
  const cutoff = parseTime(asOf);
  if (cutoff === null) return [];
  const out: Bar[] = [];
  for (const b of bars) {
    if (b.interpolated) continue;
    const t = parseTime(b.time);
    if (t === null || t > cutoff) continue;
    if (!Number.isFinite(b.close) || !Number.isFinite(b.open) || !Number.isFinite(b.high) || !Number.isFinite(b.low)) continue;
    out.push(b);
  }
  out.sort((x, y) => (parseTime(x.time) as number) - (parseTime(y.time) as number));
  return out;
}

/**
 * Freshness of a bar series at `asOf`.
 * - daily/weekly/monthly bars: fresh when the last bar is within 2 weekdays, aging within 5, else stale.
 * - intraday bars: fresh within 3 intervals, aging within 12 intervals, else stale.
 * - no bars (or unparsable times): unknown.
 */
export function barFreshness(bars: readonly Bar[], asOf: IsoTimestamp): Freshness {
  const lastBar = bars.length > 0 ? bars[bars.length - 1] : undefined;
  if (!lastBar) return "unknown";
  const asOfMs = parseTime(asOf);
  const lastMs = parseTime(lastBar.time);
  if (asOfMs === null || lastMs === null) return "unknown";
  if (lastMs > asOfMs) return "unknown";
  const interval = lastBar.interval;
  if (interval === "day" || interval === "week" || interval === "month") {
    const days = weekdaysBetween(lastBar.time, asOf);
    if (days === null) return "unknown";
    const multiplier = interval === "day" ? 1 : interval === "week" ? 5 : 22;
    if (days <= 2 * multiplier) return "fresh";
    if (days <= 5 * multiplier) return "aging";
    return "stale";
  }
  const ageSec = (asOfMs - lastMs) / 1000;
  const step = INTERVAL_SECONDS[interval];
  if (ageSec <= 3 * step) return "fresh";
  if (ageSec <= 12 * step) return "aging";
  return "stale";
}

/** Freshness of a quote by last trade time; unknown when there is no timestamp. */
export function quoteFreshness(lastTradeAt: IsoTimestamp | null | undefined, asOf: IsoTimestamp, session: "regular" | "pre" | "post" | "overnight" | "unknown" = "regular"): Freshness {
  if (!lastTradeAt) return "unknown";
  const a = parseTime(lastTradeAt);
  const b = parseTime(asOf);
  if (a === null || b === null) return "unknown";
  const ageSec = (b - a) / 1000;
  if (ageSec < -60) return "unknown";
  const freshLimit = session === "regular" ? 120 : 900;
  const agingLimit = session === "regular" ? 900 : 3600;
  if (ageSec <= freshLimit) return "fresh";
  if (ageSec <= agingLimit) return "aging";
  return "stale";
}

export const FRESHNESS_RANK: Readonly<Record<Freshness, number>> = { fresh: 3, aging: 2, stale: 1, unknown: 0 };

/** The worse of two freshness values. */
export function worstFreshness(a: Freshness, b: Freshness): Freshness {
  return FRESHNESS_RANK[a] <= FRESHNESS_RANK[b] ? a : b;
}

/** Multiplicative data-quality factor used by the ensemble and fast brain. */
export function freshnessFactor(f: Freshness): number {
  switch (f) {
    case "fresh": return 1;
    case "aging": return 0.7;
    case "stale": return 0;
    case "unknown": return 0;
    default: return 0;
  }
}
