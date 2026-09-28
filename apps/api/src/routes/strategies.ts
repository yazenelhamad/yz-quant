import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { STRATEGY_STAGE_ORDER, getStrategy, type StrategyIntelligenceProfile, type StrategyStage, type TenantScope } from "@yz/core";
import type { StrategyCatalogRow, StrategySettingsRow, StrategyVersionRow } from "@yz/db";
import type { AppContext } from "../http/app.js";
import { conflict, notFound, validation } from "../http/errors.js";
import { service } from "../services/registry.js";
import type { LearningService } from "../services/learning/service.js";
import { pctFieldsToFractions } from "../services/learning/units.js";
import { seedStrategies } from "../services/learning/seed.js";
import type { ResearchService } from "../services/research/index.js";

const StageSchema = z.enum(["research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live", "live", "paused", "retired"]);
const SettingsSchema = z.object({
  enabled: z.boolean().optional(),
  stage: StageSchema.optional(),
  capitalAllocation: z.number().min(0).max(1).optional(),
  maxPositionPct: z.number().min(0).max(1).optional(),
  maxLossPerTradePct: z.number().min(0).max(1).optional(),
  allowedSymbols: z.array(z.string().min(1).max(12)).max(500).nullable().optional(),
  blockedSymbols: z.array(z.string().min(1).max(12)).max(500).optional(),
  optionsAllowed: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).nullable().optional(),
  minExpectedEdge: z.number().min(-1).max(1).nullable().optional(),
}).strict();
const AdminStageSchema = z.object({ stage: StageSchema, reason: z.string().min(3).max(1000), force: z.boolean().optional() });

const LIVE_STAGES: ReadonlySet<string> = new Set(["limited_live", "live"]);
const stageIndex = (s: string): number => STRATEGY_STAGE_ORDER.indexOf(s as StrategyStage);

export function settingsView(scope: TenantScope, strategyId: string, row: StrategySettingsRow | undefined) {
  return {
    accountId: scope.brokerAccountId,
    strategyId,
    enabled: row?.enabled ?? false,
    stage: row?.stage ?? "research",
    capitalAllocation: row?.capitalAllocation ?? 0,
    maxPositionPct: row?.maxPositionPct ?? 0.05,
    maxLossPerTradePct: row?.maxLossPerTradePct ?? 0.01,
    allowedSymbols: row?.allowedSymbols ?? null,
    blockedSymbols: row?.blockedSymbols ?? [],
    optionsAllowed: row?.optionsAllowed ?? false,
    minConfidence: row?.minConfidence ?? null,
    minExpectedEdge: row?.minExpectedEdge ?? null,
    adaptiveOverrides: row?.adaptiveOverrides ?? {},
    updatedAt: row?.updatedAt ?? null,
  };
}

/** StrategyScorecard (addendum item 4) from an intelligence profile; stats are converted to fractions. */
export function scorecardFrom(profile: StrategyIntelligenceProfile | null, lastTradeAt: string | null) {
  if (!profile || profile.overall.trades === 0) return null;
  return pctFieldsToFractions({ mode: profile.mode, stats: profile.overall, recent: profile.recent.trades > 0 ? profile.recent : null, lastTradeAt, updatedAt: profile.updatedAt });
}

function versionView(v: StrategyVersionRow) {
  return { id: v.id, strategyId: v.strategyId, version: v.version, parameters: v.parameters, changeSummary: v.changeSummary, changeReason: v.changeReason, proposedBy: { kind: v.proposedByKind, id: v.proposedById }, backtestResultId: v.backtestResultId, outOfSampleResultId: v.outOfSampleResultId, walkForwardResultId: v.walkForwardResultId, shadowResultSummary: v.shadowResultSummary, approvalStatus: v.approvalStatus, approvedBy: v.approvedBy, deployedAt: v.deployedAt, createdAt: v.createdAt };
}

function strategyView(s: StrategyCatalogRow) {
  const descriptor = getStrategy(s.key)?.descriptor ?? null;
  return { id: s.id, key: s.key, name: s.name, family: s.family, description: s.description, visibility: s.visibility, supportedRegimes: s.supportedRegimes, stage: s.stage, globalStage: s.stage, globallyDisabled: s.globallyDisabled, currentVersionId: s.currentVersionId, parameters: descriptor?.parameters ?? null, warmupBars: descriptor?.warmupBars ?? null, interval: descriptor?.interval ?? null, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

export async function registerStrategyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards, audit } = ctx;
  const learning = () => service<LearningService>(ctx, "learning");
  const research = () => service<ResearchService>(ctx, "research");

  const ensureCatalog = async () => {
    const lr = learning().lr;
    if ((await lr.catalog.list()).length === 0) await seedStrategies(repos);
    return lr;
  };

  const lastTradeMap = (rows: { strategyKey: string; closedAt: string | null; openedAt: string }[]) => {
    const m = new Map<string, string>();
    for (const r of rows) { const t = r.closedAt ?? r.openedAt; const cur = m.get(r.strategyKey); if (!cur || t > cur) m.set(r.strategyKey, t); }
    return m;
  };

  app.get("/api/strategies", async (req) => {
    guards.requireAuth(req);
    const lr = await ensureCatalog();
    const list = await lr.catalog.list();
    const shared = await lr.strategyProfiles.shared();
    const last = lastTradeMap(await lr.memory.all());
    const strategies = [];
    for (const s of list) {
      const versions = (await lr.catalog.versions(s.id)).map(versionView);
      const byMode = (mode: string) => { const r = shared.find((p) => p.strategyId === s.id && p.mode === mode); return r ? (r.profile as StrategyIntelligenceProfile) : null; };
      const all = byMode("all");
      strategies.push({
        ...strategyView(s), versions,
        scorecards: { system: scorecardFrom(all, last.get(s.key) ?? null), live: scorecardFrom(byMode("live"), last.get(s.key) ?? null), shadow: scorecardFrom(byMode("shadow"), last.get(s.key) ?? null) },
        scorecard: scorecardFrom(all, last.get(s.key) ?? null),
        profile: all ? pctFieldsToFractions(all) : null,
      });
    }
    return { strategies };
  });

  app.get("/api/strategies/:id", async (req) => {
    const { user } = guards.requireAuth(req);
    const lr = await ensureCatalog();
    const id = (req.params as { id: string }).id;
    const s = (await lr.catalog.byId(id)) ?? (await lr.catalog.byKey(id));
    if (!s) throw notFound("Strategy not found");
    const versions = (await lr.catalog.versions(s.id)).map(versionView);
    const sharedAll = await lr.strategyProfiles.get(s.id, null, "all");
    const profile = sharedAll ? (sharedAll.profile as StrategyIntelligenceProfile) : null;
    const last = lastTradeMap(await lr.memory.all());
    const accounts = user.role === "admin" ? await repos.accounts.listAll() : await repos.accounts.listForUser(user.id);
    const byAccount: Record<string, unknown> = {};
    for (const a of accounts) {
      const scope = { userId: a.userId, brokerAccountId: a.id };
      const row = await lr.strategyProfiles.get(s.id, scope, "all");
      const mem = await lr.memory.forScope(scope, { strategyKey: s.key, limit: 1 });
      byAccount[a.id] = scorecardFrom(row ? (row.profile as StrategyIntelligenceProfile) : null, mem[0] ? (mem[0].closedAt ?? mem[0].openedAt) : null);
    }
    let promotion = null;
    try { promotion = await research().evaluatePromotion(s.key); } catch { promotion = null; }
    return {
      strategy: strategyView(s), versions,
      scorecards: { system: scorecardFrom(profile, last.get(s.key) ?? null), byAccount },
      profile: profile ? pctFieldsToFractions(profile) : null,
      promotion,
      transitions: await lr.catalog.transitions(s.id, 50),
    };
  });

  app.get("/api/accounts/:accountId/strategies", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const lr = await ensureCatalog();
    const list = await lr.catalog.list();
    const settings = new Map((await lr.settings.listForScope(scope)).map((r) => [r.strategyId, r]));
    const profiles = (await lr.strategyProfiles.forScope(scope)).filter((r) => r.mode === "all");
    const last = lastTradeMap(await lr.memory.forScope(scope));
    const strategies = list.map((s) => {
      const p = profiles.find((r) => r.strategyId === s.id);
      return { id: s.id, key: s.key, name: s.name, family: s.family, description: s.description, visibility: s.visibility, globalStage: s.stage, globallyDisabled: s.globallyDisabled, settings: settingsView(scope, s.id, settings.get(s.id)), scorecard: scorecardFrom(p ? (p.profile as StrategyIntelligenceProfile) : null, last.get(s.key) ?? null) };
    });
    return { strategies };
  });

  app.put("/api/accounts/:accountId/strategies/:strategyId/settings", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    const body = SettingsSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid strategy settings", body.error.flatten());
    const lr = await ensureCatalog();
    const strategyId = (req.params as { strategyId: string }).strategyId;
    const strategy = (await lr.catalog.byId(strategyId)) ?? (await lr.catalog.byKey(strategyId));
    if (!strategy) throw notFound("Strategy not found");
    const before = await lr.settings.get(scope, strategy.id);
    const current = settingsView(scope, strategy.id, before);
    const next = { ...current, ...body.data };
    if (next.stage === "paused" || next.stage === "retired") {
      if (body.data.enabled === true) throw validation(`A strategy cannot be enabled at stage ${next.stage}`);
      next.enabled = false;
    } else {
      const globalIdx = stageIndex(strategy.stage);
      if (globalIdx < 0) throw conflict(`Strategy is ${strategy.stage} globally; it cannot be configured beyond research`);
      if (stageIndex(next.stage) > globalIdx) throw validation(`Stage ${next.stage} exceeds the strategy's global stage ${strategy.stage}`, { globalStage: strategy.stage });
    }
    if (strategy.globallyDisabled && next.enabled) throw conflict("Strategy is disabled globally by an admin");
    const goingLive = next.enabled && LIVE_STAGES.has(next.stage) && (!current.enabled || current.stage !== next.stage);
    if (goingLive) guards.requireStepUp(req);
    const patch = {
      enabled: next.enabled, stage: next.stage, capitalAllocation: next.capitalAllocation, maxPositionPct: next.maxPositionPct, maxLossPerTradePct: next.maxLossPerTradePct,
      allowedSymbols: next.allowedSymbols ? Array.from(new Set(next.allowedSymbols.map((s) => s.toUpperCase()))) : null,
      blockedSymbols: Array.from(new Set((next.blockedSymbols ?? []).map((s) => s.toUpperCase()))),
      optionsAllowed: next.optionsAllowed, minConfidence: next.minConfidence, minExpectedEdge: next.minExpectedEdge,
    };
    const row = await lr.settings.upsert(scope, strategy.id, patch);
    if (before && before.stage !== row.stage) {
      await lr.catalog.recordTransition({ strategyId: strategy.id, userId: scope.userId, brokerAccountId: scope.brokerAccountId, fromStage: before.stage, toStage: row.stage, reason: "user settings change", evidence: { kind: "user_settings" }, decidedBy: scope.userId });
    }
    await audit.record({ category: "strategy", action: "strategy_settings_changed", result: "ok", brokerAccountId: scope.brokerAccountId, strategyId: strategy.id, detail: { before: current, after: settingsView(scope, strategy.id, row), stepUp: goingLive } }, req);
    return settingsView(scope, strategy.id, row);
  });

  app.post("/api/admin/strategies/:id/stage", async (req) => {
    const { user } = guards.requireStepUp(req);
    guards.requireRole(req, "admin");
    const body = AdminStageSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    const lr = await ensureCatalog();
    const id = (req.params as { id: string }).id;
    const strategy = (await lr.catalog.byId(id)) ?? (await lr.catalog.byKey(id));
    if (!strategy) throw notFound("Strategy not found");
    const from = strategy.stage;
    const to = body.data.stage;
    if (from === to) throw conflict(`Strategy is already at stage ${to}`);
    const evaluation = await research().evaluatePromotion(strategy.key, { humanReviewApproved: true });
    const forward = stageIndex(to) > stageIndex(from) && stageIndex(from) >= 0;
    let forced = false;
    if (forward) {
      const sequentialLive = to === "live" && from === "limited_live";
      const allowed = sequentialLive || stageIndex(to) <= stageIndex(evaluation.verdict.canPromoteTo);
      if (!allowed) {
        if (!body.data.force) throw conflict(`Validation pipeline allows promotion up to ${evaluation.verdict.canPromoteTo}: ${evaluation.verdict.blockers.join("; ")}`);
        forced = true;
      }
    }
    await lr.catalog.update(strategy.id, { stage: to });
    await lr.catalog.recordTransition({ strategyId: strategy.id, userId: null, brokerAccountId: null, fromStage: from, toStage: to, reason: body.data.reason, evidence: { kind: "human_review", forced, verdict: evaluation.verdict }, decidedBy: user.id });
    await audit.record({ category: "strategy", action: forced ? "stage_forced" : "stage_changed", result: "ok", strategyId: strategy.id, detail: { from, to, reason: body.data.reason, verdict: evaluation.verdict } }, req);
    const updated = (await lr.catalog.byId(strategy.id))!;
    return { strategy: strategyView(updated), verdict: evaluation.verdict, forced };
  });
}
