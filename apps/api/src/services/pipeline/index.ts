import type { TenantScope } from "@yz/core";
import type { AppContext } from "../../http/app.js";
import { coreServices } from "../registry.js";
import type { Scheduler, JobDefinition } from "../scheduler.js";
import { HealthService, type BrokerStatusCacheEntry } from "../health.js";
import { BarPipeline } from "./bars.js";
import { CalendarPipeline } from "./calendar.js";
import { Cadence, HOUR, MINUTE, dataPlaneRepo, newYorkHour, sessionNow, type PipelineLogger } from "./common.js";
import { FeaturePipeline } from "./features.js";
import { RegimePipeline } from "./regime.js";
import { createResearchDataProvider, type ResearchDataProvider } from "./researchData.js";
import { UniverseService } from "./universe.js";

export * from "./bars.js";
export * from "./calendar.js";
export * from "./common.js";
export * from "./features.js";
export * from "./regime.js";
export * from "./researchData.js";
export * from "./universe.js";

export interface PipelineServices {
  universe: UniverseService;
  bars: BarPipeline;
  features: FeaturePipeline;
  regime: RegimePipeline;
  calendar: CalendarPipeline;
  health: HealthService;
  research: ResearchDataProvider;
  cadence: Cadence;
  /** Job name → registered interval (ms). Filled by registerPipelineJobs. */
  jobIntervals: Map<string, number>;
  brokerStatuses: Map<string, BrokerStatusCacheEntry>;
  clock: () => Date;
}

export const PIPELINE_SERVICE_KEY = "pipeline";

export interface PipelineOptions { clock?: () => Date; log?: PipelineLogger }

/** Build (once) and cache the pipeline services on the context. Routes use this; jobs are registered separately. */
export function pipelineServices(ctx: AppContext, opts: PipelineOptions = {}): PipelineServices {
  const existing = ctx.services[PIPELINE_SERVICE_KEY] as PipelineServices | undefined;
  if (existing) return existing;
  const core = coreServices(ctx);
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? console;
  const dataPlane = dataPlaneRepo(ctx);
  const research = createResearchDataProvider(ctx.repos, core.broker, log);
  const jobIntervals = new Map<string, number>();
  const brokerStatuses = new Map<string, BrokerStatusCacheEntry>();
  const services: PipelineServices = {
    universe: new UniverseService(ctx.repos, dataPlane, core.marketData, research, log, clock),
    bars: new BarPipeline(core.marketData, log, clock),
    features: new FeaturePipeline(ctx.repos.market, log, clock),
    regime: new RegimePipeline(ctx.repos.market, dataPlane, research, log, clock),
    calendar: new CalendarPipeline(ctx.repos.market, research, log, clock),
    health: new HealthService({ clock, jobIntervals: () => jobIntervals, brokerStatuses: () => brokerStatuses }),
    research, cadence: new Cadence(clock), jobIntervals, brokerStatuses, clock,
  };
  ctx.services[PIPELINE_SERVICE_KEY] = services;
  return services;
}

const SKIPPED = { skipped: true } as const;

/**
 * Registers the data-plane jobs. Interval choice by market session happens inside each job
 * through `Cadence`, so the scheduler only needs the shortest interval per job.
 */
export function registerPipelineJobs(scheduler: Scheduler, ctx: AppContext, opts: PipelineOptions = {}): PipelineServices {
  const p = pipelineServices(ctx, opts);
  const core = coreServices(ctx);
  const { cadence, clock } = p;
  const jobs: JobDefinition[] = [];
  const add = (job: JobDefinition, runImmediately = false): void => {
    p.jobIntervals.set(job.name, job.everyMs);
    jobs.push(job);
    scheduler.register(job, { runImmediately });
  };

  add({ name: "universe_refresh", kind: "global", everyMs: HOUR, timeoutMs: 10 * MINUTE, run: async () => {
    if (!cadence.dueDaily("universe_refresh")) return SKIPPED;
    return p.universe.refreshInstruments();
  } }, true);

  add({ name: "market_bars_daily", kind: "global", everyMs: 30 * MINUTE, timeoutMs: 20 * MINUTE, run: async () => {
    const hour = newYorkHour(clock());
    const interval = hour >= 6 && hour < 20 ? 30 * MINUTE : HOUR;
    if (!cadence.due("market_bars_daily", interval)) return SKIPPED;
    const symbols = await p.universe.symbols();
    const r = await p.bars.runDaily(symbols);
    if (r.noSource) cadence.reset("market_bars_daily");
    return r;
  } }, true);

  add({ name: "market_bars_intraday", kind: "global", everyMs: 5 * MINUTE, timeoutMs: 4 * MINUTE, run: async () => {
    if (sessionNow(clock) !== "regular") return SKIPPED;
    const symbols = await p.universe.activeSymbols();
    return p.bars.runIntraday(symbols);
  } });

  add({ name: "market_quotes", kind: "global", everyMs: MINUTE, timeoutMs: 50_000, run: async () => {
    const session = sessionNow(clock);
    const interval = session === "regular" || session === "pre" || session === "post" ? MINUTE : 15 * MINUTE;
    if (!cadence.due("market_quotes", interval)) return SKIPPED;
    const snap = await p.universe.snapshot();
    const symbols = [...new Set([...snap.held, ...snap.ordered, ...snap.candidates])];
    return p.bars.runQuotes(symbols);
  } });

  add({ name: "features_compute", kind: "global", everyMs: 5 * MINUTE, timeoutMs: 15 * MINUTE, run: async () => {
    const barsAt = p.bars.lastDailyRun ? Date.parse(p.bars.lastDailyRun.finishedAt) : null;
    const featuresAt = p.features.lastRun ? Date.parse(p.features.lastRun.asOf) : null;
    if (barsAt === null) return SKIPPED; // bars have not run yet
    if (featuresAt !== null && featuresAt >= barsAt && !(sessionNow(clock) === "regular" && cadence.due("features_compute_intraday", 30 * MINUTE))) return SKIPPED;
    return p.features.run(await p.universe.symbols());
  } });

  add({ name: "regime_assess", kind: "global", everyMs: 15 * MINUTE, timeoutMs: 10 * MINUTE, run: async () => {
    const session = sessionNow(clock);
    const interval = session === "regular" ? 15 * MINUTE : HOUR;
    if (!cadence.due("regime_assess", interval)) return SKIPPED;
    const r = await p.regime.assess(await p.universe.symbols());
    if (!r.id) cadence.reset("regime_assess");
    return r;
  } });

  add({ name: "regime_resolve", kind: "global", everyMs: HOUR, run: async () => {
    if (!cadence.dueDaily("regime_resolve")) return SKIPPED;
    return p.regime.resolve();
  } });

  add({ name: "earnings_calendar", kind: "global", everyMs: HOUR, timeoutMs: 10 * MINUTE, run: async () => {
    if (!cadence.dueDaily("earnings_calendar")) return SKIPPED;
    const snap = await p.universe.snapshot();
    const r = await p.calendar.run(snap.symbols, [...new Set([...snap.held, ...snap.ordered])]);
    if (!r.source) cadence.reset("earnings_calendar");
    return r;
  } });

  add({ name: "broker_sync", kind: "per_account", everyMs: MINUTE, timeoutMs: 55_000, run: async ({ scope }) => {
    if (!scope) return SKIPPED;
    const account = await ctx.repos.accounts.forScope(scope);
    if (!account) return SKIPPED;
    if (account.kind === "robinhood_agentic" && account.status !== "connected") return { skipped: true, reason: `broker ${account.status}` };
    const interval = sessionNow(clock) === "regular" ? MINUTE : 5 * MINUTE;
    if (!cadence.due(`broker_sync:${scope.brokerAccountId}`, interval)) return SKIPPED;
    const r = await core.broker.sync(scope);
    return { ok: r.ok, status: r.status, detail: r.detail, positions: r.positions, orders: r.orders, fills: r.fills, reconciliation: r.reconciliation, paused: r.paused };
  } });

  add({ name: "broker_status", kind: "per_account", everyMs: 5 * MINUTE, timeoutMs: MINUTE, run: async ({ scope }) => {
    if (!scope) return SKIPPED;
    const s = await core.broker.status(scope);
    const entry: BrokerStatusCacheEntry = { status: s.status, detail: s.detail, lastHealthyAt: s.lastHealthyAt, consecutiveFailures: s.consecutiveFailures, checkedAt: clock().toISOString() };
    p.brokerStatuses.set(scope.brokerAccountId, entry);
    return entry;
  } }, true);

  add({ name: "health_collect", kind: "global", everyMs: MINUTE, timeoutMs: 50_000, run: async () => {
    const components = await p.health.collect(ctx);
    return { components: components.length, worst: components.reduce((w, c) => (rank(c.status) > rank(w) ? c.status : w), "healthy" as string) };
  } }, true);

  return p;
}

function rank(s: string): number {
  return ({ healthy: 0, unknown: 1, warning: 2, critical: 3 } as Record<string, number>)[s] ?? 1;
}

/** Convenience for tests / manual runs: run a job by name for a scope. */
export function pipelineJobNames(): string[] {
  return ["universe_refresh", "market_bars_daily", "market_bars_intraday", "market_quotes", "features_compute", "regime_assess", "regime_resolve", "earnings_calendar", "broker_sync", "broker_status", "health_collect"];
}

export type { TenantScope };
