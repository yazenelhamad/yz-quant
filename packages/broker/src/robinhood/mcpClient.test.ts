import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { BrokerError } from "../errors.js";
import { FakeMcpCaller } from "../testing/fakeMcpCaller.js";
import { ACCT_A, loadObservedTools, rawOrder, rawPortfolio, virtualClock } from "../testing/fixtures.js";
import { RobinhoodMcpClient, TokenBucketRateLimiter, classifyErrorResult, classifyThrown, parseToolResult } from "./mcpClient.js";
import type { AccessTokenProvider } from "./tokenProvider.js";

function setup(opts: { tools?: ReturnType<typeof loadObservedTools>; tokenProvider?: AccessTokenProvider | null } = {}) {
  const clock = virtualClock();
  const caller = new FakeMcpCaller(opts.tools ?? loadObservedTools());
  caller.on("get_portfolio", () => rawPortfolio());
  caller.on("place_equity_order", () => ({ order: rawOrder({ id: "o-placed" }) }));
  let connects = 0;
  const client = new RobinhoodMcpClient({
    connect: async () => {
      connects += 1;
      return caller;
    },
    tokenProvider: opts.tokenProvider ?? null,
    clock: clock.now,
    sleep: clock.sleep,
    rateLimitBackoffMs: 5_000,
  });
  return { clock, caller, client, connects: () => connects };
}

describe("TokenBucketRateLimiter", () => {
  it("allows a burst of 5 then sustains 3 calls/s", async () => {
    const clock = virtualClock();
    const limiter = new TokenBucketRateLimiter({ ratePerSecond: 3, burst: 5, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
    await limiter.acquire();
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(333);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(334);
    const before = clock.now();
    for (let i = 0; i < 9; i++) await limiter.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(2_990);
  });
  it("honours penalties", async () => {
    const clock = virtualClock();
    const limiter = new TokenBucketRateLimiter({ now: clock.now, sleep: clock.sleep });
    limiter.penalize(5_000);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([5_000]);
  });
});

describe("result parsing and error classification", () => {
  it("prefers structuredContent, else JSON text, and unwraps {data, guide}", () => {
    expect(parseToolResult({ structuredContent: { data: { a: 1 }, guide: "g" }, content: [{ type: "text", text: "{}" }] }, "t")).toEqual({ data: { a: 1 }, guide: "g", raw: { data: { a: 1 }, guide: "g" } });
    expect(parseToolResult({ content: [{ type: "text", text: JSON.stringify({ data: { b: 2 } }) }] }, "t").data).toEqual({ b: 2 });
    expect(parseToolResult({ content: [{ type: "text", text: JSON.stringify({ plain: true }) }] }, "t").data).toEqual({ plain: true });
    expect(() => parseToolResult({ content: [{ type: "text", text: "not json" }] }, "t")).toThrow(BrokerError);
    expect(() => parseToolResult({ content: [] }, "t")).toThrow(/neither/);
  });
  it("maps isError results and thrown errors to typed codes", () => {
    expect(classifyErrorResult({ isError: true, content: [{ type: "text", text: "RATE_LIMITED: slow down" }] }, "t").code).toBe("rate_limited");
    expect(classifyErrorResult({ isError: true, content: [{ type: "text", text: "Unauthorized" }] }, "t").code).toBe("token_expired");
    expect(classifyErrorResult({ isError: true, content: [{ type: "text", text: "insufficient buying power" }] }, "t").code).toBe("upstream_rejected");
    expect(classifyThrown(new McpError(ErrorCode.RequestTimeout, "timeout"), "t").code).toBe("transport");
    expect(classifyThrown(new McpError(ErrorCode.InvalidParams, "bad"), "t").code).toBe("upstream_rejected");
    expect(classifyThrown(Object.assign(new Error("HTTP 401"), { name: "StreamableHTTPError", code: 401 }), "t").code).toBe("token_expired");
    expect(classifyThrown(Object.assign(new Error("HTTP 429"), { name: "StreamableHTTPError", code: 429 }), "t").code).toBe("rate_limited");
    expect(classifyThrown(new TypeError("fetch failed"), "t").code).toBe("transport");
    const secret = classifyThrown(new Error("Bearer abcdefghijklmnop rejected"), "t");
    expect(secret.message).not.toContain("abcdefghijklmnop");
  });
});

describe("RobinhoodMcpClient", () => {
  it("calls a tool, records health and refuses unregistered tools", async () => {
    const { client, caller } = setup();
    const r = await client.call("get_portfolio", { account_number: ACCT_A });
    expect((r.data as { cash: string }).cash).toBe("2500.50");
    expect(r.guide).toContain("get_portfolio");
    expect(caller.listToolsCalls).toBe(1);
    expect((await client.status()).status).toBe("connected");
    await expect(client.call("get_watchlists", {})).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("parses text-only results too", async () => {
    const { client, caller } = setup();
    caller.textMode = true;
    const r = await client.call("get_portfolio", { account_number: ACCT_A });
    expect((r.data as { currency: string }).currency).toBe("USD");
  });
  it("reconnects once on transport error for read tools", async () => {
    const { client, caller, connects } = setup();
    caller.failNext("get_portfolio", new TypeError("fetch failed"));
    const r = await client.call("get_portfolio", { account_number: ACCT_A });
    expect((r.data as { cash: string }).cash).toBe("2500.50");
    expect(connects()).toBe(2);
    expect(caller.closed).toBe(1);
    expect(caller.countOf("get_portfolio")).toBe(2);
    expect(client.health.consecutiveFailures).toBe(0);
  });
  it("never retries a write; surfaces that it may have reached Robinhood", async () => {
    const { client, caller } = setup();
    caller.failNext("place_equity_order", new TypeError("socket hang up"));
    const err = await client.call("place_equity_order", { account_number: ACCT_A, symbol: "AAPL", side: "buy", type: "market", quantity: "1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).code).toBe("transport");
    expect((err as BrokerError).mayHaveReached).toBe(true);
    expect((err as BrokerError).message).toMatch(/get_equity_orders/);
    expect(caller.countOf("place_equity_order")).toBe(1);
  });
  it("backs off and retries reads on RATE_LIMITED, but not writes", async () => {
    const { client, caller, clock } = setup();
    caller.toolErrorNext("get_portfolio", "RATE_LIMITED");
    const r = await client.call("get_portfolio", { account_number: ACCT_A });
    expect((r.data as { cash: string }).cash).toBe("2500.50");
    expect(caller.countOf("get_portfolio")).toBe(2);
    expect(Math.max(...clock.sleeps)).toBeGreaterThanOrEqual(5_000);
    caller.toolErrorNext("place_equity_order", "RATE_LIMITED");
    await expect(client.call("place_equity_order", { account_number: ACCT_A, symbol: "AAPL", side: "buy", type: "market" })).rejects.toMatchObject({ code: "rate_limited", retryable: true, mayHaveReached: false });
    expect(caller.countOf("place_equity_order")).toBe(1);
  });
  it("maps isError answers to upstream_rejected and keeps the connection healthy", async () => {
    const { client, caller } = setup();
    caller.toolErrorNext("place_equity_order", "Order rejected: insufficient buying power");
    await expect(client.call("place_equity_order", { account_number: ACCT_A, symbol: "AAPL", side: "buy", type: "market" })).rejects.toMatchObject({ code: "upstream_rejected", tool: "place_equity_order" });
    expect(client.health.consecutiveFailures).toBe(0);
  });
  it("fails closed on schema drift", async () => {
    const tools = loadObservedTools();
    const portfolio = tools.find((t) => t.name === "get_portfolio");
    delete (portfolio!.inputSchema.properties as Record<string, unknown>).account_number;
    const orders = tools.find((t) => t.name === "get_equity_orders");
    orders!.inputSchema.required = ["account_number", "signature"];
    const filtered = tools.filter((t) => t.name !== "cancel_equity_order");
    const { client } = setup({ tools: filtered });
    await expect(client.call("get_portfolio", { account_number: ACCT_A })).rejects.toMatchObject({ code: "schema_drift", details: { missing: ["account_number"] } });
    await expect(client.call("get_equity_orders", { account_number: ACCT_A })).rejects.toMatchObject({ code: "schema_drift", details: { unexpected: ["signature"] } });
    await expect(client.call("cancel_equity_order", { account_number: ACCT_A, order_id: "x" })).rejects.toMatchObject({ code: "schema_drift" });
    await expect(client.assertToolSchema("get_equity_quotes", ["symbols"], ["symbols"])).resolves.toBeUndefined();
    expect((await client.status()).status).toBe("error");
  });
  it("detects payload drift via zod-shaped consumers (unparseable structured content)", async () => {
    const { client, caller } = setup();
    caller.on("get_portfolio", () => "not-an-object");
    const r = await client.call("get_portfolio", { account_number: ACCT_A });
    expect(r.data).toBe("not-an-object");
  });
  it("becomes unreliable after 3 consecutive failures", async () => {
    const { client, caller } = setup();
    for (let i = 0; i < 3; i++) {
      caller.failNext("get_portfolio", new TypeError("fetch failed"));
      caller.failNext("get_portfolio", new TypeError("fetch failed"));
      await expect(client.call("get_portfolio", { account_number: ACCT_A })).rejects.toMatchObject({ code: "transport" });
    }
    const s = await client.status();
    expect(s.status).toBe("unreliable");
    expect(s.consecutiveFailures).toBe(3);
    await client.call("get_portfolio", { account_number: ACCT_A });
    expect((await client.status()).status).toBe("connected");
  });
  it("reports credential state through status() and pre-flights calls", async () => {
    let has = false;
    let lastFailure: AccessTokenProvider["lastFailure"] = null;
    let invalidated = 0;
    const provider: AccessTokenProvider = {
      scope: { userId: "u", brokerAccountId: "b" },
      get lastFailure() {
        return lastFailure;
      },
      async hasCredential() {
        return has;
      },
      invalidate() {
        invalidated += 1;
      },
      async getAccessToken() {
        if (!has) {
          lastFailure = { code: "not_connected", at: 0 };
          throw new BrokerError("not_connected", "none");
        }
        return "tok";
      },
    };
    const { client, caller } = setup({ tokenProvider: provider });
    expect((await client.status()).status).toBe("not_connected");
    await expect(client.call("get_portfolio", { account_number: ACCT_A })).rejects.toMatchObject({ code: "not_connected" });
    expect(caller.calls).toHaveLength(0);
    has = true;
    expect((await client.status()).status).toBe("connecting");
    await client.call("get_portfolio", { account_number: ACCT_A });
    expect((await client.status()).status).toBe("connected");
    caller.failNext("place_equity_order", Object.assign(new Error("HTTP 401"), { name: "StreamableHTTPError", code: 401 }));
    await expect(client.call("place_equity_order", { account_number: ACCT_A, symbol: "AAPL", side: "buy", type: "market" })).rejects.toMatchObject({ code: "token_expired" });
    expect(invalidated).toBe(1);
    expect((await client.status()).status).toBe("token_expired");
  });
});
