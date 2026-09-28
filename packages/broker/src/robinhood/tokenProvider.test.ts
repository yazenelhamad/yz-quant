import { describe, expect, it } from "vitest";
import { BrokerError } from "../errors.js";
import { InMemoryCredentialStore } from "./credentialStore.js";
import type { FetchLike } from "./oauth.js";
import { createAccessTokenProvider } from "./tokenProvider.js";
import { SCOPE_A, SCOPE_B } from "../testing/fixtures.js";

const NOW = 1_800_000_000_000; // ms

function tokenFetch(responses: (() => Response)[]): FetchLike & { calls: number } {
  let calls = 0;
  const f = (async () => {
    calls += 1;
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as FetchLike & { calls: number };
  Object.defineProperty(f, "calls", { get: () => calls });
  return f;
}
const rotated = (n: number) => () => new Response(JSON.stringify({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 86_400 }), { status: 200 });

describe("createAccessTokenProvider", () => {
  it("returns not_connected when no credential exists", async () => {
    const p = createAccessTokenProvider({ scope: SCOPE_A, store: new InMemoryCredentialStore(), fetch: tokenFetch([]), clock: () => NOW });
    await expect(p.getAccessToken()).rejects.toMatchObject({ code: "not_connected" });
    expect(await p.hasCredential()).toBe(false);
  });
  it("uses the stored token while it is fresh and refreshes inside the 60-minute skew", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(SCOPE_A, { client_id: "c", access_token: "at-0", refresh_token: "rt-0", expires_at: NOW / 1000 + 7200 });
    const fetch = tokenFetch([rotated(1)]);
    const p = createAccessTokenProvider({ scope: SCOPE_A, store, fetch, clock: () => NOW, locks: new Map() });
    expect(await p.getAccessToken()).toBe("at-0");
    expect(fetch.calls).toBe(0);
    // Now inside the skew window
    const p2 = createAccessTokenProvider({ scope: SCOPE_A, store, fetch, clock: () => NOW + 3_601_000, locks: new Map() });
    expect(await p2.getAccessToken()).toBe("at-1");
    expect(fetch.calls).toBe(1);
    expect((await store.load(SCOPE_A))?.refresh_token).toBe("rt-1");
    expect(await store.load(SCOPE_B)).toBeNull();
  });
  it("single-flights concurrent refreshes per scope", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(SCOPE_A, { client_id: "c", access_token: "old", refresh_token: "rt-0", expires_at: 0 });
    const fetch = tokenFetch([rotated(1)]);
    const p = createAccessTokenProvider({ scope: SCOPE_A, store, fetch, clock: () => NOW, locks: new Map() });
    const tokens = await Promise.all([p.getAccessToken(), p.getAccessToken(), p.getAccessToken()]);
    expect(tokens).toEqual(["at-1", "at-1", "at-1"]);
    expect(fetch.calls).toBe(1);
  });
  it("surfaces a rejected refresh as token_expired without deleting the stored row", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(SCOPE_A, { client_id: "c", access_token: "old", refresh_token: "rt-0", expires_at: 0 });
    const fetch = tokenFetch([() => new Response("{}", { status: 401 })]);
    const p = createAccessTokenProvider({ scope: SCOPE_A, store, fetch, clock: () => NOW, locks: new Map() });
    await expect(p.getAccessToken()).rejects.toMatchObject({ code: "token_expired" });
    expect(p.lastFailure?.code).toBe("token_expired");
    expect(await store.load(SCOPE_A)).not.toBeNull();
  });
  it("recovers when another process already rotated the pair", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(SCOPE_A, { client_id: "c", access_token: "old", refresh_token: "rt-0", expires_at: 0 });
    const fetch = tokenFetch([
      () => {
        // simulate the other process having rotated before our (now stale) refresh was rejected
        void store.save(SCOPE_A, { client_id: "c", access_token: "at-other", refresh_token: "rt-other", expires_at: NOW / 1000 + 86_400 });
        return new Response("{}", { status: 400 });
      },
    ]);
    const p = createAccessTokenProvider({ scope: SCOPE_A, store, fetch, clock: () => NOW, locks: new Map() });
    expect(await p.getAccessToken()).toBe("at-other");
  });
  it("transient refresh errors are transport errors", async () => {
    const store = new InMemoryCredentialStore();
    await store.save(SCOPE_A, { client_id: "c", access_token: "old", refresh_token: "rt-0", expires_at: 0 });
    const p = createAccessTokenProvider({ scope: SCOPE_A, store, fetch: tokenFetch([() => new Response("", { status: 502 })]), clock: () => NOW, locks: new Map() });
    const err = await p.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).code).toBe("transport");
    expect((err as BrokerError).retryable).toBe(true);
  });
});
