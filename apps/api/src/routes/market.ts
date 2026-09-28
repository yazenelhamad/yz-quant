import type { FastifyInstance } from "fastify";
import { DEFAULT_FRESHNESS_POLICY, ageSeconds, classifyAge } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { validation } from "../http/errors.js";
import { coreServices } from "../services/registry.js";
import { pipelineServices } from "../services/pipeline/index.js";
import { rowToAssessment, type RegimeRow } from "../services/pipeline/regime.js";
import { DEFAULT_UNIVERSE } from "../services/pipeline/universe.js";
import { dataPlaneRepo } from "../services/pipeline/common.js";

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export async function registerMarketRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;

  app.get("/api/market/regime", async (req) => {
    guards.requireAuth(req);
    const now = new Date();
    const history = await repos.market.regimeHistory(60);
    const latest = history[0];
    const age = ageSeconds(latest?.asOf ?? null, now.toISOString());
    const freshness = classifyAge(age, DEFAULT_FRESHNESS_POLICY.regimeAgingMinutes * 60, DEFAULT_FRESHNESS_POLICY.regimeStaleMinutes * 60);
    let usefulness: unknown = null;
    try {
      usefulness = await pipelineServices(ctx).regime.usefulness();
    } catch {
      // Core services may not be composed (e.g. auth-only tests): report the score as unavailable rather than guessing.
      usefulness = null;
    }
    return {
      current: latest ? { ...rowToAssessment(latest as RegimeRow), id: latest.id, engineVersion: latest.engineVersion, freshness, ageSeconds: age } : null,
      history: history.map((r) => ({ ...rowToAssessment(r as RegimeRow), id: r.id, engineVersion: r.engineVersion, forwardReturn5d: r.forwardReturn5d, forwardVol5d: r.forwardVol5d })),
      usefulness,
    };
  });

  app.get("/api/market/quotes", async (req) => {
    guards.requireAuth(req);
    const raw = (req.query as { symbols?: string }).symbols ?? "";
    const symbols = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) throw validation("symbols query parameter is required");
    if (symbols.length > 50) throw validation("at most 50 symbols per request");
    for (const s of symbols) if (!SYMBOL_RE.test(s)) throw validation(`invalid symbol ${s}`);
    const { marketData } = coreServices(ctx);
    const quotes = await marketData.getQuotes(symbols);
    const found = new Set(quotes.map((q) => q.symbol));
    return {
      quotes: quotes.map((q) => ({ symbol: q.symbol, last: q.last, bid: q.bid, ask: q.ask, previousClose: q.previousClose, lastTradeAt: q.lastTradeAt, session: q.session, instrumentState: q.instrumentState, provenance: q.provenance, freshness: q.freshness, ageSeconds: q.ageSeconds })),
      missing: symbols.filter((s) => !found.has(s)),
      source: marketData.health().status === "unknown" ? null : marketData.health().detail,
    };
  });

  app.get("/api/market/universe", async (req) => {
    guards.requireAuth(req);
    const dp = dataPlaneRepo(ctx);
    let snapshot: { symbols: string[]; held: string[]; ordered: string[]; allowed: string[]; candidates: string[] };
    try {
      snapshot = await pipelineServices(ctx).universe.snapshot();
    } catch {
      snapshot = { symbols: [...DEFAULT_UNIVERSE], held: [], ordered: [], allowed: [], candidates: [] };
    }
    const instruments = new Map((await repos.market.instrumentsFor(snapshot.symbols)).map((i) => [i.symbol, i]));
    const barTimes = await dp.latestBarTimes(snapshot.symbols, "day");
    const now = new Date().toISOString();
    const held = new Set(snapshot.held);
    const candidates = new Set(snapshot.candidates);
    return {
      count: snapshot.symbols.length,
      default: DEFAULT_UNIVERSE,
      symbols: snapshot.symbols.map((symbol) => {
        const i = instruments.get(symbol);
        const lastBar = barTimes.get(symbol) ?? null;
        const age = ageSeconds(lastBar, now);
        return {
          symbol, name: i?.name ?? null, sector: i?.sector ?? null, industry: i?.industry ?? null, assetClass: i?.assetClass ?? "equity", state: i?.state ?? "unknown",
          tradeable: i?.tradeable ?? null, fractional: i?.fractional ?? null, marketCap: i?.marketCap ?? null, avgDollarVolume20: i?.avgDollarVolume20 ?? null, beta: i?.beta ?? null,
          held: held.has(symbol), candidate: candidates.has(symbol), lastDailyBarAt: lastBar,
          barFreshness: classifyAge(age, (DEFAULT_FRESHNESS_POLICY.barsAgingDays + 1.5) * 86_400, (DEFAULT_FRESHNESS_POLICY.barsStaleDays + 1.5) * 86_400),
          updatedAt: i?.updatedAt ?? null,
        };
      }),
    };
  });
}
