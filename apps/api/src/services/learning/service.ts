import type { RegimeUsefulness, SignalIntelligenceProfile, StrategyIntelligenceProfile, TenantScope } from "@yz/core";
import type { AdaptationProposalRow } from "@yz/db";
import type { StructuredModelClient } from "@yz/intelligence";
import { NotConfiguredClient } from "@yz/intelligence";
import type { AppContext } from "../../http/app.js";
import type { JobDefinition, Scheduler } from "../scheduler.js";
import { applyProposalRows, runAdaptation, type AdaptationRunResult } from "./adaptation.js";
import { scopeKey, type LearningContext, type LearningLogger } from "./context.js";
import { LearningHealthTracker, type LearningHealthView } from "./health.js";
import { rebuildProfiles, type ProfilesRebuildResult } from "./profiles.js";
import { buildLearningRepos, type LearningRepos } from "./repos.js";
import { reviewClosedTrade, type TradeClosedResult } from "./review.js";
import { resolveSignals, reviewMissedOpportunities, reviewStrategyStatus, runDarwinism, runDigests, scoreRegimeUsefulness, type DigestDeps } from "./jobs.js";
import { seedStrategies } from "./seed.js";
import { buildLearningView } from "./view.js";

export type LearningJobName = "signals_resolve" | "profiles_rebuild" | "missed_review" | "regime_usefulness" | "adaptation" | "learning_digest" | "strategy_status_review" | "darwinism";

export const LEARNING_JOB_INTERVALS_MS: Readonly<Record<LearningJobName, number>> = Object.freeze({
  signals_resolve: 24 * 3600_000,
  profiles_rebuild: 3600_000,
  missed_review: 24 * 3600_000,
  regime_usefulness: 24 * 3600_000,
  adaptation: 24 * 3600_000,
  learning_digest: 24 * 3600_000,
  strategy_status_review: 24 * 3600_000,
  darwinism: 24 * 3600_000,
});

export interface LearningServiceOptions {
  clock?: () => Date;
  log?: LearningLogger;
  modelClient?: StructuredModelClient;
}

const HOUR = 3600_000;

/**
 * Learning plane. Learning runs automatically (jobs), produces statistics, profiles, calibration,
 * lessons, recommendations and bounded proposals, and applies only auto-applicable proposals inside
 * their own scope. A failing job freezes adaptation until it succeeds again; trading is never
 * touched by this service beyond those bounded, audited writes.
 */
export class LearningService {
  readonly lr: LearningRepos;
  readonly health: LearningHealthTracker;
  readonly ctx: LearningContext;
  /** Job handlers by name; replaceable (tests inject failures). */
  readonly handlers: Record<LearningJobName, () => Promise<unknown>>;
  private readonly previousStrategyProfiles = new Map<string, StrategyIntelligenceProfile>();
  private readonly previousSignalProfiles = new Map<string, SignalIntelligenceProfile>();
  private regimeUsefulness: RegimeUsefulness | null = null;
  private readonly modelClient: StructuredModelClient;

  constructor(app: AppContext, options: LearningServiceOptions = {}) {
    const clock = options.clock ?? (() => new Date());
    const log = options.log ?? { info() {}, warn(o, m) { console.warn(m ?? "", o); }, error(o, m) { console.error(m ?? "", o); } };
    this.lr = buildLearningRepos(app.dbHandle.db);
    this.ctx = { repos: app.repos, lr: this.lr, audit: app.audit, clock, log };
    this.health = new LearningHealthTracker(app.repos.health, clock);
    this.modelClient = options.modelClient ?? (app.services["modelClient"] as StructuredModelClient | undefined) ?? new NotConfiguredClient();
    this.handlers = {
      signals_resolve: () => resolveSignals(this.ctx),
      profiles_rebuild: () => this.rebuildProfiles(),
      missed_review: () => reviewMissedOpportunities(this.ctx),
      regime_usefulness: async () => { this.regimeUsefulness = await scoreRegimeUsefulness(this.ctx); return this.regimeUsefulness; },
      adaptation: () => this.runAdaptation(),
      learning_digest: () => runDigests(this.ctx, this.digestDeps()),
      strategy_status_review: () => reviewStrategyStatus(this.ctx),
      darwinism: () => runDarwinism(this.ctx),
    };
  }

  get modelsConfigured(): boolean { return this.modelClient.configured; }
  get frozen(): boolean { return this.health.frozen; }
  healthView(): LearningHealthView { return this.health.view(); }
  regimeUsefulnessView(): RegimeUsefulness | null { return this.regimeUsefulness; }

  /** Subscription entry point wired by the composition root: `tradingEvents.on("tradeClosed", (scope, id) => learning.onTradeClosed(scope, id))`. */
  async onTradeClosed(scope: TenantScope, tradeId: string): Promise<TradeClosedResult> {
    try {
      const result = await reviewClosedTrade(this.ctx, scope, tradeId);
      if (result.ok) await this.health.recordSuccess("trade_review");
      else this.ctx.log.warn({ scope: scopeKey(scope), tradeId, error: result.error }, "post-trade review skipped");
      return result;
    } catch (err) {
      await this.health.recordFailure("trade_review", err);
      await this.ctx.audit.record({ category: "learning", action: "trade_review_failed", result: "error", userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: null, tradeId, error: err instanceof Error ? err.message : String(err) });
      this.ctx.log.error({ err, tradeId }, "post-trade review failed; adaptation frozen");
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Runs one learning job with health bookkeeping. Throws after recording the failure (the scheduler logs it). */
  async runJob(name: LearningJobName): Promise<unknown> {
    try {
      const detail = await this.handlers[name]();
      await this.health.recordSuccess(name);
      return detail;
    } catch (err) {
      await this.health.recordFailure(name, err);
      await this.ctx.audit.record({ category: "learning", action: "job_failed", result: "error", actorUserId: null, error: err instanceof Error ? err.message : String(err), detail: { job: name, frozen: true } });
      throw err;
    }
  }

  async rebuildProfiles(): Promise<ProfilesRebuildResult> {
    // Remember the previous profiles so digests can report deltas.
    for (const r of await this.lr.strategyProfiles.all()) if (r.mode === "all") this.previousStrategyProfiles.set(`${scopeKey(r.userId && r.brokerAccountId ? { userId: r.userId, brokerAccountId: r.brokerAccountId } : null)}|${r.strategyKey}`, r.profile as StrategyIntelligenceProfile);
    for (const r of await this.lr.signalProfiles.all()) this.previousSignalProfiles.set(r.signalKey, r.profile as SignalIntelligenceProfile);
    await seedStrategies(this.ctx.repos);
    return rebuildProfiles(this.ctx);
  }

  async runAdaptation(): Promise<AdaptationRunResult> {
    return runAdaptation(this.ctx, this.health.frozen);
  }

  /** Apply proposal rows inside `scope`. Foreign-scope or out-of-bounds proposals are refused, audited and thrown. */
  async applyProposals(scope: TenantScope | null, rows: AdaptationProposalRow[]) {
    return applyProposalRows(this.ctx, scope, rows, this.health.frozen);
  }

  async learningView(scope: TenantScope | null, visibleScopes: TenantScope[]) {
    return buildLearningView(this.ctx, { scope, visibleScopes, health: this.health.view(), modelsConfigured: this.modelsConfigured, regimeUsefulness: this.regimeUsefulness });
  }

  jobDefinitions(): JobDefinition[] {
    const names = Object.keys(LEARNING_JOB_INTERVALS_MS) as LearningJobName[];
    return names.map((name) => ({ name: `learning_${name}`, everyMs: LEARNING_JOB_INTERVALS_MS[name], kind: "global", timeoutMs: name === "profiles_rebuild" ? 10 * 60_000 : 5 * 60_000, run: () => this.runJob(name) }));
  }

  private digestDeps(): DigestDeps {
    return { previousStrategyProfiles: this.previousStrategyProfiles, previousSignalProfiles: this.previousSignalProfiles };
  }
}

export function createLearningService(ctx: AppContext, options: LearningServiceOptions = {}): LearningService {
  const service = new LearningService(ctx, options);
  ctx.services["learning"] = service;
  return service;
}

/**
 * Registers the learning jobs on the scheduler (all global; each job is serialised by name). The
 * order of daily jobs is staggered so profiles exist before adaptation and digests read fresh
 * profiles: signals -> profiles (hourly) -> missed -> regime -> adaptation -> status -> digest.
 */
export function registerLearningJobs(scheduler: Scheduler, ctx: AppContext, learning?: LearningService): LearningService {
  const service = learning ?? (ctx.services["learning"] as LearningService | undefined) ?? createLearningService(ctx);
  ctx.services["learning"] = service;
  const defs = service.jobDefinitions();
  for (const def of defs) scheduler.register(def, { runImmediately: def.name === "learning_profiles_rebuild" });
  // Daily chain: run the dependent jobs in order shortly after start, then on their own intervals.
  const chain: LearningJobName[] = ["signals_resolve", "profiles_rebuild", "missed_review", "regime_usefulness", "adaptation", "strategy_status_review", "darwinism", "learning_digest"];
  const t = setTimeout(() => { void (async () => { for (const name of chain) await service.runJob(name).catch(() => undefined); })(); }, HOUR / 60);
  t.unref();
  return service;
}
