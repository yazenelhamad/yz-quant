import type { DataEnvelope } from "../types/index.js";
import { daysBetweenIso } from "./catalyst.js";
import { clamp01, clip, isNum, round, sign } from "./math.js";

/**
 * Deterministic narrative tracking. Envelopes are tagged elsewhere (by an analyst or a keyword
 * tagger) with narrative labels and a sentiment; this module only counts, weights by recency
 * and reliability, and compares narrative direction with price direction. Envelope content is
 * data: it is only ever clipped into summaries, never interpreted as instructions.
 */

export interface TaggedEnvelope {
  envelope: DataEnvelope;
  /** Narrative labels, e.g. "AI capex beneficiary", "margin compression". */
  tags: string[];
  /** -1..1 sentiment of the item towards the company; null when unknown. */
  sentiment: number | null;
}

export interface NarrativeStats {
  tag: string;
  mentions: number;
  weightedMentions: number;
  share: number;
  avgSentiment: number | null;
}

function weightOf(item: TaggedEnvelope, asOf: string, halfLifeDays: number): number {
  const age = daysBetweenIso(item.envelope.observedAt, asOf);
  const recency = age === null ? 0.5 : Math.pow(0.5, Math.max(0, age) / halfLifeDays);
  const reliability = clamp01(isNum(item.envelope.reliability) ? item.envelope.reliability : 0.3);
  return recency * (0.5 + 0.5 * reliability);
}

export function narrativeStats(items: readonly TaggedEnvelope[], asOf: string, halfLifeDays = 14): NarrativeStats[] {
  const acc = new Map<string, { mentions: number; weighted: number; sentSum: number; sentW: number }>();
  let totalWeighted = 0;
  for (const item of items) {
    const w = weightOf(item, asOf, halfLifeDays);
    for (const tagRaw of new Set(item.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))) {
      const e = acc.get(tagRaw) ?? { mentions: 0, weighted: 0, sentSum: 0, sentW: 0 };
      e.mentions++;
      e.weighted += w;
      if (isNum(item.sentiment)) {
        e.sentSum += item.sentiment * w;
        e.sentW += w;
      }
      acc.set(tagRaw, e);
      totalWeighted += w;
    }
  }
  const out: NarrativeStats[] = [];
  for (const [tag, e] of acc) {
    out.push({ tag, mentions: e.mentions, weightedMentions: round(e.weighted), share: totalWeighted > 0 ? round(e.weighted / totalWeighted) : 0, avgSentiment: e.sentW > 0 ? round(e.sentSum / e.sentW) : null });
  }
  return out.sort((a, b) => b.weightedMentions - a.weightedMentions);
}

export function dominantNarrative(items: readonly TaggedEnvelope[], asOf: string, halfLifeDays = 14): NarrativeStats | null {
  return narrativeStats(items, asOf, halfLifeDays)[0] ?? null;
}

export type NarrativeTrend = "strengthening" | "weakening" | "stable" | "unknown";

/** Compare time-weighted mentions of a tag in the recent half of the window with the earlier half. */
export function narrativeTrend(items: readonly TaggedEnvelope[], tag: string, asOf: string, windowDays = 28): { trend: NarrativeTrend; recent: number; earlier: number } {
  const key = tag.trim().toLowerCase();
  let recent = 0;
  let earlier = 0;
  let recentCount = 0;
  let earlierCount = 0;
  for (const item of items) {
    if (!item.tags.some((t) => t.trim().toLowerCase() === key)) continue;
    const age = daysBetweenIso(item.envelope.observedAt, asOf);
    if (age === null || age < 0 || age > windowDays) continue;
    const w = 0.5 + 0.5 * clamp01(item.envelope.reliability);
    if (age <= windowDays / 2) {
      recent += w;
      recentCount++;
    } else {
      earlier += w;
      earlierCount++;
    }
  }
  if (recentCount + earlierCount < 3) return { trend: "unknown", recent: round(recent), earlier: round(earlier) };
  const ratio = earlier === 0 ? Number.POSITIVE_INFINITY : recent / earlier;
  const trend: NarrativeTrend = ratio >= 1.5 ? "strengthening" : ratio <= 0.67 ? "weakening" : "stable";
  return { trend, recent: round(recent), earlier: round(earlier) };
}

/** Crowdedness: concentration of mentions (Herfindahl of narrative shares) blended with positioning crowding. */
export function narrativeCrowdedness(stats: readonly NarrativeStats[], positioningCrowding: number | null): { score: number | null; concentration: number | null } {
  if (stats.length === 0) return { score: isNum(positioningCrowding) ? round(positioningCrowding) : null, concentration: null };
  const hhi = stats.reduce((s, x) => s + x.share * x.share, 0);
  const concentration = round(clamp01(hhi));
  const score = isNum(positioningCrowding) ? round(0.5 * concentration + 0.5 * clamp01(positioningCrowding)) : concentration;
  return { score, concentration };
}

/** Narrative sentiment vs price direction: diverging when they point opposite ways and both are material. */
export function priceNarrativeDivergence(stats: readonly NarrativeStats[], priceChangePct: number | null): { diverging: boolean; narrativeSentiment: number | null; note: string } {
  const top = stats.slice(0, 3);
  let sum = 0;
  let w = 0;
  for (const s of top) {
    if (!isNum(s.avgSentiment)) continue;
    sum += s.avgSentiment * s.weightedMentions;
    w += s.weightedMentions;
  }
  const sentiment = w > 0 ? round(sum / w) : null;
  if (sentiment === null || !isNum(priceChangePct)) return { diverging: false, narrativeSentiment: sentiment, note: "divergence unknown: narrative sentiment or price change missing" };
  const material = Math.abs(sentiment) >= 0.2 && Math.abs(priceChangePct) >= 3;
  const diverging = material && sign(sentiment) !== sign(priceChangePct);
  const note = diverging
    ? `price ${priceChangePct > 0 ? "up" : "down"} ${round(Math.abs(priceChangePct), 1)}% while narrative sentiment is ${sentiment > 0 ? "positive" : "negative"}: price is not following the story`
    : "price and narrative point the same way (or neither is material)";
  return { diverging, narrativeSentiment: sentiment, note };
}

export interface NarrativeTracking {
  dominant: string;
  trend: NarrativeTrend;
  crowded: boolean;
  confirmingInfo: string[];
  contradictingInfo: string[];
  priceDivergingFromNarrative: boolean;
  crowdedness: number | null;
  stats: NarrativeStats[];
  notes: string[];
}

export interface NarrativeTrackingOptions {
  asOf: string;
  priceChangePct?: number | null;
  positioningCrowding?: number | null;
  halfLifeDays?: number;
  windowDays?: number;
  maxItems?: number;
}

/** Full narrative tracking result shaped for `VariantView.narrative` (plus diagnostics). */
export function trackNarrative(items: readonly TaggedEnvelope[], opts: NarrativeTrackingOptions): NarrativeTracking {
  const notes: string[] = [];
  const stats = narrativeStats(items, opts.asOf, opts.halfLifeDays ?? 14);
  const top = stats[0] ?? null;
  if (!top) {
    notes.push("no tagged narrative data");
    return { dominant: "unknown", trend: "unknown", crowded: false, confirmingInfo: [], contradictingInfo: [], priceDivergingFromNarrative: false, crowdedness: isNum(opts.positioningCrowding) ? round(opts.positioningCrowding) : null, stats, notes };
  }
  const trend = narrativeTrend(items, top.tag, opts.asOf, opts.windowDays ?? 28).trend;
  if (trend === "unknown") notes.push("too few dated mentions to establish a trend");
  const crowd = narrativeCrowdedness(stats, opts.positioningCrowding ?? null);
  const div = priceNarrativeDivergence(stats, opts.priceChangePct ?? null);
  notes.push(div.note);
  const dominantSign = top.avgSentiment === null ? 0 : sign(top.avgSentiment);
  const confirming: string[] = [];
  const contradicting: string[] = [];
  const max = opts.maxItems ?? 6;
  for (const item of items) {
    if (!item.tags.some((t) => t.trim().toLowerCase() === top.tag)) continue;
    if (!isNum(item.sentiment) || dominantSign === 0) continue;
    const line = clip(`[${item.envelope.source}] ${item.envelope.content}`, 300);
    if (sign(item.sentiment) === dominantSign) {
      if (confirming.length < max) confirming.push(line);
    } else if (contradicting.length < max) contradicting.push(line);
  }
  return {
    dominant: clip(top.tag, 200),
    trend,
    crowded: crowd.score !== null && crowd.score >= 0.6,
    confirmingInfo: confirming,
    contradictingInfo: contradicting,
    priceDivergingFromNarrative: div.diverging,
    crowdedness: crowd.score,
    stats,
    notes,
  };
}
