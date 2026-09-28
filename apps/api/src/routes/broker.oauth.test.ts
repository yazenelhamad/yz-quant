import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OAUTH_ENDPOINTS, type FetchLike } from "@yz/broker";
import { loadObservedTools, rawAccount, ACCT_A } from "@yz/broker/testing/fixtures";
import { createHarness, type Harness } from "../services/pipeline/testHarness.js";

interface Recorded { url: string; method: string; body: unknown; auth: string | null }

/**
 * Fake Robinhood: OAuth registration + token endpoints and a JSON-mode MCP server (Streamable HTTP
 * answering every POST with application/json) that serves tools/list from the observed catalogue
 * and get_accounts with one agentic account.
 */
function fakeRobinhood(): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const tools = loadObservedTools();
  const fetch: FetchLike = async (url, init) => {
    const u = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (init?.body) { const text = typeof init.body === "string" ? init.body : String(init.body); try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); } }
    calls.push({ url: u, method, body, auth: headers.get("authorization") });
    if (u === DEFAULT_OAUTH_ENDPOINTS.registerUrl) return json({ client_id: "client-123" }, 201);
    if (u === DEFAULT_OAUTH_ENDPOINTS.tokenUrl) {
      const form = body as Record<string, string>;
      if (form.grant_type === "refresh_token") return form.refresh_token === "rt-1" ? json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 7200 }) : json({ error: "invalid_grant" }, 400);
      if (form.grant_type !== "authorization_code" || form.code !== "auth-code-xyz" || !form.code_verifier) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 7200, token_type: "Bearer" });
    }
    if (u === DEFAULT_OAUTH_ENDPOINTS.mcpUrl) {
      if (headers.get("authorization") !== "Bearer at-1") return new Response("", { status: 401 });
      if (method === "GET") return new Response("", { status: 405 });
      if (method === "DELETE") return new Response("", { status: 200 });
      const msg = body as { id?: number | string; method?: string; params?: { name?: string; protocolVersion?: string } };
      const reply = (result: unknown) => json({ jsonrpc: "2.0", id: msg.id, result }, 200, { "mcp-session-id": "sess-1" });
      switch (msg.method) {
        case "initialize": return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-robinhood", version: "0" } });
        case "notifications/initialized": return new Response("", { status: 202 });
        case "tools/list": return reply({ tools });
        case "tools/call": {
          const name = msg.params?.name;
          const data = name === "get_accounts" ? { accounts: [rawAccount()] } : null;
          if (!data) return reply({ content: [{ type: "text", text: `fake: no handler for ${name}` }], isError: true });
          const envelope = { data, guide: "" };
          return reply({ content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope });
        }
        default: return reply({});
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

let hz: Harness;
let rh: { fetch: FetchLike; calls: Recorded[] };
let accountId: string;

beforeAll(async () => {
  rh = fakeRobinhood();
  hz = await createHarness({ fetch: rh.fetch, env: { API_ORIGIN: "https://api.example.test", APP_ORIGIN: "https://app.example.test" } });
  accountId = (await hz.ctx.repos.accounts.create({ userId: hz.users.trader.id, kind: "robinhood_agentic", label: "Robinhood", accountNumber: "pending-abc" })).id;
});
afterAll(async () => { await hz.close(); });

describe("Robinhood OAuth connect + callback", () => {
  it("connect needs step-up and ownership; the callback completes with the state alone and binds to the right user/account", async () => {
    const plain = await hz.login(hz.users.trader.email);
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${accountId}/broker/connect`, headers: plain.headers })).statusCode).toBe(428);
    const admin = await hz.login(hz.users.admin.email, { stepUp: true });
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${accountId}/broker/connect`, headers: admin.headers })).statusCode).toBe(403);

    const t = await hz.login(hz.users.trader.email, { stepUp: true });
    const start = await hz.app.inject({ method: "POST", url: `/api/accounts/${accountId}/broker/connect`, headers: t.headers });
    expect(start.statusCode).toBe(200);
    const authUrl = new URL(start.json().authorizationUrl as string);
    expect(authUrl.origin + authUrl.pathname).toBe("https://robinhood.com/oauth");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://api.example.test/api/broker/oauth/callback");
    const state = authUrl.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(20);
    expect((await hz.ctx.repos.accounts.byId(accountId))?.status).toBe("connecting");

    // Unknown state: refused, nothing stored.
    const bad = await hz.app.inject({ method: "GET", url: `/api/broker/oauth/callback?code=auth-code-xyz&state=not-a-real-state` });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers["content-type"]).toMatch(/text\/html/);
    expect(bad.body).toContain("Unknown or expired authorization state");
    expect(await hz.ctx.repos.credentials.get({ userId: hz.users.trader.id, brokerAccountId: accountId })).toBeUndefined();

    // Real callback: NO session cookie (SameSite=Strict drops it on the cross-site redirect).
    const cb = await hz.app.inject({ method: "GET", url: `/api/broker/oauth/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode, cb.body).toBe(200);
    expect(cb.headers["content-type"]).toMatch(/text\/html/);
    expect(cb.body).toContain(`https://app.example.test/settings?connected=1&amp;account=${accountId}`);
    expect(cb.body).not.toContain("at-1");
    expect(cb.body).not.toContain("rt-1");

    const account = (await hz.ctx.repos.accounts.byId(accountId))!;
    expect(account.userId).toBe(hz.users.trader.id);
    expect(account.status).toBe("connected");
    expect(account.accountNumber).toBe(ACCT_A);
    expect(account.agenticAllowed).toBe(true);
    expect(account.statusDetail).toContain("••••2345");
    const cred = await hz.ctx.repos.credentials.get({ userId: hz.users.trader.id, brokerAccountId: accountId });
    expect(cred?.credentialEnc).toBeTruthy();
    expect(cred?.credentialEnc).not.toContain("at-1");
    // The other user got nothing.
    expect(await hz.ctx.repos.credentials.get({ userId: hz.users.admin.id, brokerAccountId: accountId })).toBeUndefined();

    // Token exchange carried the code and the PKCE verifier; the MCP probe carried the bearer token.
    const token = rh.calls.find((c) => c.url === DEFAULT_OAUTH_ENDPOINTS.tokenUrl)!;
    expect(token.body).toMatchObject({ grant_type: "authorization_code", code: "auth-code-xyz", client_id: "client-123", redirect_uri: "https://api.example.test/api/broker/oauth/callback" });
    expect((token.body as { code_verifier: string }).code_verifier.length).toBeGreaterThanOrEqual(43);
    expect(rh.calls.some((c) => c.url === DEFAULT_OAUTH_ENDPOINTS.mcpUrl && c.auth === "Bearer at-1" && (c.body as { method?: string } | null)?.method === "tools/call")).toBe(true);

    // State is single-use.
    const replay = await hz.app.inject({ method: "GET", url: `/api/broker/oauth/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}` });
    expect(replay.statusCode).toBe(400);

    // Audit trail: started, completed (bound to the trader), and the two failures.
    const audit = await hz.ctx.repos.audit.recent({ category: "broker", limit: 100 });
    expect(audit.find((a) => a.action === "connect_started")).toMatchObject({ userId: hz.users.trader.id, brokerAccountId: accountId });
    expect(audit.find((a) => a.action === "connected")).toMatchObject({ userId: hz.users.trader.id, brokerAccountId: accountId });
    expect(audit.find((a) => a.action === "connect_callback_completed")).toMatchObject({ userId: hz.users.trader.id, brokerAccountId: accountId, result: "ok" });
    expect(audit.filter((a) => a.action === "connect_callback_failed")).toHaveLength(2);
    expect(audit.every((a) => !JSON.stringify(a.detail).includes("at-1") && !(a.error ?? "").includes("at-1"))).toBe(true);

    // Status now reflects the connection (masked number, tools list from the fake server).
    const status = await hz.app.inject({ method: "GET", url: `/api/accounts/${accountId}/broker/status`, headers: t.headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: "connected", agenticAccountNumberMasked: "••••2345" });
    expect(status.json().tools).toContain("place_equity_order");
  });

  it("renders provider errors and malformed callbacks as HTML without touching any account", async () => {
    const denied = await hz.app.inject({ method: "GET", url: "/api/broker/oauth/callback?error=access_denied&error_description=User%20cancelled&state=x" });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain("access_denied: User cancelled");
    expect(denied.body).toContain("https://app.example.test/settings?connected=0");
    const missing = await hz.app.inject({ method: "GET", url: "/api/broker/oauth/callback?state=only" });
    expect(missing.statusCode).toBe(400);
    const xss = await hz.app.inject({ method: "GET", url: "/api/broker/oauth/callback?error=%3Cscript%3Ealert(1)%3C/script%3E" });
    expect(xss.body).not.toContain("<script>alert");
    expect(xss.body).toContain("&lt;script&gt;");
    expect((await hz.ctx.repos.accounts.byId(accountId))?.status).toBe("connected");
  });

  it("disconnect requires step-up, deletes the credential and pauses the account", async () => {
    const plain = await hz.login(hz.users.trader.email);
    expect((await hz.app.inject({ method: "POST", url: `/api/accounts/${accountId}/broker/disconnect`, headers: plain.headers })).statusCode).toBe(428);
    const t = await hz.login(hz.users.trader.email, { stepUp: true });
    const res = await hz.app.inject({ method: "POST", url: `/api/accounts/${accountId}/broker/disconnect`, headers: t.headers });
    expect(res.statusCode).toBe(200);
    const account = (await hz.ctx.repos.accounts.byId(accountId))!;
    expect(account.status).toBe("not_connected");
    expect(account.tradingPaused).toBe(true);
    expect(await hz.ctx.repos.credentials.get({ userId: hz.users.trader.id, brokerAccountId: accountId })).toBeUndefined();
    const sync = await hz.app.inject({ method: "POST", url: `/api/accounts/${accountId}/broker/sync`, headers: t.headers });
    expect(sync.statusCode).toBe(503);
  });
});
