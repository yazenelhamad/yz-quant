import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import type { Strategy } from "@yz/core";
import { loadEnv } from "../config/env.js";
import { buildApp, createContext, type AppContext } from "../http/app.js";
import { hashPassword } from "../auth/password.js";
import { createLearningService, type LearningService } from "../services/learning/service.js";
import { seedStrategies } from "../services/learning/seed.js";
import { storeSyntheticBars, weekdaysEndingAt } from "../services/learning/testSupport.js";
import { createResearchService, type ResearchService } from "../services/research/index.js";
import { registerLearningRoutes } from "./learning.js";

const KEY = Buffer.alloc(32, 5).toString("base64");
const NOW = "2026-09-28T15:00:00.000Z";
const PASSWORD = "CorrectHorse!Battery9";
let h: DatabaseHandle;
let ctx: AppContext;
let app: FastifyInstance;
let learning: LearningService;
let research: ResearchService;
let accA: string;
let accB: string;
let userB: string;

/** Tiny daily strategy for backtests: long for ten bars, then exit for ten bars, repeat. */
const testStrategy: Strategy = {
  descriptor: { key: "test_cycle", name: "Test cycle", family: "trend_momentum", description: "test", supportedRegimes: [], parameters: { horizonDays: { default: 10, min: 5, max: 15, step: 5, description: "h" } }, warmupBars: 5, interval: "day", needsUniverse: false },
  evaluate(c) {
    const phase = Math.floor(c.bars.length / 10) % 2;
    if (phase === 0 && !c.position) return { signals: [], view: { direction: "long", strength: 1, confidence: 0.8, horizonDays: 10, expectedUpsidePct: 5, expectedDownsidePct: 2, invalidationPrice: null, targetPrice: null, explanation: "enter" } };
    if (phase === 1 && c.position) return { signals: [], view: { direction: "exit", strength: 1, confidence: 0.8, horizonDays: 10, expectedUpsidePct: 0, expectedDownsidePct: 0, invalidationPrice: null, targetPrice: null, explanation: "exit" } };
    return { signals: [], view: null };
  },
};

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const set = res.headers["set-cookie"];
  const arr = Array.isArray(set) ? set : [set];
  const c = arr.find((x) => typeof x === "string" && x.startsWith("yz_session=")) as string | undefined;
  return c ? c.split(";")[0]! : "";
}

async function session(email: string): Promise<{ cookie: string; csrf: string; headers: Record<string, string> }> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  const cookie = cookieOf(res);
  const s = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
  const csrf = s.json().csrfToken as string;
  return { cookie, csrf, headers: { cookie, "x-csrf-token": csrf } };
}

async function stepUp(s: { headers: Record<string, string> }): Promise<void> {
  const r = await app.inject({ method: "POST", url: "/api/auth/step-up", headers: s.headers, payload: { password: PASSWORD } });
  expect(r.statusCode).toBe(200);
}

beforeAll(async () => {
  h = await createDatabase("pglite://memory");
  await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: KEY, SESSION_SECRET: "test-session-secret-0123456789", SCHEDULER_ENABLED: "false", DATABASE_URL: "pglite://memory", AUTH_RATE_LIMIT_MAX: "1000", GLOBAL_RATE_LIMIT_MAX: "100000", LOG_LEVEL: "silent" });
  ctx = createContext(env, h, { warn() {} });
  await seedStrategies(ctx.repos);
  learning = createLearningService(ctx, { clock: () => new Date(NOW), log: { info() {}, warn() {}, error() {} } });
  research = createResearchService(ctx, { clock: () => new Date(NOW), resolveStrategy: (key) => (key === "test_cycle" ? testStrategy : undefined) });
  app = await buildApp(ctx, [registerLearningRoutes]);
  const ua = await ctx.repos.users.create({ email: "a@example.com", displayName: "A", role: "admin", passwordHash: await hashPassword(PASSWORD) });
  const ub = await ctx.repos.users.create({ email: "b@example.com", displayName: "B", role: "trader", passwordHash: await hashPassword(PASSWORD) });
  userB = ub.id;
  accA = (await ctx.repos.accounts.create({ userId: ua.id, kind: "simulated", label: "A", accountNumber: "SIM-A" })).id;
  accB = (await ctx.repos.accounts.create({ userId: ub.id, kind: "simulated", label: "B", accountNumber: "SIM-B" })).id;
  const times = weekdaysEndingAt(NOW, 260);
  await storeSyntheticBars(ctx.repos, "SPY", times, { seed: 11, drift: 0.0004 });
  await storeSyntheticBars(ctx.repos, "TEST", times, { seed: 12, drift: 0.001 });
});
afterAll(async () => { await app.close(); await h.close(); });

describe("backtests", () => {
  it("runs a queued backtest from stored bars and reports fractions in the route", async () => {
    const b = await session("b@example.com");
    const start = weekdaysEndingAt(NOW, 200)[0]!;
    const post = await app.inject({ method: "POST", url: "/api/backtests", headers: b.headers, payload: { strategyKey: "test_cycle", symbols: ["test"], start, end: NOW, kind: "in_sample" } });
    expect(post.statusCode).toBe(202);
    const { id, status } = post.json() as { id: string; status: string };
    expect(status).toBe("queued");
    await research.backtests.drain();
    const get = await app.inject({ method: "GET", url: `/api/backtests/${id}`, headers: { cookie: b.cookie } });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.backtest.status).toBe("completed");
    expect(body.backtest.symbols).toEqual(["TEST"]);
    expect(body.result.metrics.tradeCount).toBeGreaterThan(0);
    const row = (await research.lr.backtests.byId(id))!;
    const raw = row.metrics as { totalReturnPct: number; maxDrawdownPct: number };
    expect(body.result.metrics.totalReturnPct).toBeCloseTo(raw.totalReturnPct / 100, 10);
    expect(body.backtest.summary.totalReturnPct).toBeCloseTo(raw.totalReturnPct / 100, 10);
    expect(body.backtest.summary.maxDrawdownPct).toBeCloseTo(raw.maxDrawdownPct / 100, 10);
    expect(body.result.equityCurve[0].drawdownPct).toBe(0);
    expect(body.backtest.warnings.some((w: string) => w.includes("corporate actions"))).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/backtests?strategyKey=test_cycle", headers: { cookie: b.cookie } });
    expect(list.json().backtests[0].id).toBe(id);
  });

  it("fails clearly when stored bars are insufficient (never synthetic) and runs walk-forward + monte carlo", async () => {
    const b = await session("b@example.com");
    const start = weekdaysEndingAt(NOW, 200)[0]!;
    const post = await app.inject({ method: "POST", url: "/api/backtests", headers: b.headers, payload: { strategyKey: "test_cycle", symbols: ["NODATA"], start, end: NOW, kind: "in_sample" } });
    expect(post.statusCode).toBe(202);
    await research.backtests.drain();
    const get = await app.inject({ method: "GET", url: `/api/backtests/${post.json().id}`, headers: { cookie: b.cookie } });
    expect(get.json().backtest.status).toBe("failed");
    expect(get.json().backtest.error).toMatch(/insufficient stored daily bars for NODATA/);
    expect(get.json().result).toBeNull();

    const wf = await app.inject({ method: "POST", url: "/api/backtests", headers: b.headers, payload: { strategyKey: "test_cycle", symbols: ["TEST"], start, end: NOW, kind: "walk_forward" } });
    const mc = await app.inject({ method: "POST", url: "/api/backtests", headers: b.headers, payload: { strategyKey: "test_cycle", symbols: ["TEST"], start, end: NOW, kind: "monte_carlo" } });
    await research.backtests.drain();
    const wfBody = (await app.inject({ method: "GET", url: `/api/backtests/${wf.json().id}`, headers: { cookie: b.cookie } })).json();
    expect(wfBody.backtest.status).toBe("completed");
    expect(wfBody.walkForward.folds.length).toBeGreaterThan(0);
    const mcBody = (await app.inject({ method: "GET", url: `/api/backtests/${mc.json().id}`, headers: { cookie: b.cookie } })).json();
    expect(mcBody.monteCarlo.runs).toBe(1000);
    expect(Math.abs(mcBody.monteCarlo.medianReturnPct)).toBeLessThan(5); // a fraction, not percent points
    const unknown = await app.inject({ method: "POST", url: "/api/backtests", headers: b.headers, payload: { strategyKey: "nope", symbols: ["TEST"], start, end: NOW, kind: "in_sample" } });
    expect(unknown.statusCode).toBe(422);
  });
});

describe("promotion pipeline", () => {
  it("blocks promotion without out-of-sample and walk-forward evidence", async () => {
    const strategy = (await learning.lr.catalog.list()).find((s) => s.stage === "research")!;
    const none = await research.evaluatePromotion(strategy.key);
    expect(none.verdict.canPromoteTo).toBe("research");
    expect(none.verdict.blockers).toEqual(["in_sample: no result"]);
    const good = { cagr: 10, totalReturnPct: 20, annualizedVolatility: 10, sharpe: 1.5, sortino: 2, calmar: 1, maxDrawdownPct: 8, maxDrawdownDurationBars: 10, winRate: 0.6, profitFactor: 1.8, expectancyPct: 1, avgWinPct: 3, avgLossPct: -2, turnover: 1, exposure: 0.5, var95Pct: -2, cvar95Pct: -3, tradeCount: 50, grossReturnPct: 22, totalCosts: 100, netReturnPct: 20, byRegime: {} };
    await research.lr.backtests.create({ strategyKey: strategy.key, strategyVersionId: null, kind: "in_sample", config: { request: { strategyKey: strategy.key, versionId: null, symbols: ["TEST"], start: NOW, end: NOW, kind: "in_sample", requestedBy: "t" }, status: "completed", requestedAt: NOW, startedAt: NOW, completedAt: NOW, error: null, engine: { strategyKey: strategy.key, strategyVersion: "1.0", parameters: {}, symbols: ["TEST"], start: NOW, end: NOW, interval: "day", initialCapital: 1, costModel: { commissionPerShare: 0, commissionMin: 0, defaultHalfSpreadBps: 0, impactCoefficient: 0, executionDelayBars: 1, maxParticipation: 1 }, includeDelisted: true, seed: 1 }, walkForward: null, monteCarlo: null, outOfSample: null }, metrics: good, equityCurve: [], trades: [], warnings: [], dataFingerprint: "x", requestedBy: "t", durationMs: 1, ranAt: NOW });
    const withIs = await research.evaluatePromotion(strategy.key);
    expect(withIs.verdict.canPromoteTo).toBe("backtest");
    expect(withIs.verdict.blockers).toEqual(["out_of_sample: no result"]);
    // The admin stage route refuses to promote past what the pipeline allows unless forced.
    const a = await session("a@example.com");
    await stepUp(a);
    const refused = await app.inject({ method: "POST", url: `/api/admin/strategies/${strategy.id}/stage`, headers: a.headers, payload: { stage: "live_shadow", reason: "please" } });
    expect(refused.statusCode).toBe(409);
    const ok = await app.inject({ method: "POST", url: `/api/admin/strategies/${strategy.id}/stage`, headers: a.headers, payload: { stage: "backtest", reason: "in-sample evidence reviewed" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().strategy.stage).toBe("backtest");
    const transitions = await learning.lr.catalog.transitions(strategy.id);
    expect(transitions[0]?.toStage).toBe("backtest");
    expect(transitions[0]?.userId).toBeNull();
    const detail = await app.inject({ method: "GET", url: `/api/strategies/${strategy.id}`, headers: { cookie: a.cookie } });
    expect(detail.json().promotion.verdict.canPromoteTo).toBe("backtest");
  });
});

describe("strategy settings", () => {
  it("rejects stages above the global stage, requires step-up for live, upper-cases symbols and never lets B touch A", async () => {
    const strategy = (await learning.lr.catalog.byKey("time_series_momentum"))!;
    expect(strategy.stage).toBe("live_shadow");
    const b = await session("b@example.com");
    const tooHigh = await app.inject({ method: "PUT", url: `/api/accounts/${accB}/strategies/${strategy.id}/settings`, headers: b.headers, payload: { enabled: true, stage: "limited_live" } });
    expect(tooHigh.statusCode).toBe(422);
    const shadow = await app.inject({ method: "PUT", url: `/api/accounts/${accB}/strategies/${strategy.id}/settings`, headers: b.headers, payload: { enabled: true, stage: "live_shadow", allowedSymbols: ["aapl", "msft"], blockedSymbols: ["tsla"], capitalAllocation: 0.1 } });
    expect(shadow.statusCode).toBe(200);
    expect(shadow.json().allowedSymbols).toEqual(["AAPL", "MSFT"]);
    expect(shadow.json().blockedSymbols).toEqual(["TSLA"]);
    expect(shadow.json().stage).toBe("live_shadow");
    const foreign = await app.inject({ method: "PUT", url: `/api/accounts/${accA}/strategies/${strategy.id}/settings`, headers: b.headers, payload: { enabled: true, stage: "live_shadow" } });
    expect(foreign.statusCode).toBe(403);
    expect(await learning.lr.settings.get({ userId: userB, brokerAccountId: accA } as never, strategy.id)).toBeUndefined();

    // Admin raises the global stage (forced: pipeline evidence is missing) so B may go live, which needs step-up.
    const a = await session("a@example.com");
    await stepUp(a);
    const forced = await app.inject({ method: "POST", url: `/api/admin/strategies/${strategy.id}/stage`, headers: a.headers, payload: { stage: "limited_live", reason: "operator override for test", force: true } });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().forced).toBe(true);
    const noStepUp = await app.inject({ method: "PUT", url: `/api/accounts/${accB}/strategies/${strategy.id}/settings`, headers: b.headers, payload: { enabled: true, stage: "limited_live" } });
    expect(noStepUp.statusCode).toBe(428);
    await stepUp(b);
    const live = await app.inject({ method: "PUT", url: `/api/accounts/${accB}/strategies/${strategy.id}/settings`, headers: b.headers, payload: { enabled: true, stage: "limited_live" } });
    expect(live.statusCode).toBe(200);
    expect(live.json().stage).toBe("limited_live");
    const list = await app.inject({ method: "GET", url: `/api/accounts/${accB}/strategies`, headers: { cookie: b.cookie } });
    const row = (list.json().strategies as { id: string; settings: { stage: string }; globalStage: string }[]).find((s) => s.id === strategy.id)!;
    expect(row.settings.stage).toBe("limited_live");
    expect(row.globalStage).toBe("limited_live");
    const audit = await ctx.repos.audit.recent({ category: "strategy" });
    expect(audit.some((e) => e.action === "strategy_settings_changed" && e.brokerAccountId === accB)).toBe(true);
    const adminNoStep = await session("a@example.com");
    expect((await app.inject({ method: "POST", url: `/api/admin/strategies/${strategy.id}/stage`, headers: adminNoStep.headers, payload: { stage: "paused", reason: "x" } })).statusCode).toBe(428);
    const shared = await app.inject({ method: "GET", url: "/api/strategies", headers: { cookie: b.cookie } });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().strategies.length).toBeGreaterThan(5);
  });
});

describe("learning, variant and admin registries", () => {
  it("renders the learning view with explicit not-configured models and scoped account views", async () => {
    const b = await session("b@example.com");
    const shared = await app.inject({ method: "GET", url: "/api/learning", headers: { cookie: b.cookie } });
    expect(shared.statusCode).toBe(200);
    const body = shared.json();
    expect(body.modelsConfigured).toBe(false);
    expect(body.modelsNote).toMatch(/not configured/);
    expect(body.models).toEqual([]);
    expect(body.learningHealth).toMatchObject({ frozen: false });
    expect(Array.isArray(body.adaptationProposals)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/accounts/${accB}/learning`, headers: { cookie: b.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/accounts/${accA}/learning`, headers: { cookie: b.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/learning" })).statusCode).toBe(401);
  });

  it("variant run answers 503 not_configured; GET returns nulls", async () => {
    const b = await session("b@example.com");
    const run = await app.inject({ method: "POST", url: "/api/variant/AAPL/run", headers: b.headers });
    expect(run.statusCode).toBe(503);
    expect(run.json()).toMatchObject({ ok: false, error: { code: "not_configured" } });
    const get = await app.inject({ method: "GET", url: "/api/variant/aapl", headers: { cookie: b.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ ticker: "AAPL", variantView: null, consensusSnapshot: null, catalysts: [], companyProfile: null, modelsConfigured: false });
  });

  it("admin model/agent registries are seeded from env and prompts, and are admin-only", async () => {
    const b = await session("b@example.com");
    expect((await app.inject({ method: "GET", url: "/api/admin/models", headers: { cookie: b.cookie } })).statusCode).toBe(403);
    const a = await session("a@example.com");
    const models = await app.inject({ method: "GET", url: "/api/admin/models", headers: { cookie: a.cookie } });
    expect(models.statusCode).toBe(200);
    expect(models.json().configured).toBe(false);
    expect(models.json().models.map((m: { role: string }) => m.role).sort()).toEqual(["fast", "research", "slow_brain"]);
    expect(models.json().models.every((m: { configured: boolean }) => m.configured === false)).toBe(true);
    const name = models.json().models[0].name as string;
    const put = await app.inject({ method: "PUT", url: "/api/admin/models", headers: a.headers, payload: { models: [{ name, enabled: false, routingWeight: 0.5 }] } });
    expect(put.statusCode).toBe(200);
    const updated = (put.json().models as { name: string; enabled: boolean; routingWeight: number }[]).find((m) => m.name === name)!;
    expect(updated).toMatchObject({ enabled: false, routingWeight: 0.5 });
    const agents = await app.inject({ method: "GET", url: "/api/admin/agents", headers: { cookie: a.cookie } });
    expect(agents.json().agents.some((x: { name: string }) => x.name === "devils_advocate")).toBe(true);
    const putAgents = await app.inject({ method: "PUT", url: "/api/admin/agents", headers: a.headers, payload: { agents: [{ name: "devils_advocate", influenceWeight: 1.5 }] } });
    expect((putAgents.json().agents as { name: string; influenceWeight: number }[]).find((x) => x.name === "devils_advocate")?.influenceWeight).toBe(1.5);
    expect((await app.inject({ method: "PUT", url: "/api/admin/agents", headers: a.headers, payload: { agents: [{ name: "nope", influenceWeight: 1 }] } })).statusCode).toBe(422);
  });

  it("experiments are created by admins with proposedBy and listed for everyone", async () => {
    const a = await session("a@example.com");
    const created = await app.inject({ method: "POST", url: "/api/research/experiments", headers: a.headers, payload: { title: "Threshold study", hypothesis: "Confidence threshold is too high", strategyKey: "time_series_momentum", method: "missed-opportunity review" } });
    expect(created.statusCode).toBe(200);
    expect(created.json().createdBy).toMatchObject({ kind: "human", displayName: "A" });
    expect(created.json().status).toBe("proposed");
    const b = await session("b@example.com");
    expect((await app.inject({ method: "POST", url: "/api/research/experiments", headers: b.headers, payload: { title: "x", hypothesis: "y" } })).statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: "/api/research/experiments", headers: { cookie: b.cookie } });
    expect(list.json().experiments.length).toBe(1);
    const upd = await app.inject({ method: "PUT", url: `/api/research/experiments/${created.json().id}`, headers: a.headers, payload: { status: "completed", conclusion: "no change" } });
    expect(upd.json().status).toBe("completed");
  });
});
