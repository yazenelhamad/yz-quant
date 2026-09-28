import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { AdaptationBoundsError, CrossTenantError, type TenantScope } from "@yz/core";
import { loadEnv } from "../../config/env.js";
import { createContext, type AppContext } from "../../http/app.js";
import { hashPassword } from "../../auth/password.js";
import { createLearningService, type LearningService } from "./service.js";
import { seedStrategies } from "./seed.js";
import { seedClosedTrade, storeSyntheticBars, weekdaysEndingAt } from "./testSupport.js";

const KEY = Buffer.alloc(32, 9).toString("base64");
const NOW = "2026-09-28T15:00:00.000Z";
let h: DatabaseHandle;
let ctx: AppContext;
let learning: LearningService;
let scopeA: TenantScope;
let scopeB: TenantScope;
let strategyId: string;
const strategyKey = "time_series_momentum";

beforeAll(async () => {
  h = await createDatabase("pglite://memory");
  await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: KEY, SESSION_SECRET: "test-session-secret-0123456789", SCHEDULER_ENABLED: "false", DATABASE_URL: "pglite://memory" });
  ctx = createContext(env, h, { warn() {} });
  const ua = await ctx.repos.users.create({ email: "a@example.com", displayName: "A", role: "admin", passwordHash: await hashPassword("CorrectHorse!Battery9") });
  const ub = await ctx.repos.users.create({ email: "b@example.com", displayName: "B", role: "trader", passwordHash: await hashPassword("CorrectHorse!Battery9") });
  const accA = await ctx.repos.accounts.create({ userId: ua.id, kind: "simulated", label: "A", accountNumber: "SIM-A" });
  const accB = await ctx.repos.accounts.create({ userId: ub.id, kind: "simulated", label: "B", accountNumber: "SIM-B" });
  scopeA = { userId: ua.id, brokerAccountId: accA.id };
  scopeB = { userId: ub.id, brokerAccountId: accB.id };
  await seedStrategies(ctx.repos);
  learning = createLearningService(ctx, { clock: () => new Date(NOW), log: { info() {}, warn() {}, error() {} } });
  strategyId = (await learning.lr.catalog.byKey(strategyKey))!.id;
  const times = weekdaysEndingAt(NOW, 80);
  await storeSyntheticBars(ctx.repos, "SPY", times, { seed: 1 });
  await storeSyntheticBars(ctx.repos, "AAPL", times, { seed: 2 });
  await ctx.repos.market.recordRegime({ asOf: times[10]!, primary: "bull_trend", probabilities: { bull_trend: 0.8 }, confidence: 0.8, abnormality: 0.1, metrics: {}, familyBias: {}, explanation: [], dataQuality: "fresh", engineVersion: "t" });
  await ctx.repos.market.recordRegime({ asOf: times[70]!, primary: "range_bound", probabilities: { range_bound: 0.7 }, confidence: 0.7, abnormality: 0.1, metrics: {}, familyBias: {}, explanation: [], dataQuality: "fresh", engineVersion: "t" });
});
afterAll(async () => { await h.close(); });

describe("seedStrategies", () => {
  it("is idempotent and seeds versions 1.0 with descriptor defaults; options strategies start in research", async () => {
    const first = await learning.lr.catalog.list();
    const again = await seedStrategies(ctx.repos);
    expect(again.inserted).toBe(0);
    expect((await learning.lr.catalog.list()).length).toBe(first.length);
    const tsm = first.find((s) => s.key === strategyKey)!;
    expect(tsm.stage).toBe("live_shadow");
    const versions = await learning.lr.catalog.versions(tsm.id);
    expect(versions[0]?.version).toBe("1.0");
    expect(versions[0]?.approvalStatus).toBe("approved");
    expect(versions[0]?.deployedAt).toBeTruthy();
    expect(tsm.currentVersionId).toBe(versions[0]?.id);
    expect((versions[0]?.parameters as Record<string, unknown>)["horizonDays"]).toBe(20);
    expect(first.filter((s) => s.family === "options_volatility").every((s) => s.stage === "research")).toBe(true);
  });
});

describe("onTradeClosed", () => {
  it("writes review, lesson, memory and calibration rows for scope A only", async () => {
    const times = weekdaysEndingAt(NOW, 80);
    const fx = await seedClosedTrade(ctx.repos, scopeA, { strategyId, strategyKey, symbol: "AAPL", openedAt: times[30]!, closedAt: times[45]!, entry: 100, exit: 106 });
    const res = await learning.onTradeClosed(scopeA, fx.tradeId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.review.classification).toBe("good_win");
    expect(res.review.scope).toEqual(scopeA);
    expect(res.lesson.scope).toEqual(scopeA);

    const reviewA = await learning.lr.reviews.forTrade(scopeA, fx.tradeId);
    expect(reviewA?.classification).toBe("good_win");
    expect(await learning.lr.reviews.forTrade(scopeB, fx.tradeId)).toBeUndefined();
    expect((await learning.lr.lessons.forScope(scopeA)).length).toBe(1);
    expect((await learning.lr.lessons.forScope(scopeB)).length).toBe(0);
    const memA = await learning.lr.memory.byTrade(scopeA, fx.tradeId);
    expect(memA?.vector.length).toBeGreaterThan(0);
    expect(memA?.actualReturnPct).toBeCloseTo(6, 5);
    expect((await learning.lr.memory.forScope(scopeB)).length).toBe(0);
    expect(await learning.lr.reviews.recent(scopeB)).toEqual([]);

    const system = await learning.lr.calibration.get("system");
    expect((system?.profile as { sampleSize: number }).sampleSize).toBe(1);
    expect((await learning.lr.calibration.get(strategyKey))).toBeTruthy();
    const audit = await ctx.repos.audit.recent({ category: "learning" });
    expect(audit.some((a) => a.action === "trade_reviewed" && a.userId === scopeA.userId && a.brokerAccountId === scopeA.brokerAccountId && a.tradeId === fx.tradeId)).toBe(true);
    expect(learning.healthView().frozen).toBe(false);
    expect(learning.healthView().status).toBe("healthy");
  });

  it("refuses a trade that is not in the caller's scope", async () => {
    const times = weekdaysEndingAt(NOW, 80);
    const fx = await seedClosedTrade(ctx.repos, scopeB, { strategyId, strategyKey, symbol: "AAPL", openedAt: times[20]!, closedAt: times[30]!, entry: 100, exit: 97 });
    const wrong = await learning.onTradeClosed(scopeA, fx.tradeId);
    expect(wrong.ok).toBe(false);
    expect(await learning.lr.reviews.forTrade(scopeA, fx.tradeId)).toBeUndefined();
    const right = await learning.onTradeClosed(scopeB, fx.tradeId);
    expect(right.ok).toBe(true);
    expect(await learning.lr.reviews.forTrade(scopeB, fx.tradeId)).toBeTruthy();
  });
});

describe("profiles, adaptation and isolation", () => {
  it("rebuilds shared and per-scope profiles without scoped mutations", async () => {
    const r = await learning.runJob("profiles_rebuild") as { strategyProfiles: number };
    expect(r.strategyProfiles).toBeGreaterThan(0);
    const shared = await learning.lr.strategyProfiles.shared();
    expect(shared.every((p) => p.userId === null && p.brokerAccountId === null)).toBe(true);
    const sharedTsm = shared.find((p) => p.strategyKey === strategyKey && p.mode === "all");
    expect((sharedTsm?.profile as { overall: { trades: number } }).overall.trades).toBe(2); // both users' memory
    const scopedA = await learning.lr.strategyProfiles.forScope(scopeA);
    expect(scopedA.every((p) => p.userId === scopeA.userId)).toBe(true);
    expect((scopedA.find((p) => p.mode === "all")?.profile as { overall: { trades: number } }).overall.trades).toBe(1);
    // No user state was written by the rebuild.
    expect(await learning.lr.settings.listForScope(scopeA)).toEqual([]);
    expect(await learning.lr.settings.listForScope(scopeB)).toEqual([]);
  });

  it("applies proposals only inside bounds and only to the proposing scope; foreign scope is refused and audited", async () => {
    await learning.lr.settings.upsert(scopeA, strategyId, { enabled: true, stage: "live_shadow", capitalAllocation: 0.2 });
    await learning.lr.settings.upsert(scopeB, strategyId, { enabled: true, stage: "live_shadow", capitalAllocation: 0.2 });
    await ctx.repos.market.recordSignals([{ key: "tsm_signal", strategyKey, symbol: "AAPL", direction: "long", value: 0.5, confidence: 0.6, horizonDays: 5, asOf: NOW, featureVersion: "t", inputFreshness: "fresh", explanation: "" }]);
    const bounds = { min: 0.25, max: 2, maxStepPerDay: 0.1 };
    const okId = await learning.lr.proposals.create(scopeA, { target: "signal_weight", key: "tsm_signal", currentValue: 1, proposedValue: 1.1, bounds, evidence: "test", autoApplicable: true, requiresValidationPipeline: false });
    const applied = await learning.applyProposals(scopeA, [(await learning.lr.proposals.byId(okId))!]);
    expect(applied.applied.length).toBe(1);
    const rowA = await learning.lr.settings.get(scopeA, strategyId);
    expect(rowA?.adaptiveOverrides["signal_weight:tsm_signal"]).toBeCloseTo(1.1);
    expect((await learning.lr.proposals.byId(okId))?.status).toBe("applied");
    expect((await learning.lr.settings.get(scopeB, strategyId))?.adaptiveOverrides).toEqual({});

    // Out of bounds (step larger than maxStepPerDay) is refused.
    const badId = await learning.lr.proposals.create(scopeA, { target: "signal_weight", key: "tsm_signal", currentValue: 1.1, proposedValue: 1.6, bounds, evidence: "test", autoApplicable: true, requiresValidationPipeline: false });
    await expect(learning.applyProposals(scopeA, [(await learning.lr.proposals.byId(badId))!])).rejects.toBeInstanceOf(AdaptationBoundsError);
    expect((await learning.lr.settings.get(scopeA, strategyId))?.adaptiveOverrides["signal_weight:tsm_signal"]).toBeCloseTo(1.1);

    // A's proposal applied in B's scope is refused and audited; B's rows are untouched.
    const foreignId = await learning.lr.proposals.create(scopeA, { target: "strategy_allocation", key: strategyKey, currentValue: 0.2, proposedValue: 0.24, bounds: { min: 0, max: 1, maxStepPerDay: 0.05 }, evidence: "test", autoApplicable: true, requiresValidationPipeline: false });
    await expect(learning.applyProposals(scopeB, [(await learning.lr.proposals.byId(foreignId))!])).rejects.toBeInstanceOf(CrossTenantError);
    expect((await learning.lr.settings.get(scopeB, strategyId))?.adaptiveOverrides).toEqual({});
    expect((await learning.lr.proposals.byId(foreignId))?.status).toBe("proposed");
    const refused = (await ctx.repos.audit.recent({ category: "learning" })).find((a) => a.action === "adaptation_refused");
    expect(refused?.result).toBe("rejected");
    expect(refused?.userId).toBe(scopeB.userId);

    // Shared calibration adjustment is applied only in the shared scope and within [0.6, 1.1].
    await learning.lr.calibration.upsertProfile("system", (await learning.lr.calibration.get("system"))!.profile);
    const calId = await learning.lr.proposals.create(null, { target: "confidence_calibration", key: "system", currentValue: 1, proposedValue: 0.95, bounds: { min: 0.6, max: 1.1, maxStepPerDay: 0.05 }, evidence: "test", autoApplicable: true, requiresValidationPipeline: false });
    const calRow = (await learning.lr.proposals.byId(calId))!;
    await expect(learning.applyProposals(scopeA, [calRow])).rejects.toThrow();
    const sharedApplied = await learning.applyProposals(null, [calRow]);
    expect(sharedApplied.applied.length).toBe(1);
    expect((await learning.lr.calibration.get("system"))?.adjustment).toBeCloseTo(0.95);

    // The daily adaptation job runs end to end and never proposes outside bounds.
    const run = await learning.runJob("adaptation") as { proposed: number; frozen: boolean };
    expect(run.frozen).toBe(false);
    for (const p of await learning.lr.proposals.recent(undefined, 500)) {
      const b = p.bounds as { min: number; max: number; maxStepPerDay: number };
      expect(p.proposedValue).toBeGreaterThanOrEqual(b.min - 1e-9);
      expect(p.proposedValue).toBeLessThanOrEqual(b.max + 1e-9);
    }
  });

  it("freezes adaptation on a learning failure and resumes after the job succeeds again", async () => {
    const original = learning.handlers.profiles_rebuild;
    learning.handlers.profiles_rebuild = async () => { throw new Error("synthetic learning failure"); };
    await expect(learning.runJob("profiles_rebuild")).rejects.toThrow("synthetic learning failure");
    expect(learning.frozen).toBe(true);
    const row = (await ctx.repos.health.all()).find((c) => c.name === "learning");
    expect(row?.status).toBe("critical");
    expect((row?.metrics as { frozen: boolean }).frozen).toBe(true);
    const view = learning.healthView();
    expect(view.reason).toContain("profiles_rebuild");

    // Nothing is applied while frozen; proposals stay proposed.
    const id = await learning.lr.proposals.create(scopeA, { target: "signal_weight", key: "tsm_signal", currentValue: 1.1, proposedValue: 1.15, bounds: { min: 0.25, max: 2, maxStepPerDay: 0.1 }, evidence: "test", autoApplicable: true, requiresValidationPipeline: false });
    const frozenResult = await learning.applyProposals(scopeA, [(await learning.lr.proposals.byId(id))!]);
    expect(frozenResult.applied).toEqual([]);
    expect(frozenResult.skipped).toBe(1);
    expect((await learning.lr.proposals.byId(id))?.status).toBe("proposed");
    expect((await learning.lr.settings.get(scopeA, strategyId))?.adaptiveOverrides["signal_weight:tsm_signal"]).toBeCloseTo(1.1);
    const adaptation = await learning.runJob("adaptation") as { applied: number; frozen: boolean };
    expect(adaptation.frozen).toBe(true);
    expect(adaptation.applied).toBe(0);

    learning.handlers.profiles_rebuild = original;
    await learning.runJob("profiles_rebuild");
    expect(learning.frozen).toBe(false);
    expect((await ctx.repos.health.all()).find((c) => c.name === "learning")?.status).toBe("healthy");
  });

  it("runs the remaining jobs and produces digests, regime usefulness and status review without touching foreign scopes", async () => {
    await learning.runJob("signals_resolve");
    await learning.runJob("missed_review");
    const usefulness = await learning.runJob("regime_usefulness") as { samples: number };
    expect(usefulness.samples).toBe(0);
    const status = await learning.runJob("strategy_status_review") as { proposals: number; demotions: number };
    expect(status.demotions).toBe(0);
    const digests = await learning.runJob("learning_digest") as { daily: number; weekly: number };
    expect(digests.daily).toBe(3); // shared + two accounts
    expect(digests.weekly).toBe(3);
    const shared = await learning.lr.digests.latest("daily", null);
    expect(shared?.userId).toBeNull();
    const forA = await learning.lr.digests.latest("daily", scopeA);
    expect(forA?.userId).toBe(scopeA.userId);
    const view = await learning.learningView(scopeA, [scopeA]);
    expect(view.today).toBeTruthy();
    expect(view.learningHealth.frozen).toBe(false);
    expect(view.modelsConfigured).toBe(false);
    expect(view.modelsNote).toContain("not configured");
    expect(view.adaptationProposals.every((p) => (p as { userId: string }).userId === scopeA.userId)).toBe(true);
  });
});
