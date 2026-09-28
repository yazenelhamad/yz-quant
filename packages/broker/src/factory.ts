/**
 * Adapter construction and the per-scope registry.
 *
 * `createAdapter` builds an adapter bound to exactly one (scope, accountNumber). `AdapterRegistry`
 * hands adapters out by scope and can never return an adapter bound to a different scope.
 */
import type { BrokerKind, TenantScope } from "@yz/core";
import { CrossTenantError, assertScope, sameScope } from "@yz/core";
import type { BrokerAdapter, QuoteLookup } from "./adapter.js";
import { BrokerError } from "./errors.js";
import { RobinhoodAgenticAdapter } from "./robinhood/adapter.js";
import { EncryptedCredentialStore, type CredentialStore, type EncryptedCredentialCodec, type EnvelopeStore } from "./robinhood/credentialStore.js";
import { RobinhoodMcpClient, TokenBucketRateLimiter, type McpCallerFactory } from "./robinhood/mcpClient.js";
import { oauthEndpointsFromEnv, type EnvLike, type FetchLike, type OAuthEndpoints } from "./robinhood/oauth.js";
import { createSdkMcpCallerFactory } from "./robinhood/sdkCaller.js";
import { createAccessTokenProvider } from "./robinhood/tokenProvider.js";
import { SimulatedBrokerAdapter, type MarketDataMethods, type QuoteSource } from "./simulated/adapter.js";

export interface CreateAdapterOptions {
  kind: BrokerKind;
  scope: TenantScope;
  accountNumber: string;
  /** Credential persistence. Either a ready `CredentialStore`, or an `EnvelopeStore` + `codec`. */
  credentialStore?: CredentialStore;
  envelopeStore?: EnvelopeStore;
  codec?: EncryptedCredentialCodec;
  env?: EnvLike;
  endpoints?: OAuthEndpoints;
  fetch?: FetchLike;
  clock?: () => number;
  /** Override the MCP transport (tests inject a fake caller). */
  callerFactory?: McpCallerFactory;
  quoteLookup?: QuoteLookup | null;
  brokerageAccountType?: string;
  /** Simulated adapter inputs (shadow mode). */
  simulated?: {
    quoteSource: QuoteSource;
    initialCash?: number;
    initialPositions?: { symbol: string; quantity: number; averageCost: number }[];
    slippageBps?: number;
    partialFills?: { probability: number; minFraction: number } | null;
    latencyMs?: number;
    feePerFill?: number;
    marketData?: Partial<MarketDataMethods> | null;
    seed?: number;
    rng?: () => number;
  };
}

export function createAdapter(opts: CreateAdapterOptions): BrokerAdapter {
  assertScope(opts.scope, "createAdapter");
  const scope: TenantScope = { userId: opts.scope.userId, brokerAccountId: opts.scope.brokerAccountId };
  const clock = opts.clock ?? Date.now;

  if (opts.kind === "simulated") {
    if (!opts.simulated?.quoteSource) throw new BrokerError("invalid_request", "simulated adapter requires simulated.quoteSource");
    const s = opts.simulated;
    return new SimulatedBrokerAdapter({ scope, accountNumber: opts.accountNumber, quoteSource: s.quoteSource, clock, rng: s.rng, seed: s.seed, initialCash: s.initialCash, initialPositions: s.initialPositions, slippageBps: s.slippageBps, partialFills: s.partialFills, latencyMs: s.latencyMs, feePerFill: s.feePerFill, marketData: s.marketData });
  }

  if (opts.kind !== "robinhood_agentic") throw new BrokerError("unsupported", `unsupported broker kind ${String(opts.kind)}; only Robinhood's official Agentic Trading MCP is supported`);

  let store = opts.credentialStore;
  if (!store) {
    if (!opts.envelopeStore || !opts.codec) throw new BrokerError("invalid_request", "robinhood adapter requires credentialStore, or envelopeStore + codec");
    store = new EncryptedCredentialStore(opts.envelopeStore, opts.codec);
  }
  const endpoints = opts.endpoints ?? oauthEndpointsFromEnv(opts.env ?? {});
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const tokenProvider = createAccessTokenProvider({ scope, store, fetch: fetchImpl, endpoints, clock });
  const connect = opts.callerFactory ?? createSdkMcpCallerFactory({ mcpUrl: endpoints.mcpUrl, tokenProvider, fetch: fetchImpl });
  const client = new RobinhoodMcpClient({ connect, tokenProvider, clock, rateLimiter: new TokenBucketRateLimiter({ now: clock }) });
  return new RobinhoodAgenticAdapter({ scope, accountNumber: opts.accountNumber, client, clock, quoteLookup: opts.quoteLookup ?? null, brokerageAccountType: opts.brokerageAccountType });
}

const key = (scope: TenantScope): string => `${scope.userId}\u0000${scope.brokerAccountId}`;

/** Adapters keyed by tenant scope. Never yields an adapter bound to another scope. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, BrokerAdapter>();

  set(scope: TenantScope, adapter: BrokerAdapter): void {
    assertScope(scope, "AdapterRegistry.set");
    if (!sameScope(adapter.binding.scope, scope)) throw new CrossTenantError("AdapterRegistry.set: adapter is bound to a different scope", scope, adapter.binding.scope);
    this.adapters.set(key(scope), adapter);
  }

  get(scope: TenantScope): BrokerAdapter | null {
    assertScope(scope, "AdapterRegistry.get");
    const a = this.adapters.get(key(scope));
    if (!a) return null;
    if (!sameScope(a.binding.scope, scope)) throw new CrossTenantError("AdapterRegistry.get: stored adapter scope mismatch", scope, a.binding.scope);
    return a;
  }

  async getOrCreate(scope: TenantScope, create: () => BrokerAdapter | Promise<BrokerAdapter>): Promise<BrokerAdapter> {
    const existing = this.get(scope);
    if (existing) return existing;
    const created = await create();
    this.set(scope, created);
    return created;
  }

  delete(scope: TenantScope): boolean {
    assertScope(scope, "AdapterRegistry.delete");
    return this.adapters.delete(key(scope));
  }

  scopes(): TenantScope[] {
    return [...this.adapters.values()].map((a) => a.binding.scope);
  }
}
