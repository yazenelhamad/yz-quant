import type { Evidence, VariantView } from "../types/index.js";
import { clamp01, clip, isNum, pctDiff, round } from "./math.js";

/**
 * Evidence hierarchy. Tier 1 is what the company signed under penalty, tier 9 is what someone
 * posted. Disagreements between sources are surfaced as structured records, never averaged away.
 */

export type SourceKind = Evidence["kind"];

export const EVIDENCE_TIERS: Record<SourceKind, number> = {
  filing: 1,
  market_data: 2,
  official_data: 3,
  guidance: 4,
  alt_data: 5,
  research: 6,
  analyst: 7,
  journalism: 8,
  social: 9,
  internal: 5,
  model: 7,
};

export const TIER_LABELS: Record<number, string> = {
  1: "regulatory filings",
  2: "verified market data",
  3: "official economic data",
  4: "company guidance",
  5: "reliable alternative data",
  6: "institutional research",
  7: "analyst estimates",
  8: "reputable journalism",
  9: "social / unverified",
};

export const TIER_RELIABILITY: Record<number, number> = { 1: 0.95, 2: 0.9, 3: 0.9, 4: 0.75, 5: 0.65, 6: 0.6, 7: 0.55, 8: 0.45, 9: 0.2 };

export function tierOf(sourceKind: SourceKind | string): number {
  const t = EVIDENCE_TIERS[sourceKind as SourceKind];
  return t ?? 9;
}

export function defaultReliability(sourceKind: SourceKind | string): number {
  return TIER_RELIABILITY[tierOf(sourceKind)] ?? 0.2;
}

export interface WeighedEvidence {
  /** 0..1 overall evidence quality: reliability-weighted, rewarding coverage of high tiers and penalising social-only support. */
  quality: number;
  weightedReliability: number | null;
  tierCoverage: number[];
  bestTier: number | null;
  count: number;
  ranked: (VariantView["evidence"][number] & { observedAt: string })[];
  notes: string[];
}

export function toViewEvidence(e: Evidence): VariantView["evidence"][number] {
  return { source: e.source, tier: tierOf(e.kind), summary: clip(e.summary, 400), reliability: clamp01(isNum(e.reliability) ? e.reliability : defaultReliability(e.kind)) };
}

export function weighEvidence(items: readonly Evidence[]): WeighedEvidence {
  const notes: string[] = [];
  if (items.length === 0) {
    notes.push("no evidence supplied: quality 0");
    return { quality: 0, weightedReliability: null, tierCoverage: [], bestTier: null, count: 0, ranked: [], notes };
  }
  const ranked = items.map((e) => ({ ...toViewEvidence(e), observedAt: e.observedAt })).sort((a, b) => a.tier - b.tier || b.reliability - a.reliability);
  const tiers = [...new Set(ranked.map((r) => r.tier))].sort((a, b) => a - b);
  const bestTier = tiers[0] ?? null;
  // Tier weight: tier 1 = 1.0 ... tier 9 = 0.2
  let num = 0;
  let den = 0;
  for (const r of ranked) {
    const w = 1 - (r.tier - 1) * 0.1;
    num += r.reliability * w;
    den += w;
  }
  const weightedReliability = den > 0 ? num / den : null;
  const coverage = clamp01(tiers.filter((t) => t <= 4).length / 3);
  const depth = 1 - Math.exp(-items.length / 4);
  let quality = 0.5 * (weightedReliability ?? 0) + 0.3 * coverage + 0.2 * depth;
  const socialOnly = tiers.every((t) => t >= 8);
  if (socialOnly) {
    quality = Math.min(quality, 0.3);
    notes.push("evidence rests only on journalism/social sources: quality capped at 0.3");
  }
  if (bestTier !== null && bestTier > 4) notes.push("no primary-source evidence (filings, market data, official data, guidance)");
  return { quality: round(clamp01(quality)), weightedReliability: weightedReliability === null ? null : round(weightedReliability), tierCoverage: tiers, bestTier, count: items.length, ranked, notes };
}

export interface SourceClaim {
  topic: string;
  source: string;
  kind: SourceKind | string;
  /** Numeric value when the claim is a number; otherwise a short categorical claim. */
  value: number | string | null;
  reliability?: number | null;
  observedAt?: string | null;
}

export type SourceDisagreement = VariantView["sourceDisagreements"][number] & { tierA: number; tierB: number; magnitudePct: number | null };

/** Detect disagreements between sources on the same topic. Numeric claims disagree beyond `tolerancePct`; categorical claims disagree when different. */
export function detectSourceDisagreement(claims: readonly SourceClaim[], tolerancePct = 5): SourceDisagreement[] {
  const byTopic = new Map<string, SourceClaim[]>();
  for (const c of claims) {
    const key = c.topic.trim().toLowerCase();
    const arr = byTopic.get(key) ?? [];
    arr.push(c);
    byTopic.set(key, arr);
  }
  const out: SourceDisagreement[] = [];
  for (const [, list] of byTopic) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.source === b.source) continue;
        if (a.value === null || b.value === null) continue;
        let disagree = false;
        let magnitudePct: number | null = null;
        if (typeof a.value === "number" && typeof b.value === "number") {
          const diff = pctDiff(a.value, b.value);
          magnitudePct = diff === null ? (a.value === b.value ? 0 : null) : round(Math.abs(diff), 2);
          disagree = magnitudePct === null ? a.value !== b.value : magnitudePct > tolerancePct;
        } else {
          disagree = String(a.value).trim().toLowerCase() !== String(b.value).trim().toLowerCase();
        }
        if (!disagree) continue;
        const tierA = tierOf(a.kind);
        const tierB = tierOf(b.kind);
        const relA = isNum(a.reliability) ? a.reliability : defaultReliability(a.kind);
        const relB = isNum(b.reliability) ? b.reliability : defaultReliability(b.kind);
        let moreReliable: string | null = null;
        let reason: string | null = null;
        if (tierA !== tierB) {
          moreReliable = tierA < tierB ? a.source : b.source;
          reason = `tier ${Math.min(tierA, tierB)} source outranks tier ${Math.max(tierA, tierB)}`;
        } else if (Math.abs(relA - relB) >= 0.15) {
          moreReliable = relA > relB ? a.source : b.source;
          reason = "same tier; higher stated reliability preferred";
        } else if (a.observedAt && b.observedAt && a.observedAt !== b.observedAt) {
          moreReliable = a.observedAt > b.observedAt ? a.source : b.source;
          reason = "same tier and reliability; more recent observation preferred";
        }
        const effect = moreReliable === null ? "unresolved disagreement: treat the datapoint as uncertain and reduce evidence quality" : `use ${moreReliable}; keep the disagreement visible in the thesis`;
        out.push({ topic: a.topic, sourceA: a.source, claimA: clip(String(a.value), 300), sourceB: b.source, claimB: clip(String(b.value), 300), reason, moreReliable, effectOnTrade: clip(effect, 300), tierA, tierB, magnitudePct });
      }
    }
  }
  return out;
}
