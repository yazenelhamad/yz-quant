import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURE, FEATURE_VERSION, REGIME_LABELS, syntheticBars, trendingBars, type Bar } from "@yz/core";
import { createHarness, type Harness } from "./testHarness.js";
import { PIPELINE_JOB_NAMES, pipelineServices, registerPipelineJobs, type PipelineServices } from "./index.js";
import { DEFAULT_UNIVERSE, SECTOR_ETFS } from "./universe.js";
import { earningsReportInstant } from "./calendar.js";
import { Cadence } from "./common.js";

let hz: Harness;
let p: PipelineServices;
const NOW = new Date("2026-09-28T14:30:00Z");
const SOURCE = "synthetic_test"; // labelled synthetic: these bars exist only inside this test

/** Persist SYNTHETIC daily bars (test-only) so the pipeline reads them exactly like broker bars. */
async function storeBars(bars: Bar[]): Promise<void> {
  await hz.ctx.repos.market.upsertBars(bars.filter((b) => Date.parse(b.time) <= NOW.getTime()).map((b) => ({ symbol: b.symbol, interval: b.interval, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, interpolated: false, adjusted: "split", source: SOURCE, receivedAt: NOW.toISOString() })));
}

beforeAll(async () => {
  hz = await createHarness({ start: NOW, marketSource: null });
  p = pipelineServices(hz.ctx, { clock: () => hz.clock.now });
  const start = "2025-07-14T00:00:00Z";
  await storeBars(trendingBars("SPY", 330, 0.0008, 1, start));
  await storeBars(trendingBars("QQQ", 330, 0.001, 2, start));
  let seed = 10;
  for (const etf of SECTOR_ETFS) await storeBars(syntheticBars({ symbol: etf, bars: 330, drift: 0.0004, vol: 0.011, seed: seed++, start }));
  for (const s of ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "JPM", "XOM", "LLY", "V", "MA", "UNH"]) await storeBars(syntheticBars({ symbol: s, bars: 330, drift: 0.0006, vol: 0.015, seed: seed++, start }));
});
afterAll(async () => { await hz.close(); });

describe("market pipeline over synthetic bars", () => {
  it("computes features for symbols with bars, derives instrument liquidity/beta, and skips symbols without data", async () => {
    const symbols = await p.universe.symbols();
    expect(symbols).toEqual(expect.arrayContaining([...DEFAULT_UNIVERSE]));
    const r = await p.features.run(symbols);
    expect(r.computed).toBe(2 + SECTOR_ETFS.length + 12);
    expect(r.skipped).toBe(symbols.length - r.computed);
    const f = await hz.ctx.repos.market.latestFeatures("AAPL", FEATURE_VERSION);
    expect(f?.values[FEATURE.sma200]).not.toBeNull();
    expect(f?.values[FEATURE.beta60]).not.toBeNull();
    expect(f?.freshness).toBe("fresh"); // last synthetic bar is the Friday before NOW
    const inst = await hz.ctx.repos.market.instrument("AAPL");
    expect(inst?.avgDollarVolume20).toBeGreaterThan(0);
    expect(inst?.beta).toBe(f?.values[FEATURE.beta60]);
    expect(await hz.ctx.repos.market.latestFeatures("PANW", FEATURE_VERSION)).toBeUndefined();
  });

  it("regime_assess stores an assessment from bars, features and no VIX (no connection); the route serves it", async () => {
    const r = await p.regime.assess(await p.universe.symbols());
    expect(r.id).not.toBeNull();
    expect(REGIME_LABELS).toContain(r.primary);
    expect(r.inputs.vixBars).toBe(0);
    expect(r.inputs.sectorEtfs).toBe(SECTOR_ETFS.length);
    expect(r.inputs.breadthSymbols).toBeGreaterThanOrEqual(10);
    expect(r.inputs.universeSymbols).toBeGreaterThanOrEqual(12);
    expect(r.inputs.eventDriven).toBe(false);
    const row = await hz.ctx.repos.market.latestRegime();
    expect(row?.primary).toBe(r.primary);
    expect(row?.engineVersion).toBe("regime-1.0.0");
    expect((row?.metrics as { vix: number | null }).vix).toBeNull();
    expect((row?.metrics as { breadthPctAbove50: number | null }).breadthPctAbove50).not.toBeNull();
    const t = await hz.login(hz.users.trader.email);
    const res = await hz.app.inject({ method: "GET", url: "/api/market/regime", headers: t.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().current).toMatchObject({ primary: r.primary, freshness: "fresh" });
    expect(res.json().history).toHaveLength(1);
    expect(res.json().usefulness).toMatchObject({ samples: 0, score: 0 });
    const overview = await hz.app.inject({ method: "GET", url: `/api/accounts/${hz.accounts.trader}/overview`, headers: t.headers });
    expect(overview.json().regime.primary).toBe(r.primary);
    expect(overview.json().dataQuality).toMatchObject({ regime: "fresh", bars: "fresh" });
  });

  it("regime_resolve fills forward returns only for assessments with 5 later sessions and feeds usefulness", async () => {
    const old = await hz.ctx.repos.market.recordRegime({ asOf: "2026-08-03T15:00:00Z", primary: "bull_trend", probabilities: { bull_trend: 0.5 }, confidence: 0.6, abnormality: 0.1, metrics: { spyTrend20: 0.01 }, familyBias: {}, explanation: [], dataQuality: "fresh", engineVersion: "regime-1.0.0" });
    const first = await p.regime.resolve();
    expect(first.resolved).toBe(1); // the old one; the fresh assessment is not yet 7 days old
    const rows = await hz.ctx.repos.market.regimeHistory(10);
    const resolved = rows.find((r) => r.id === old)!;
    expect(resolved.forwardReturn5d).not.toBeNull();
    expect(resolved.forwardVol5d).toBeGreaterThan(0);
    expect(rows.find((r) => r.id !== old)?.forwardReturn5d).toBeNull();
    const u = await p.regime.usefulness();
    expect(u.samples).toBe(1);
    expect(u.byLabel["bull_trend"]?.samples).toBe(1);
    expect((await p.regime.resolve()).resolved).toBe(0);
  });

  it("earnings calendar and instrument refresh do nothing without a Robinhood connection (never invents data)", async () => {
    const cal = await p.calendar.run(["AAPL"], ["AAPL"]);
    expect(cal).toMatchObject({ source: null, earningsUpserted: 0, calendarUpserted: 0, economicEvents: "no_provider" });
    expect(await hz.ctx.repos.market.upcomingEarnings(["AAPL"], "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toEqual([]);
    const inst = await p.universe.refreshInstruments(["AAPL", "SPY"]);
    expect(inst).toMatchObject({ symbols: 2, fundamentals: 0, tradability: 0, source: null });
    const aapl = await hz.ctx.repos.market.instrument("AAPL");
    expect(aapl?.sector).toBeNull();
    expect(aapl?.tradeable).toBeNull();
    expect((await hz.ctx.repos.market.instrument("SPY"))?.assetClass).toBe("etf");
    expect(earningsReportInstant("2026-10-29", "pm")).toEqual({ reportAt: "2026-10-29T20:30:00.000Z", timing: "amc" });
    expect(earningsReportInstant("2026-01-28", "am")).toEqual({ reportAt: "2026-01-28T13:00:00.000Z", timing: "bmo" });
    expect(earningsReportInstant("bad", null)).toBeNull();
  });

  it("bar pipeline reports no source and labels freshness from what is stored", async () => {
    const r = await p.bars.runDaily(["SPY", "PANW"]);
    expect(r.noSource).toBe(true);
    expect(r.updated).toBe(0);
    expect(r.freshness.fresh).toBe(1);
    expect(r.freshness.unknown).toBe(1);
    expect(p.bars.worstDailyFreshness(["SPY"])).toBe("fresh");
    expect(p.bars.worstDailyFreshness(["SPY", "PANW"])).toBe("unknown");
    const q = await p.bars.runQuotes(["SPY"]);
    expect(q).toMatchObject({ quotes: 0, source: null, error: "no market data source connected" });
  });

  it("health_collect persists components with truthful statuses readable through /api/system/health", async () => {
    const components = await p.health.collect(hz.ctx);
    const byName = Object.fromEntries(components.map((c) => [c.name, c]));
    expect(byName["market_data"]?.status).toBe("unknown");
    expect(byName["model_apis"]).toMatchObject({ status: "unknown", detail: "AI models: not configured" });
    expect(byName["learning"]?.status).toBe("unknown");
    expect(byName["data_freshness"]?.status).toBe("healthy");
    expect(byName["session_security"]?.status).toBe("warning"); // test users have no MFA
    expect(byName["database"]?.status).toBe("healthy");
    expect(byName[`broker:${hz.accounts.trader}`]?.detail).toContain("SIMULATED ••••ADE1");
    expect(byName[`reconciliation:${hz.accounts.trader}`]?.status).toBe("unknown");
    const t = await hz.login(hz.users.trader.email);
    const res = await hz.app.inject({ method: "GET", url: "/api/system/health", headers: t.headers });
    const names = (res.json().components as { name: string }[]).map((c) => c.name);
    expect(names.filter((n) => n === "database")).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["market_data", "scheduler", "data_freshness", "model_apis", "learning", "session_security"]));
  });

  it("registerPipelineJobs registers every job with a session-aware cadence; broker_sync skips unconnected accounts", async () => {
    const registered = registerPipelineJobs(hz.scheduler, hz.ctx, { clock: () => hz.clock.now });
    expect(registered).toBe(p);
    expect([...p.jobIntervals.keys()]).toEqual([...PIPELINE_JOB_NAMES]);
    expect(p.jobs.map((j) => j.kind)).toEqual(["global", "global", "global", "global", "global", "global", "global", "global", "per_account", "per_account", "global"]);
    const rh = await hz.ctx.repos.accounts.create({ userId: hz.users.trader.id, kind: "robinhood_agentic", label: "RH", accountNumber: "pending-9" });
    for (const job of p.jobs) await hz.scheduler.dispatch(job);
    const runs = await hz.ctx.repos.jobs.recent(100);
    const detail = (name: string, accountId: string | null = null) => runs.find((r) => r.name === name && r.brokerAccountId === accountId)?.detail as Record<string, unknown> | undefined;
    expect(runs.filter((r) => r.name === "broker_sync")).toHaveLength(3);
    expect(detail("broker_sync", rh.id)).toEqual({ skipped: true, reason: "broker not_connected" });
    expect(detail("broker_sync", hz.accounts.trader)).toMatchObject({ ok: true, status: "connected", reconciliation: { ok: true } });
    expect(detail("broker_status", hz.accounts.admin)).toMatchObject({ status: "connected" });
    expect(p.brokerStatuses.get(hz.accounts.admin)?.status).toBe("connected");
    expect(detail("market_bars_daily")).toMatchObject({ interval: "day", noSource: true });
    expect(detail("regime_assess")).toMatchObject({ primary: expect.any(String) });
    expect(detail("earnings_calendar")).toMatchObject({ source: null });
    expect(detail("health_collect")).toMatchObject({ components: expect.any(Number) });
    expect(runs.every((r) => r.status === "ok")).toBe(true);
    // Second dispatch within the cadence window is skipped, not re-run.
    await hz.scheduler.dispatch(p.jobs.find((j) => j.name === "regime_assess")!);
    const again = (await hz.ctx.repos.jobs.recent(5)).find((r) => r.name === "regime_assess");
    expect(again?.detail).toEqual({ skipped: true });
    const cadence = new Cadence(() => hz.clock.now);
    expect(cadence.due("x", 60_000)).toBe(true);
    expect(cadence.due("x", 60_000)).toBe(false);
    hz.clock.advance(61_000);
    expect(cadence.due("x", 60_000)).toBe(true);
    expect(cadence.dueDaily("d")).toBe(true);
    expect(cadence.dueDaily("d")).toBe(false);
    hz.clock.advance(24 * 3_600_000);
    expect(cadence.dueDaily("d")).toBe(true);
  });
});
