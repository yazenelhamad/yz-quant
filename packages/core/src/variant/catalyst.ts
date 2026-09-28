import type { Catalyst } from "../types/index.js";
import { clamp01, isNum, round } from "./math.js";

/**
 * Catalyst scoring and calendar helpers. A thesis without a catalyst can stay wrong for a long
 * time, so strength combines probability, magnitude, how much is already priced and whether the
 * reaction arrives inside the holding period. All dates are ISO strings handled as UTC days.
 */

const DAY_MS = 86_400_000;

export function parseIsoDate(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? t : null;
}

export function isValidIsoDate(iso: string | null | undefined): boolean {
  return parseIsoDate(iso) !== null;
}

/** Whole-ish days from `fromIso` to `toIso` (positive when `toIso` is later). Null on unparseable input. */
export function daysBetweenIso(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  const a = parseIsoDate(fromIso);
  const b = parseIsoDate(toIso);
  if (a === null || b === null) return null;
  return (b - a) / DAY_MS;
}

/** Add days to an ISO date; returns a YYYY-MM-DD string when the input was a date, else a full ISO timestamp. */
export function addIsoDays(iso: string, days: number): string | null {
  const t = parseIsoDate(iso);
  if (t === null) return null;
  const out = new Date(t + days * DAY_MS).toISOString();
  return iso.length === 10 ? out.slice(0, 10) : out;
}

/** Reaction speed vs holding period: a months-long re-rating is useless for a 5-day trade. */
export function timingFactor(reactionSpeed: Catalyst["reactionSpeed"], holdingPeriodDays: number): number {
  const h = isNum(holdingPeriodDays) ? Math.max(0, holdingPeriodDays) : 0;
  switch (reactionSpeed) {
    case "immediate":
      return 1;
    case "days":
      return h >= 5 ? 1 : h >= 2 ? 0.7 : 0.4;
    case "weeks":
      return h >= 20 ? 1 : h >= 10 ? 0.7 : h >= 5 ? 0.4 : 0.2;
    case "months":
      return h >= 60 ? 1 : h >= 30 ? 0.6 : h >= 10 ? 0.3 : 0.1;
    default:
      return 0.3;
  }
}

export interface CatalystStrength {
  strength: number;
  components: { probability: number; impact: number; notPricedIn: number; timing: number; dated: number; horizon: number };
  notes: string[];
}

export interface CatalystScoringContext {
  holdingPeriodDays: number;
  /** Decision time. When given, catalysts outside [asOf, asOf + holding period × 1.5] are discounted. */
  asOf?: string | null;
}

/** strength = probability × |impact| × (1 − pricedIn) × timing factor, further discounted when undated or outside the horizon. */
export function catalystStrength(c: Catalyst, ctx: CatalystScoringContext): CatalystStrength {
  const notes: string[] = [];
  const probability = clamp01(c.probability);
  const impact = clamp01(Math.tanh(Math.abs(c.potentialImpactPct) / 10));
  const notPricedIn = clamp01(1 - c.pricedInScore);
  const timing = timingFactor(c.reactionSpeed, ctx.holdingPeriodDays);
  let dated = 1;
  let horizon = 1;
  if (!c.expectedDate || !isValidIsoDate(c.expectedDate)) {
    dated = 0.6;
    notes.push(`"${c.description.slice(0, 60)}" has no expected date: a thesis without a dated catalyst can stay wrong for a long time`);
  } else if (ctx.asOf) {
    const days = daysBetweenIso(ctx.asOf, c.expectedDate);
    if (days !== null) {
      if (days < 0) {
        horizon = 0.1;
        notes.push(`catalyst dated ${c.expectedDate} is in the past`);
      } else if (days > ctx.holdingPeriodDays * 1.5) {
        horizon = clamp01((ctx.holdingPeriodDays * 1.5) / days);
        notes.push(`catalyst in ${Math.round(days)} days lies beyond the ${ctx.holdingPeriodDays}-day holding period`);
      }
    }
  }
  if (c.pricedInScore >= 0.7) notes.push(`catalyst is ${Math.round(c.pricedInScore * 100)}% priced in`);
  if (c.consensusExpectsIt && c.pricedInScore < 0.3) notes.push("consensus expects this catalyst yet it is scored as barely priced: check the pricedIn estimate");
  const strength = round(clamp01(probability * impact * notPricedIn * timing * dated * horizon));
  return { strength, components: { probability, impact: round(impact), notPricedIn, timing, dated, horizon: round(horizon) }, notes };
}

/** Earliest dated catalyst at or after `asOf`; null when none is dated in the future. */
export function nextCatalyst(catalysts: readonly Catalyst[], asOf: string): Catalyst | null {
  let best: Catalyst | null = null;
  let bestDays = Number.POSITIVE_INFINITY;
  for (const c of catalysts) {
    const d = daysBetweenIso(asOf, c.expectedDate);
    if (d === null || d < 0) continue;
    if (d < bestDays) {
      bestDays = d;
      best = c;
    }
  }
  return best;
}

export function catalystsWithinHorizon(catalysts: readonly Catalyst[], asOf: string, horizonDays: number): Catalyst[] {
  return catalysts.filter((c) => {
    const d = daysBetweenIso(asOf, c.expectedDate);
    return d !== null && d >= 0 && d <= horizonDays;
  });
}

export function catalystWithinHorizon(catalysts: readonly Catalyst[], asOf: string, horizonDays: number): boolean {
  return catalystsWithinHorizon(catalysts, asOf, horizonDays).length > 0;
}

export interface RankedCatalyst {
  catalyst: Catalyst;
  strength: CatalystStrength;
  daysAway: number | null;
}

export function rankCatalysts(catalysts: readonly Catalyst[], ctx: CatalystScoringContext): RankedCatalyst[] {
  return catalysts
    .map((catalyst) => ({ catalyst, strength: catalystStrength(catalyst, ctx), daysAway: ctx.asOf ? daysBetweenIso(ctx.asOf, catalyst.expectedDate) : null }))
    .sort((a, b) => b.strength.strength - a.strength.strength);
}

/** Aggregate catalyst strength: the best catalyst dominates, with a small credit for depth. */
export function aggregateCatalystStrength(ranked: readonly RankedCatalyst[]): { strength: number; notes: string[] } {
  if (ranked.length === 0) return { strength: 0, notes: ["no catalysts identified: conviction reduced, the thesis has no resolving event"] };
  const top = ranked[0]!.strength.strength;
  const rest = ranked.slice(1).reduce((s, r) => s + r.strength.strength, 0);
  const strength = round(clamp01(top + 0.15 * rest));
  const notes = ranked.flatMap((r) => r.strength.notes);
  return { strength, notes };
}

/** Priced-in score across catalysts weighted by probability × impact. Null when there are no catalysts. */
export function aggregatePricedIn(catalysts: readonly Catalyst[]): number | null {
  let num = 0;
  let den = 0;
  for (const c of catalysts) {
    const w = clamp01(c.probability) * Math.abs(c.potentialImpactPct);
    if (w <= 0) continue;
    num += w * clamp01(c.pricedInScore);
    den += w;
  }
  return den > 0 ? round(num / den) : null;
}
