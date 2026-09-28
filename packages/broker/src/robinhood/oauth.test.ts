import { describe, expect, it } from "vitest";
import { DEFAULT_OAUTH_ENDPOINTS, OAuthError, beginAuthorization, discover, exchangeCode, oauthEndpointsFromEnv, parseResourceMetadataHint, pkceChallenge, refreshCredential, type FetchLike } from "./oauth.js";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function fakeFetch(route: Route): FetchLike & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    calls.push({ url: u, init });
    const r = await route(u, init);
    return r ?? new Response("not found", { status: 404 });
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("discover", () => {
  it("follows the WWW-Authenticate hint → protected resource → authorization server metadata", async () => {
    const f = fakeFetch((url, init) => {
      if (url === DEFAULT_OAUTH_ENDPOINTS.mcpUrl && init?.method === "POST") return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading"' } });
      if (url === "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading") return json({ resource: DEFAULT_OAUTH_ENDPOINTS.mcpUrl, authorization_servers: ["https://auth.example.com/issuer"] });
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server/issuer") return json({ authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", registration_endpoint: "https://auth.example.com/register", scopes_supported: ["internal"] });
      return undefined;
    });
    const d = await discover(DEFAULT_OAUTH_ENDPOINTS.mcpUrl, f);
    expect(d).toMatchObject({ discoveredVia: "protected_resource", issuer: "https://auth.example.com/issuer", authorizeUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", registerUrl: "https://auth.example.com/register", scope: "internal" });
  });
  it("falls back to authorization-server metadata on the MCP origin", async () => {
    const f = fakeFetch((url) => {
      if (url === "https://agent.robinhood.com/.well-known/oauth-authorization-server") return json({ authorization_endpoint: "https://robinhood.com/oauth", token_endpoint: "https://api.robinhood.com/oauth2/token/" });
      return undefined;
    });
    const d = await discover(DEFAULT_OAUTH_ENDPOINTS.mcpUrl, f);
    expect(d.discoveredVia).toBe("authorization_server");
    expect(d.registerUrl).toBe(DEFAULT_OAUTH_ENDPOINTS.registerUrl);
  });
  it("falls back to the documented endpoints when discovery fails or throws", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const d = await discover(DEFAULT_OAUTH_ENDPOINTS.mcpUrl, f);
    expect(d).toMatchObject({ ...DEFAULT_OAUTH_ENDPOINTS, discoveredVia: "fallback" });
  });
  it("parses resource_metadata hints and env overrides", () => {
    expect(parseResourceMetadataHint('Bearer realm="x", resource_metadata="https://a/b"')).toBe("https://a/b");
    expect(parseResourceMetadataHint(null)).toBeNull();
    expect(oauthEndpointsFromEnv({ ROBINHOOD_OAUTH_TOKEN_URL: "https://override/token", ROBINHOOD_MCP_URL: "  " })).toMatchObject({ tokenUrl: "https://override/token", mcpUrl: DEFAULT_OAUTH_ENDPOINTS.mcpUrl });
  });
});

describe("authorization code + PKCE flow", () => {
  const seeded = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff));

  it("registers a public client and builds the authorize URL with S256", async () => {
    const f = fakeFetch((url, init) => {
      if (url === DEFAULT_OAUTH_ENDPOINTS.registerUrl) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ redirect_uris: ["https://app.local/oauth/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], scope: "internal" });
        return json({ client_id: "client-123" }, 201);
      }
      return undefined;
    });
    const start = await beginAuthorization({ redirectUri: "https://app.local/oauth/callback", fetch: f, random: seeded });
    expect(start.clientId).toBe("client-123");
    const u = new URL(start.authorizationUrl);
    expect(u.origin + u.pathname).toBe("https://robinhood.com/oauth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("state")).toBe(start.state);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("resource")).toBe("https://agent.robinhood.com/mcp/trading");
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge(start.codeVerifier));
    expect(start.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(start.authorizationUrl).not.toContain(start.codeVerifier);
  });

  it("fails registration loudly", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    await expect(beginAuthorization({ redirectUri: "https://app.local/cb", fetch: f })).rejects.toBeInstanceOf(OAuthError);
  });

  it("exchanges the code for a credential with the verifier", async () => {
    const f = fakeFetch((url, init) => {
      if (url === DEFAULT_OAUTH_ENDPOINTS.tokenUrl) {
        const form = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(form)).toEqual({ grant_type: "authorization_code", code: "auth-code", redirect_uri: "https://app.local/cb", client_id: "client-123", code_verifier: "verifier-xyz", resource: "https://agent.robinhood.com/mcp/trading" });
        expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
        return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" });
      }
      return undefined;
    });
    const cred = await exchangeCode({ code: "auth-code", codeVerifier: "verifier-xyz", clientId: "client-123", redirectUri: "https://app.local/cb", fetch: f, now: () => 1_000_000 });
    expect(cred).toEqual({ client_id: "client-123", access_token: "at-1", refresh_token: "rt-1", expires_at: 1_003_600, token_type: "Bearer" });
  });

  it("rotates the refresh token and returns the new pair", async () => {
    const f = fakeFetch((url, init) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(form).toEqual({ grant_type: "refresh_token", refresh_token: "rt-1", client_id: "client-123", resource: "https://agent.robinhood.com/mcp/trading" });
      return json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 900 });
    });
    const r = await refreshCredential({ client_id: "client-123", access_token: "at-1", refresh_token: "rt-1", expires_at: 0 }, f, { now: () => 100 });
    expect(r).toEqual({ status: "rotated", credential: { client_id: "client-123", access_token: "at-2", refresh_token: "rt-2", expires_at: 1000 } });
  });

  it("reports 4xx as revoked and 5xx/network as transient", async () => {
    const cred = { client_id: "c", access_token: "a", refresh_token: "r", expires_at: 0 };
    expect(await refreshCredential(cred, fakeFetch(() => new Response("{}", { status: 400 })))).toEqual({ status: "revoked", httpStatus: 400 });
    expect(await refreshCredential(cred, fakeFetch(() => new Response("", { status: 503 })))).toMatchObject({ status: "transient_error", httpStatus: 503 });
    expect(await refreshCredential(cred, fakeFetch(() => { throw new Error("boom"); }))).toMatchObject({ status: "transient_error", httpStatus: null });
  });
});
