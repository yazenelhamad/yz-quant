import type { CompanyIntelligenceProfile, ExpectationsRecord } from "../types/index.js";
import { clip, isNum, mean, round } from "./math.js";
import { surpriseOfRecord } from "./surprise.js";

/**
 * Analyst memory: what we believed last time, whether we were right, and what changed.
 * Profiles are versioned; updates return a history entry so nothing is ever silently overwritten.
 */

export interface PriorThesesSummary {
  ticker: string;
  count: number;
  entries: CompanyIntelligenceProfile["previousTheses"];
  lastView: string | null;
  lastOutcome: string | null;
  lastDate: string | null;
  /** Share of resolved theses whose outcome string starts with "correct"/"right"/"win". Null when none resolved. */
  hitRate: number | null;
  resolved: number;
  whatChanged: string[];
  summary: string;
}

const POSITIVE_OUTCOME = /^(correct|right|win|won|good)/i;
const NEGATIVE_OUTCOME = /^(incorrect|wrong|loss|lost|bad|miss)/i;

export function priorTheses(profile: CompanyIntelligenceProfile | null, ticker: string): PriorThesesSummary {
  if (!profile || profile.ticker !== ticker || profile.previousTheses.length === 0) {
    return { ticker, count: 0, entries: [], lastView: null, lastOutcome: null, lastDate: null, hitRate: null, resolved: 0, whatChanged: [], summary: `No prior theses on ${ticker}: no memory to lean on, treat this as a first look.` };
  }
  const entries = [...profile.previousTheses].sort((a, b) => a.date.localeCompare(b.date));
  const last = entries[entries.length - 1]!;
  let wins = 0;
  let resolved = 0;
  for (const e of entries) {
    if (!e.outcome) continue;
    if (POSITIVE_OUTCOME.test(e.outcome)) {
      wins++;
      resolved++;
    } else if (NEGATIVE_OUTCOME.test(e.outcome)) resolved++;
  }
  const hitRate = resolved > 0 ? round(wins / resolved) : null;
  const whatChanged: string[] = [];
  for (const [k, v] of Object.entries(profile.internalExpectations)) {
    const c = profile.consensusExpectations[k];
    if (isNum(v) && isNum(c) && c !== 0) whatChanged.push(`${k}: internal ${v} vs consensus ${c} (${round(((v - c) / Math.abs(c)) * 100, 1)}%) as of ${profile.updatedAt}`);
  }
  if (profile.marketNarrative) whatChanged.push(`market narrative on record: ${clip(profile.marketNarrative, 200)}`);
  const summary = [
    `Last time (${last.date}) we believed: ${clip(last.view, 300)}.`,
    last.outcome ? `Outcome: ${clip(last.outcome, 200)}.` : "Outcome: unresolved.",
    hitRate !== null ? `Track record on ${ticker}: ${wins}/${resolved} resolved theses correct.` : `No resolved theses on ${ticker} yet.`,
    whatChanged.length > 0 ? `What was on record: ${whatChanged.join("; ")}.` : "No recorded expectations to compare.",
  ].join(" ");
  return { ticker, count: entries.length, entries, lastView: last.view, lastOutcome: last.outcome, lastDate: last.date, hitRate, resolved, whatChanged, summary };
}

export interface ProfileHistoryEntry {
  ticker: string;
  fromVersion: number;
  toVersion: number;
  at: string;
  changedFields: string[];
  before: Partial<CompanyIntelligenceProfile> | null;
  after: Partial<CompanyIntelligenceProfile>;
}

export type ProfileUpdates = Partial<Omit<CompanyIntelligenceProfile, "ticker" | "updatedAt" | "version">>;

export function emptyCompanyProfile(ticker: string, name: string, now: string): CompanyIntelligenceProfile {
  return {
    ticker,
    name,
    sector: null,
    industry: null,
    businessModel: "",
    revenueDrivers: [],
    costDrivers: [],
    keyKpis: [],
    industryStructure: "",
    competitors: [],
    managementHistory: "",
    guidanceAccuracy: { beats: 0, misses: 0, inline: 0, avgSurprisePct: null },
    earningsBehaviour: { avgMovePct: null, avgImpliedMovePct: null, beatReactionPct: null, missReactionPct: null },
    valuationHistory: { peRange: null, evSalesRange: null },
    majorCatalysts: [],
    majorRisks: [],
    marketNarrative: "",
    consensusExpectations: {},
    internalExpectations: {},
    previousTheses: [],
    commonMoveReasons: [],
    updatedAt: now,
    version: 0,
  };
}

/**
 * Versioned profile update. `previousTheses` is append-only: entries in `updates.previousTheses`
 * are merged by thesisId (outcome may be filled in) and never removed.
 */
export function updateCompanyProfile(prev: CompanyIntelligenceProfile | null, updates: ProfileUpdates & { ticker?: string; name?: string }, now: string): { profile: CompanyIntelligenceProfile; historyEntry: ProfileHistoryEntry } {
  const base = prev ?? emptyCompanyProfile(updates.ticker ?? "", updates.name ?? updates.ticker ?? "", now);
  const changedFields: string[] = [];
  const before: Partial<CompanyIntelligenceProfile> = {};
  const after: Partial<CompanyIntelligenceProfile> = {};
  const next: CompanyIntelligenceProfile = { ...base, previousTheses: [...base.previousTheses] };

  for (const [key, value] of Object.entries(updates) as [keyof ProfileUpdates | "ticker" | "name", unknown][]) {
    if (value === undefined || key === "ticker") continue;
    if (key === "previousTheses") {
      const incoming = value as CompanyIntelligenceProfile["previousTheses"];
      const merged = [...next.previousTheses];
      let changed = false;
      for (const t of incoming) {
        const idx = merged.findIndex((m) => m.thesisId === t.thesisId);
        if (idx === -1) {
          merged.push({ ...t });
          changed = true;
        } else if (merged[idx]!.outcome !== t.outcome || merged[idx]!.view !== t.view) {
          merged[idx] = { ...merged[idx]!, outcome: t.outcome ?? merged[idx]!.outcome, view: merged[idx]!.view };
          changed = true;
        }
      }
      if (changed) {
        before.previousTheses = base.previousTheses;
        after.previousTheses = merged;
        next.previousTheses = merged;
        changedFields.push("previousTheses");
      }
      continue;
    }
    const prevValue = (base as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(prevValue) === JSON.stringify(value)) continue;
    (before as Record<string, unknown>)[key] = prevValue;
    (after as Record<string, unknown>)[key] = value;
    (next as unknown as Record<string, unknown>)[key] = value;
    changedFields.push(key);
  }
  if (updates.ticker && !prev) next.ticker = updates.ticker;
  next.version = base.version + 1;
  next.updatedAt = now;
  return { profile: next, historyEntry: { ticker: next.ticker, fromVersion: base.version, toVersion: next.version, at: now, changedFields, before: prev ? before : null, after } };
}

const SURPRISE_TOLERANCE_PCT = 1;

/** Guidance accuracy from resolved expectations records (metric defaults to eps). */
export function updateGuidanceAccuracy(records: readonly ExpectationsRecord[], metric = "eps"): CompanyIntelligenceProfile["guidanceAccuracy"] {
  let beats = 0;
  let misses = 0;
  let inline = 0;
  const surprises: number[] = [];
  for (const r of records) {
    const s = surpriseOfRecord(r, metric);
    if (s === null) continue;
    surprises.push(s);
    if (s > SURPRISE_TOLERANCE_PCT) beats++;
    else if (s < -SURPRISE_TOLERANCE_PCT) misses++;
    else inline++;
  }
  const avg = mean(surprises);
  return { beats, misses, inline, avgSurprisePct: avg === null ? null : round(avg, 2) };
}

/** Earnings behaviour from resolved expectations records. */
export function updateEarningsBehaviour(records: readonly ExpectationsRecord[], metric = "eps"): CompanyIntelligenceProfile["earningsBehaviour"] {
  const moves: number[] = [];
  const implied: number[] = [];
  const beatReactions: number[] = [];
  const missReactions: number[] = [];
  for (const r of records) {
    if (isNum(r.reactionPct)) moves.push(Math.abs(r.reactionPct));
    if (isNum(r.optionsImpliedMovePct)) implied.push(Math.abs(r.optionsImpliedMovePct));
    const s = surpriseOfRecord(r, metric);
    if (s === null || !isNum(r.reactionPct)) continue;
    if (s > SURPRISE_TOLERANCE_PCT) beatReactions.push(r.reactionPct);
    else if (s < -SURPRISE_TOLERANCE_PCT) missReactions.push(r.reactionPct);
  }
  const r2 = (v: number | null) => (v === null ? null : round(v, 2));
  return { avgMovePct: r2(mean(moves)), avgImpliedMovePct: r2(mean(implied)), beatReactionPct: r2(mean(beatReactions)), missReactionPct: r2(mean(missReactions)) };
}

/** Convenience: fold resolved records into a profile as a versioned update. */
export function applyExpectationsRecords(profile: CompanyIntelligenceProfile, records: readonly ExpectationsRecord[], now: string, metric = "eps"): { profile: CompanyIntelligenceProfile; historyEntry: ProfileHistoryEntry } {
  const own = records.filter((r) => r.ticker === profile.ticker);
  return updateCompanyProfile(profile, { guidanceAccuracy: updateGuidanceAccuracy(own, metric), earningsBehaviour: updateEarningsBehaviour(own, metric) }, now);
}
