/**
 * Turn on SHADOW trading for one user's accounts: autonomy -> shadow (only if still research_only)
 * and every eligible strategy enabled at the live_shadow stage (never beyond its global stage,
 * never a globally disabled one). Simulated fills only: no real order can result from this.
 *
 * Usage: SHADOW_USER=yazen npx tsx scripts/enable-shadow.ts
 */
import { STRATEGY_STAGE_ORDER, type StrategyStage } from "@yz/core";
import { StrategyCatalogRepository, StrategySettingsRepository, createDatabase } from "@yz/db";
import { buildRepos } from "../apps/api/src/http/app.js";
import type { AuditEvent } from "@yz/core";

const audit = (e: Pick<AuditEvent, "category" | "action" | "userId" | "brokerAccountId" | "detail"> & Partial<AuditEvent>): AuditEvent => ({
  at: new Date().toISOString(), actorUserId: null, strategyId: null, strategyVersionId: null, modelName: null, modelVersion: null, promptVersion: null, tradeId: null, orderId: null, result: "ok", error: null, ip: null, sessionId: null, ...e,
});

const username = (process.env.SHADOW_USER ?? "").trim().toLowerCase();
if (!username) { console.error("set SHADOW_USER=<username>"); process.exit(2); }
const url = process.env.DATABASE_URL ?? "pglite://./data/pglite";
const h = await createDatabase(url);
try {
  const repos = buildRepos(h);
  const user = await repos.users.byUsername(username);
  if (!user) { console.error(`no user "${username}"`); process.exit(2); }
  const catalog = new StrategyCatalogRepository(h.db);
  const settings = new StrategySettingsRepository(h.db);
  const idx = (s: string): number => STRATEGY_STAGE_ORDER.indexOf(s as StrategyStage);
  const shadowIdx = idx("live_shadow");
  const strategies = (await catalog.list()).filter((s) => !s.globallyDisabled && idx(s.stage) >= shadowIdx);
  for (const account of await repos.accounts.listForUser(user.id)) {
    const scope = { userId: user.id, brokerAccountId: account.id };
    let autonomyNote = `autonomy ${account.autonomyLevel}`;
    if (account.autonomyLevel === "research_only") {
      await repos.accounts.update(scope, { autonomyLevel: "shadow" });
      await repos.audit.append(audit({ category: "autonomy", action: "autonomy_changed", userId: user.id, brokerAccountId: account.id, detail: { from: "research_only", to: "shadow", by: "scripts/enable-shadow" } }));
      autonomyNote = "autonomy research_only -> shadow";
    }
    let enabled = 0;
    for (const s of strategies) {
      const cur = await settings.get(scope, s.id);
      const stage = cur && idx(cur.stage) >= shadowIdx ? cur.stage : "live_shadow";
      if (cur?.enabled && cur.stage === stage) continue;
      await settings.upsert(scope, s.id, { enabled: true, stage });
      await repos.audit.append(audit({ category: "strategy", action: "settings_changed", userId: user.id, brokerAccountId: account.id, strategyId: s.id, detail: { enabled: true, stage, by: "scripts/enable-shadow" } }));
      enabled += 1;
    }
    console.log(`${account.label} (${account.id}): ${autonomyNote}; ${enabled} strateg${enabled === 1 ? "y" : "ies"} newly enabled in shadow, ${strategies.length} eligible`);
  }
} finally {
  await h.close();
}
