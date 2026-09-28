/**
 * OAuth 2.1 (authorization code + PKCE S256) with dynamic client registration (RFC 7591)
 * against Robinhood's official Agentic Trading MCP.
 *
 * Pure functions with an injectable `fetch`. Nothing here logs, stores or prints token material.
 *
 * Endpoint discovery order (per the capability map):
 *   1. RFC 9728 protected-resource metadata (`/.well-known/oauth-protected-resource`), optionally
 *      hinted by the `WWW-Authenticate: Bearer resource_metadata="..."` of an unauthenticated initialize.
 *   2. RFC 8414 authorization-server metadata for the discovered issuer (or the MCP origin).
 *   3. Documented fallback endpoints (overridable via ROBINHOOD_* environment variables).
 *
 * Refresh tokens are single-use and rotate on every grant; `refreshCredential` always hands back
 * the new pair and never reuses the old refresh token.
 */
import { createHash, randomBytes } from "node:crypto";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface OAuthEndpoints {
  mcpUrl: string;
  registerUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export const DEFAULT_OAUTH_ENDPOINTS: Readonly<OAuthEndpoints> = Object.freeze({
  mcpUrl: "https://agent.robinhood.com/mcp/trading",
  registerUrl: "https://agent.robinhood.com/oauth/trading/register",
  authorizeUrl: "https://robinhood.com/oauth",
  tokenUrl: "https://api.robinhood.com/oauth2/token/",
  scope: "internal",
});

export type EnvLike = Record<string, string | undefined>;

/** Reads the ROBINHOOD_* overrides from an env-like object (see .env.example). Blank values fall back to the defaults. */
export function oauthEndpointsFromEnv(env: EnvLike, fallback: OAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS): OAuthEndpoints {
  const pick = (key: string, dflt: string): string => {
    const v = env[key]?.trim();
    return v && v.length > 0 ? v : dflt;
  };
  return {
    mcpUrl: pick("ROBINHOOD_MCP_URL", fallback.mcpUrl),
    registerUrl: pick("ROBINHOOD_OAUTH_REGISTER_URL", fallback.registerUrl),
    authorizeUrl: pick("ROBINHOOD_OAUTH_AUTHORIZE_URL", fallback.authorizeUrl),
    tokenUrl: pick("ROBINHOOD_OAUTH_TOKEN_URL", fallback.tokenUrl),
    scope: pick("ROBINHOOD_OAUTH_SCOPE", fallback.scope),
  };
}

/** Stored credential shape. `expires_at` is unix seconds. */
export interface Credential {
  client_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
}

export function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.client_id === "string" &&
    typeof c.access_token === "string" &&
    typeof c.refresh_token === "string" &&
    typeof c.expires_at === "number" &&
    Number.isFinite(c.expires_at)
  );
}

export type OAuthErrorKind = "discovery_failed" | "registration_failed" | "exchange_failed" | "refresh_rejected" | "refresh_failed" | "invalid_response";

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(readonly kind: OAuthErrorKind, message: string, readonly httpStatus: number | null = null) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type DiscoveryMethod = "protected_resource" | "authorization_server" | "fallback";

export interface DiscoveredEndpoints extends OAuthEndpoints {
  discoveredVia: DiscoveryMethod;
  issuer: string | null;
}

async function fetchJson(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, { ...init, headers: { Accept: "application/json", ...(init?.headers as Record<string, string> | undefined) } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function wellKnownCandidates(baseUrl: string, suffix: string): string[] {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const out: string[] = [];
  if (path.length > 0 && path !== "/") out.push(`${u.origin}/.well-known/${suffix}${path}`);
  out.push(`${u.origin}/.well-known/${suffix}`);
  return out;
}

/** Parses `resource_metadata="..."` out of a WWW-Authenticate header, if present. */
export function parseResourceMetadataHint(wwwAuthenticate: string | null | undefined): string | null {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate) ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(wwwAuthenticate);
  return m?.[1] ?? null;
}

async function protectedResourceHint(fetchImpl: FetchLike, mcpUrl: string): Promise<string | null> {
  try {
    const res = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "yz-quant-discovery", version: "0" } } }),
    });
    if (res.status !== 401) return null;
    return parseResourceMetadataHint(res.headers.get("www-authenticate"));
  } catch {
    return null;
  }
}

async function authorizationServerMetadata(fetchImpl: FetchLike, issuer: string): Promise<Record<string, unknown> | null> {
  const candidates = [...wellKnownCandidates(issuer, "oauth-authorization-server"), ...wellKnownCandidates(issuer, "openid-configuration")];
  for (const url of candidates) {
    const meta = await fetchJson(fetchImpl, url);
    if (meta && typeof meta.authorization_endpoint === "string" && typeof meta.token_endpoint === "string") return meta;
  }
  return null;
}

/**
 * Discover OAuth endpoints for the MCP server. Never throws: any failure falls back to the
 * documented endpoints (marked `discoveredVia: "fallback"`).
 */
export async function discover(mcpUrl: string, fetchImpl: FetchLike, fallback: OAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS): Promise<DiscoveredEndpoints> {
  const base: OAuthEndpoints = { ...fallback, mcpUrl };

  // 1. Protected resource metadata (RFC 9728)
  const hint = await protectedResourceHint(fetchImpl, mcpUrl);
  const prCandidates = [...(hint ? [hint] : []), ...wellKnownCandidates(mcpUrl, "oauth-protected-resource")];
  let issuer: string | null = null;
  for (const url of prCandidates) {
    const meta = await fetchJson(fetchImpl, url);
    const servers = meta?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      issuer = servers[0];
      break;
    }
  }

  // 2. Authorization server metadata (RFC 8414), for the issuer or the MCP origin itself.
  const issuers = issuer ? [issuer] : [new URL(mcpUrl).origin];
  for (const candidate of issuers) {
    const meta = await authorizationServerMetadata(fetchImpl, candidate);
    if (!meta) continue;
    const scopes = Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string") : [];
    return {
      ...base,
      authorizeUrl: meta.authorization_endpoint as string,
      tokenUrl: meta.token_endpoint as string,
      registerUrl: typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : base.registerUrl,
      scope: scopes.length > 0 && !scopes.includes(base.scope) ? scopes.join(" ") : base.scope,
      discoveredVia: issuer ? "protected_resource" : "authorization_server",
      issuer: candidate,
    };
  }

  // 3. Fallback
  return { ...base, discoveredVia: "fallback", issuer };
}

// ---------------------------------------------------------------------------
// PKCE + authorization
// ---------------------------------------------------------------------------

export type RandomBytes = (size: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => new Uint8Array(randomBytes(n));

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkce(random: RandomBytes = defaultRandom): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = b64url(random(48)); // 64 chars, within RFC 7636's 43..128
  return { codeVerifier, codeChallenge: pkceChallenge(codeVerifier), state: b64url(random(16)) };
}

export interface BeginAuthorizationOptions {
  redirectUri: string;
  fetch: FetchLike;
  endpoints?: OAuthEndpoints;
  clientName?: string;
  applicationType?: "web" | "native";
  random?: RandomBytes;
}

export interface AuthorizationStart {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  endpoints: OAuthEndpoints;
}

/** Registers a public client (RFC 7591) and builds the PKCE authorization URL. The caller persists `state`, `codeVerifier` and `clientId` server-side, keyed by the pending session. */
export async function beginAuthorization(opts: BeginAuthorizationOptions): Promise<AuthorizationStart> {
  const endpoints = opts.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  const clientId = await registerClient(opts.fetch, endpoints, opts.redirectUri, opts.clientName ?? "yz-quant", opts.applicationType ?? "web");
  const { codeVerifier, codeChallenge, state } = generatePkce(opts.random);
  const url = new URL(endpoints.authorizeUrl);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: endpoints.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { authorizationUrl: url.toString(), state, codeVerifier, clientId, redirectUri: opts.redirectUri, endpoints };
}

async function registerClient(fetchImpl: FetchLike, endpoints: OAuthEndpoints, redirectUri: string, clientName: string, applicationType: "web" | "native"): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(endpoints.registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: applicationType,
        scope: endpoints.scope,
      }),
    });
  } catch (e) {
    throw new OAuthError("registration_failed", `client registration failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new OAuthError("registration_failed", `client registration failed: HTTP ${res.status}`, res.status);
  const body = (await res.json().catch(() => null)) as { client_id?: unknown } | null;
  if (!body || typeof body.client_id !== "string" || body.client_id.length === 0) {
    throw new OAuthError("invalid_response", "client registration returned no client_id", res.status);
  }
  return body.client_id;
}

// ---------------------------------------------------------------------------
// Token grants
// ---------------------------------------------------------------------------

interface GrantResponse {
  status: number;
  body: Record<string, unknown> | null;
}

async function tokenGrant(fetchImpl: FetchLike, tokenUrl: string, form: Record<string, string>): Promise<GrantResponse> {
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) return { status: res.status, body: null };
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null };
}

function credentialFromGrant(clientId: string, body: Record<string, unknown>, nowSeconds: number, previousRefreshToken: string | null): Credential {
  const accessToken = body.access_token;
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : previousRefreshToken;
  if (typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new OAuthError("invalid_response", "token response carried no access_token or refresh_token");
  }
  const expiresIn = Number(body.expires_in);
  const cred: Credential = {
    client_id: clientId,
    access_token: accessToken,
    refresh_token: refreshToken,
    // A missing expires_in makes the token stale at once, so the next use refreshes.
    expires_at: Math.floor(nowSeconds) + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 0),
  };
  if (typeof body.token_type === "string") cred.token_type = body.token_type;
  if (typeof body.scope === "string") cred.scope = body.scope;
  return cred;
}

export interface ExchangeCodeOptions {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  fetch: FetchLike;
  endpoints?: OAuthEndpoints;
  /** Unix seconds. */
  now?: () => number;
}

/** Exchanges the authorization code for the first credential pair. */
export async function exchangeCode(opts: ExchangeCodeOptions): Promise<Credential> {
  const endpoints = opts.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  let grant: GrantResponse;
  try {
    grant = await tokenGrant(opts.fetch, endpoints.tokenUrl, {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.codeVerifier,
    });
  } catch (e) {
    throw new OAuthError("exchange_failed", `token exchange failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!grant.body) throw new OAuthError("exchange_failed", `token exchange failed: HTTP ${grant.status}`, grant.status);
  return credentialFromGrant(opts.clientId, grant.body, (opts.now ?? nowSeconds)(), null);
}

export type RefreshResult =
  | { status: "rotated"; credential: Credential }
  /** 4xx from the token endpoint: the refresh token was consumed, revoked or expired. The user must sign in again. */
  | { status: "revoked"; httpStatus: number }
  /** 5xx / network: nothing was rotated; try again later with the same credential. */
  | { status: "transient_error"; httpStatus: number | null; message: string };

export interface RefreshOptions {
  endpoints?: OAuthEndpoints;
  now?: () => number;
}

/** Refresh grant. The returned credential is the *new* pair; the old refresh token is dead either way. */
export async function refreshCredential(cred: Credential, fetchImpl: FetchLike, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const endpoints = opts.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  let grant: GrantResponse;
  try {
    grant = await tokenGrant(fetchImpl, endpoints.tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
      client_id: cred.client_id,
    });
  } catch (e) {
    return { status: "transient_error", httpStatus: null, message: e instanceof Error ? e.message : String(e) };
  }
  if (!grant.body) {
    if (grant.status >= 400 && grant.status < 500) return { status: "revoked", httpStatus: grant.status };
    return { status: "transient_error", httpStatus: grant.status, message: `token refresh failed: HTTP ${grant.status}` };
  }
  try {
    return { status: "rotated", credential: credentialFromGrant(cred.client_id, grant.body, (opts.now ?? nowSeconds)(), cred.refresh_token) };
  } catch (e) {
    return { status: "transient_error", httpStatus: grant.status, message: e instanceof Error ? e.message : String(e) };
  }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** True when the access token should be refreshed before use (expired, or within `skewSeconds` of expiry). */
export function needsRefresh(cred: Credential, nowSec: number, skewSeconds: number): boolean {
  return cred.expires_at - nowSec <= skewSeconds;
}
