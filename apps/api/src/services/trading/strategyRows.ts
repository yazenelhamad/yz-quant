import { STRATEGY_LIBRARY, type StrategyDescriptor } from "@yz/core";
import type { Database } from "@yz/db";
import { TradingStore, type StrategyRecord } from "./store.js";

export const SEED_STRATEGY_VERSION = "1.0";
export const SEED_STRATEGY_STAGE = "live_shadow";

function defaultParameters(descriptor: StrategyDescriptor): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [k, spec] of Object.entries(descriptor.parameters)) out[k] = spec.default;
  return out;
}

/**
 * Make sure every strategy in `STRATEGY_LIBRARY` has a `strategies` row and a v1.0
 * `strategy_versions` row. Idempotent and safe to call from anywhere (candidate generation, the
 * learning service, routes, tests): existing rows are never modified except to attach a missing
 * `currentVersionId`. Rows are created at the global stage `live_shadow` so a freshly provisioned
 * system can shadow-trade but can never send a live order until a human promotes the strategy.
 */
export async function ensureStrategyRows(db: Database): Promise<Map<string, StrategyRecord>> {
  const store = new TradingStore(db);
  const existing = new Map((await store.strategies()).map((s) => [s.key, s]));
  for (const strategy of STRATEGY_LIBRARY) {
    const d = strategy.descriptor;
    let row = existing.get(d.key);
    if (!row) {
      const id = crypto.randomUUID();
      await store.insertStrategy({ id, key: d.key, name: d.name, family: d.family, description: d.description, visibility: "shared", supportedRegimes: [...d.supportedRegimes], stage: SEED_STRATEGY_STAGE, currentVersionId: null });
      row = await store.strategyByKey(d.key); // re-read: a concurrent caller may have inserted first
      if (!row) continue;
    }
    if (!row.currentVersionId) {
      const versions = await store.strategyVersionsFor(row.id);
      let v1 = versions.find((v) => v.version === SEED_STRATEGY_VERSION);
      if (!v1) {
        const versionId = crypto.randomUUID();
        await store.insertStrategyVersion({
          id: versionId, strategyId: row.id, version: SEED_STRATEGY_VERSION, parameters: defaultParameters(d),
          changeSummary: "Initial library version", changeReason: "seed", proposedByKind: "human", proposedById: "system",
          approvalStatus: "approved", deployedAt: new Date().toISOString(),
        });
        v1 = (await store.strategyVersionsFor(row.id)).find((v) => v.version === SEED_STRATEGY_VERSION);
      }
      if (v1) {
        await store.updateStrategy(row.id, { currentVersionId: v1.id });
        row = { ...row, currentVersionId: v1.id };
      }
    }
    existing.set(d.key, row);
  }
  return existing;
}
