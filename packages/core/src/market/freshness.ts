import type { DataQuality, Freshness, IsoTimestamp } from "../types/index.js";

export interface FreshnessPolicy {
  /** Seconds after which a quote is "aging" / "stale". */
  quoteAgingSeconds: number;
  quoteStaleSeconds: number;
  /** Trading days after which daily bars are aging / stale. */
  barsAgingDays: number;
  barsStaleDays: number;
  regimeAgingMinutes: number;
  regimeStaleMinutes: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  quoteAgingSeconds: 45,
  quoteStaleSeconds: 90,
  barsAgingDays: 1,
  barsStaleDays: 3,
  regimeAgingMinutes: 60,
  regimeStaleMinutes: 24 * 60,
};

export function ageSeconds(observedAt: IsoTimestamp | null | undefined, now: IsoTimestamp): number | null {
  if (!observedAt) return null;
  const a = new Date(observedAt).getTime();
  const b = new Date(now).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, (b - a) / 1000);
}

export function classifyAge(age: number | null, agingLimit: number, staleLimit: number): Freshness {
  if (age === null) return "unknown";
  if (age <= agingLimit) return "fresh";
  if (age <= staleLimit) return "aging";
  return "stale";
}

export function quoteQuality(input: { observedAt: IsoTimestamp | null; reliability: number; marketOpen: boolean; contradictory?: boolean; notes?: string[] }, now: IsoTimestamp, policy = DEFAULT_FRESHNESS_POLICY): DataQuality {
  const age = ageSeconds(input.observedAt, now);
  // Outside regular hours a frozen last print is expected: we relax the thresholds but still report age.
  const factor = input.marketOpen ? 1 : 60;
  const freshness = classifyAge(age, policy.quoteAgingSeconds * factor, policy.quoteStaleSeconds * factor);
  return { freshness, ageSeconds: age, reliability: input.reliability, contradictory: !!input.contradictory, notes: input.notes ?? [] };
}

export function worstFreshness(...items: Freshness[]): Freshness {
  const rank: Record<Freshness, number> = { fresh: 0, aging: 1, unknown: 2, stale: 3 };
  return items.reduce((w, f) => (rank[f] > rank[w] ? f : w), "fresh" as Freshness);
}

/** New entries require every critical input to be at least "aging"; "stale"/"unknown" blocks. */
export function entriesAllowed(...items: Freshness[]): { allowed: boolean; reason: string | null } {
  const worst = worstFreshness(...items);
  if (worst === "stale") return { allowed: false, reason: "critical market data is stale" };
  if (worst === "unknown") return { allowed: false, reason: "critical market data has unknown freshness" };
  return { allowed: true, reason: null };
}
