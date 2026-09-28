/**
 * Fresh access tokens for one tenant scope.
 *
 * - refreshes when the token is within `skewSeconds` (default 60 min) of expiry
 * - single-flight: concurrent callers share one refresh per scope (process-wide lock map)
 * - refresh tokens rotate; the new pair is persisted before the access token is handed out
 * - a rejected refresh (4xx) re-reads the store once (another process may have rotated) and
 *   otherwise surfaces `token_expired` so the UI can ask the user to sign in again
 */
import type { TenantScope } from "@yz/core";
import { assertScope } from "@yz/core";
import { BrokerError } from "../errors.js";
import type { CredentialStore } from "./credentialStore.js";
import { scopeKey } from "./credentialStore.js";
import { DEFAULT_OAUTH_ENDPOINTS, needsRefresh, refreshCredential, type Credential, type FetchLike, type OAuthEndpoints } from "./oauth.js";

export interface AccessTokenProvider {
  readonly scope: TenantScope;
  /** Throws BrokerError(not_connected | token_expired | transport). Never logs the token. */
  getAccessToken(): Promise<string>;
  hasCredential(): Promise<boolean>;
  /** Force a refresh on the next call (e.g. after an upstream 401). */
  invalidate(): void;
  /** Last credential-level failure, for status reporting. */
  readonly lastFailure: { code: "not_connected" | "token_expired" | "transport"; at: number } | null;
}

export interface AccessTokenProviderOptions {
  scope: TenantScope;
  store: CredentialStore;
  fetch: FetchLike;
  endpoints?: OAuthEndpoints;
  /** Milliseconds since epoch. */
  clock?: () => number;
  skewSeconds?: number;
  /** Shared lock map so that several providers for the same scope (should not happen, but) refresh once. */
  locks?: Map<string, Promise<Credential>>;
}

const processLocks = new Map<string, Promise<Credential>>();

export const DEFAULT_REFRESH_SKEW_SECONDS = 3600;

export function createAccessTokenProvider(opts: AccessTokenProviderOptions): AccessTokenProvider {
  assertScope(opts.scope, "createAccessTokenProvider");
  const scope: TenantScope = { userId: opts.scope.userId, brokerAccountId: opts.scope.brokerAccountId };
  const key = scopeKey(scope);
  const clock = opts.clock ?? Date.now;
  const skew = opts.skewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
  const endpoints = opts.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  const locks = opts.locks ?? processLocks;
  let forceRefresh = false;
  let lastFailure: AccessTokenProvider["lastFailure"] = null;

  const fail = (code: "not_connected" | "token_expired" | "transport", message: string, extra: { retryable?: boolean; details?: Record<string, unknown> } = {}): BrokerError => {
    lastFailure = { code, at: clock() };
    return new BrokerError(code, message, { tool: null, ...extra });
  };

  async function refreshOnce(current: Credential): Promise<Credential> {
    const nowSec = clock() / 1000;
    const result = await refreshCredential(current, opts.fetch, { endpoints, now: () => nowSec });
    if (result.status === "rotated") {
      await opts.store.save(scope, result.credential);
      return result.credential;
    }
    if (result.status === "transient_error") {
      throw fail("transport", `token refresh failed transiently${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}`, { retryable: true });
    }
    // 4xx: our refresh token is dead. Maybe another process rotated it — re-read once.
    const reloaded = await opts.store.load(scope);
    if (reloaded && reloaded.refresh_token !== current.refresh_token) {
      if (!needsRefresh(reloaded, nowSec, skew)) return reloaded;
      const again = await refreshCredential(reloaded, opts.fetch, { endpoints, now: () => nowSec });
      if (again.status === "rotated") {
        await opts.store.save(scope, again.credential);
        return again.credential;
      }
    }
    throw fail("token_expired", `Robinhood refresh token rejected (HTTP ${result.httpStatus}); the user must reconnect the account`, {
      details: { reason: "refresh_rejected", httpStatus: result.httpStatus },
    });
  }

  function refreshSingleFlight(current: Credential): Promise<Credential> {
    const inflight = locks.get(key);
    if (inflight) return inflight;
    const p = refreshOnce(current).finally(() => {
      if (locks.get(key) === p) locks.delete(key);
    });
    locks.set(key, p);
    return p;
  }

  return {
    scope,
    get lastFailure() {
      return lastFailure;
    },
    invalidate() {
      forceRefresh = true;
    },
    async hasCredential() {
      return (await opts.store.load(scope)) !== null;
    },
    async getAccessToken() {
      const cred = await opts.store.load(scope);
      if (!cred) throw fail("not_connected", "no Robinhood credential stored for this account; connect it first");
      if (!forceRefresh && !needsRefresh(cred, clock() / 1000, skew)) {
        lastFailure = null;
        return cred.access_token;
      }
      const fresh = await refreshSingleFlight(cred);
      forceRefresh = false;
      lastFailure = null;
      return fresh.access_token;
    },
  };
}
