import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, MarketRepository, type DatabaseHandle } from "@yz/db";
import type { Quote } from "@yz/core";
import { MarketDataService, type MarketDataSource } from "./marketData.js";

let h: DatabaseHandle;
beforeAll(async () => { h = await createDatabase("pglite://memory"); await h.migrate(); });
afterAll(async () => { await h.close(); });

const q = (symbol: string, observedAt: string, last = 100): Quote => ({ symbol, last, bid: last - 0.01, ask: last + 0.01, previousClose: last - 1, lastTradeAt: observedAt, session: "regular", instrumentState: "active", provenance: { source: "test", observedAt, receivedAt: observedAt, reliability: 1 } });

describe("MarketDataService", () => {
  it("returns nothing (never fabricates) when no source is connected, then caches and labels freshness", async () => {
    const repo = new MarketRepository(h.db);
    let now = new Date("2026-09-28T14:00:00Z");
    let calls = 0;
    let source: MarketDataSource | null = null;
    const svc = new MarketDataService(repo, async () => source, { warn() {}, info() {} }, () => now);
    expect(await svc.getQuotes(["AAPL"])).toEqual([]);
    expect(svc.health().status).toBe("unknown");
    source = { name: "fake", async getQuotes(symbols) { calls++; return symbols.map((s) => q(s, now.toISOString())); }, async getBars() { return []; }, async getTradability() { return []; } };
    const first = await svc.getQuotes(["AAPL", "MSFT"]);
    expect(first.map((x) => x.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(first[0]!.freshness).toBe("fresh");
    expect(calls).toBe(1);
    await svc.getQuotes(["AAPL"]);
    expect(calls).toBe(1); // served from cache
    now = new Date("2026-09-28T14:05:00Z");
    source = { ...source, async getQuotes() { throw new Error("upstream down"); } };
    const stale = await svc.getQuotes(["AAPL"]);
    expect(stale[0]!.freshness).toBe("stale"); // old quote correctly labelled, not refreshed silently
    expect(svc.health().status).toBe("warning");
  });
});
