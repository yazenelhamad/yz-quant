import { STRATEGY_LIBRARY, type StrategyDescriptor } from "@yz/core";
import type { Database } from "@yz/db";
import { StrategyCatalogRepository } from "@yz/db";
import type { Repos } from "../../http/app.js";

export const SEED_VERSION = "1.0";

/** Families that start in research: options strategies need broker option support and a separate validation track. */
export const RESEARCH_ONLY_FAMILIES: ReadonlySet<string> = new Set(["options_volatility"]);

export function seedStage(descriptor: StrategyDescriptor): string {
  return RESEARCH_ONLY_FAMILIES.has(descriptor.family) ? "research" : "live_shadow";
}

export function descriptorDefaults(descriptor: StrategyDescriptor): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [k, spec] of Object.entries(descriptor.parameters)) out[k] = spec.default;
  return out;
}

/**
 * Idempotent strategy catalog seed: one `strategies` row per library strategy (unique key) and an
 * approved, deployed "1.0" version carrying the descriptor defaults. Existing rows are never changed
 * except to attach a missing current version, so it composes with the trading plane's own
 * `ensureStrategyRows` whichever runs first.
 */
export async function seedStrategies(repos: Pick<Repos, "sessionsDb"> | { db: Database } | Database): Promise<{ inserted: number; total: number }> {
  const db: Database = typeof (repos as Pick<Repos, "sessionsDb">).sessionsDb === "function"
    ? (repos as Pick<Repos, "sessionsDb">).sessionsDb()
    : (repos as { db?: Database }).db ?? (repos as Database);
  const catalog = new StrategyCatalogRepository(db);
  const now = new Date().toISOString();
  let inserted = 0;
  for (const strategy of STRATEGY_LIBRARY) {
    const d = strategy.descriptor;
    const before = await catalog.byKey(d.key);
    const row = before ?? await catalog.insertIfMissing({
      id: crypto.randomUUID(), key: d.key, name: d.name, family: d.family, description: d.description, visibility: "shared",
      supportedRegimes: [...d.supportedRegimes], stage: seedStage(d), currentVersionId: null, globallyDisabled: false,
    });
    if (!before) inserted += 1;
    if (!row.currentVersionId) {
      const versions = await catalog.versions(row.id);
      const v1 = versions.find((v) => v.version === SEED_VERSION) ?? await catalog.createVersion({
        id: crypto.randomUUID(), strategyId: row.id, version: SEED_VERSION, parameters: descriptorDefaults(d), changeSummary: "Initial library version",
        changeReason: "seed", proposedByKind: "human", proposedById: "system", approvalStatus: "approved", approvedBy: null, deployedAt: now,
        backtestResultId: null, outOfSampleResultId: null, walkForwardResultId: null, shadowResultSummary: null,
      });
      await catalog.update(row.id, { currentVersionId: v1.id });
    }
  }
  return { inserted, total: STRATEGY_LIBRARY.length };
}
