import { describe, expect, it } from "vitest";
import { CrossTenantError } from "@yz/core";
import { AdapterRegistry, createAdapter } from "./factory.js";
import { InMemoryCredentialStore } from "./robinhood/credentialStore.js";
import { FakeMcpCaller } from "./testing/fakeMcpCaller.js";
import { ACCT_A, ACCT_B, SCOPE_A, SCOPE_B, loadObservedTools, orderRequest, quote, rawPortfolio, virtualClock } from "./testing/fixtures.js";

describe("createAdapter", () => {
  it("builds a simulated adapter bound to the scope", async () => {
    const adapter = createAdapter({ kind: "simulated", scope: SCOPE_A, accountNumber: ACCT_A, simulated: { quoteSource: { getQuotes: async (s) => s.map((x) => quote(x, 10)) } } });
    expect(adapter.binding).toEqual({ scope: SCOPE_A, accountNumber: ACCT_A, kind: "simulated" });
    expect((await adapter.getPortfolio()).provenance.source).toBe("simulated");
    expect(() => createAdapter({ kind: "simulated", scope: SCOPE_A, accountNumber: ACCT_A })).toThrow(/quoteSource/);
  });
  it("builds a Robinhood adapter over an injected transport and the stored credential", async () => {
    const clock = virtualClock();
    const store = new InMemoryCredentialStore();
    await store.save(SCOPE_A, { client_id: "c", access_token: "at", refresh_token: "rt", expires_at: clock.now() / 1000 + 86_400 });
    const caller = new FakeMcpCaller(loadObservedTools()).on("get_portfolio", () => rawPortfolio());
    const adapter = createAdapter({ kind: "robinhood_agentic", scope: SCOPE_A, accountNumber: ACCT_A, credentialStore: store, env: { ROBINHOOD_MCP_URL: "https://agent.robinhood.com/mcp/trading" }, clock: clock.now, callerFactory: async () => caller, fetch: async () => new Response("{}", { status: 500 }) });
    expect(adapter.binding.kind).toBe("robinhood_agentic");
    expect((await adapter.status()).status).toBe("connecting");
    expect((await adapter.getPortfolio()).cash).toBe(2500.5);
    expect((await adapter.status()).status).toBe("connected");
    // no credential for B ⇒ not_connected, typed error, no transport call
    const adapterB = createAdapter({ kind: "robinhood_agentic", scope: SCOPE_B, accountNumber: ACCT_B, credentialStore: store, clock: clock.now, callerFactory: async () => caller });
    expect((await adapterB.status()).status).toBe("not_connected");
    await expect(adapterB.getPortfolio()).rejects.toMatchObject({ code: "not_connected" });
    expect(caller.countOf("get_portfolio")).toBe(1);
    expect(() => createAdapter({ kind: "robinhood_agentic", scope: SCOPE_A, accountNumber: ACCT_A })).toThrow(/credentialStore/);
  });
});

describe("AdapterRegistry", () => {
  const sim = (scope: typeof SCOPE_A, accountNumber: string) => createAdapter({ kind: "simulated", scope, accountNumber, simulated: { quoteSource: { getQuotes: async (s) => s.map((x) => quote(x, 10)) } } });
  it("never returns an adapter for a different scope", async () => {
    const registry = new AdapterRegistry();
    const a = sim(SCOPE_A, ACCT_A);
    registry.set(SCOPE_A, a);
    expect(registry.get(SCOPE_A)).toBe(a);
    expect(registry.get(SCOPE_B)).toBeNull();
    expect(registry.get({ userId: SCOPE_A.userId, brokerAccountId: SCOPE_B.brokerAccountId })).toBeNull();
    expect(() => registry.set(SCOPE_B, a)).toThrow(CrossTenantError);
    const b = await registry.getOrCreate(SCOPE_B, () => sim(SCOPE_B, ACCT_B));
    expect(b.binding.scope).toEqual(SCOPE_B);
    expect(registry.get(SCOPE_B)).toBe(b);
    // user A's request can never be executed through B's adapter, even if routed wrongly
    await expect(b.reviewOrder(orderRequest({ scope: SCOPE_A, accountNumber: ACCT_A }))).rejects.toBeInstanceOf(CrossTenantError);
    await expect(registry.get(SCOPE_A)!.reviewOrder(orderRequest({ scope: SCOPE_A, accountNumber: ACCT_B }))).rejects.toBeInstanceOf(CrossTenantError);
    expect(registry.scopes()).toHaveLength(2);
  });
});
