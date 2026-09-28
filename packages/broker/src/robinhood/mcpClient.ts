/**
 * Robinhood MCP client: the policy layer between the adapter and an `McpCaller`
 * (the SDK transport in production, a scripted fake in tests).
 *
 * Responsibilities
 *  - pre-flight credential check (typed not_connected / token_expired errors before any I/O)
 *  - token-bucket rate limiting (3 calls/s sustained, burst 5) with backoff on RATE_LIMITED
 *  - 30 s call timeout
 *  - reconnect once on transport error for READ tools only; a failed WRITE is never retried
 *    and is surfaced with `mayHaveReached: true`
 *  - tools/list cache + `assertToolSchema` drift check that fails closed for the tools we use
 *  - result parsing (structuredContent, else JSON text) and isError → typed BrokerError
 *  - consecutive-failure counter feeding the "unreliable" status
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { IsoTimestamp } from "@yz/core";
import type { AdapterStatus } from "../adapter.js";
import { BrokerError, isBrokerError, redactSecrets, type BrokerErrorCode } from "../errors.js";
import type { AccessTokenProvider } from "./tokenProvider.js";

// ---------------------------------------------------------------------------
// Transport-level interface (what the SDK client and the test fake implement)
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

export interface McpToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<McpToolResult>;
  listTools(): Promise<McpToolDefinition[]>;
  close?(): Promise<void>;
}

export type McpCallerFactory = () => Promise<McpCaller>;

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  ratePerSecond?: number;
  burst?: number;
  /** Milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TokenBucketRateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private last: number;
  private penaltyUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.rate = opts.ratePerSecond ?? 3;
    this.capacity = opts.burst ?? 5;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = t;
  }

  /** Waits (FIFO) until a token is available and no penalty is active, then consumes it. */
  acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        if (t < this.penaltyUntil) {
          await this.sleep(this.penaltyUntil - t);
          continue;
        }
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
        await this.sleep(Math.max(1, waitMs));
      }
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Blocks all callers for `ms` (used on RATE_LIMITED answers). */
  penalize(ms: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.now() + ms);
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  get penaltyEndsAt(): number {
    return this.penaltyUntil;
  }
}

// ---------------------------------------------------------------------------
// Tool registry: the only tools this package will ever call, with the inputs we rely on.
// ---------------------------------------------------------------------------

export type ToolKind = "read" | "write";

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  /** Inputs the adapter sends and therefore requires the server to still accept. */
  requiredInputs: string[];
  /** Every input the adapter may send. If the server starts *requiring* something else, we fail closed. */
  knownInputs: string[];
}

function spec(name: string, kind: ToolKind, requiredInputs: string[], optional: string[] = []): ToolSpec {
  return { name, kind, requiredInputs, knownInputs: [...requiredInputs, ...optional] };
}

export const ROBINHOOD_TOOLS = {
  get_accounts: spec("get_accounts", "read", []),
  get_portfolio: spec("get_portfolio", "read", ["account_number"]),
  get_equity_positions: spec("get_equity_positions", "read", ["account_number"], ["cursor"]),
  get_equity_orders: spec("get_equity_orders", "read", ["account_number"], ["order_id", "state", "symbol", "created_at_gte", "placed_agent", "cursor"]),
  review_equity_order: spec("review_equity_order", "read", ["account_number", "symbol", "side", "type"], ["quantity", "dollar_amount", "limit_price", "stop_price", "time_in_force", "market_hours", "tax_lots"]),
  place_equity_order: spec("place_equity_order", "write", ["account_number", "symbol", "side", "type"], ["quantity", "dollar_amount", "limit_price", "stop_price", "time_in_force", "market_hours", "tax_lots", "ref_id"]),
  cancel_equity_order: spec("cancel_equity_order", "write", ["account_number", "order_id"]),
  get_equity_tax_lots: spec("get_equity_tax_lots", "read", ["account_number", "symbol"], ["cursor"]),
  get_realized_pnl: spec("get_realized_pnl", "read", ["account_number"], ["span", "start_date", "end_date", "asset_classes", "display_currency", "timezone"]),
  get_pnl_trade_history: spec("get_pnl_trade_history", "read", ["account_number"], ["span", "symbol", "cursor"]),
  get_equity_quotes: spec("get_equity_quotes", "read", ["symbols"]),
  get_equity_historicals: spec("get_equity_historicals", "read", ["symbols", "start_time"], ["end_time", "interval", "bounds", "adjustment_type"]),
  get_equity_price_book: spec("get_equity_price_book", "read", ["symbols"]),
  get_equity_tradability: spec("get_equity_tradability", "read", ["account_number", "symbols"]),
  search: spec("search", "read", ["query"], ["asset_type", "limit"]),
  get_popular_watchlists: spec("get_popular_watchlists", "read", []),
  get_watchlist_items: spec("get_watchlist_items", "read", ["list_id"]),
  get_equity_fundamentals: spec("get_equity_fundamentals", "read", ["symbols"], ["bounds"]),
  get_financials: spec("get_financials", "read", ["symbols"], ["period", "limit"]),
  get_equity_analyst_ratings: spec("get_equity_analyst_ratings", "read", ["symbols"]),
  get_equity_news: spec("get_equity_news", "read", ["symbol"], ["limit", "cursor"]),
  get_earnings_results: spec("get_earnings_results", "read", ["symbol"]),
  get_earnings_calendar: spec("get_earnings_calendar", "read", [], ["start_date", "days", "filter"]),
  get_indexes: spec("get_indexes", "read", [], ["symbols"]),
  get_index_quotes: spec("get_index_quotes", "read", ["instrument_ids"]),
  get_index_historicals: spec("get_index_historicals", "read", ["instrument_ids", "start_time", "interval"], ["end_time"]),
  get_option_chains: spec("get_option_chains", "read", [], ["ids", "underlying_symbol"]),
  get_option_instruments: spec("get_option_instruments", "read", [], ["chain_id", "chain_symbol", "expiration_dates", "strike_price", "type", "state", "tradability", "ids", "cursor"]),
  get_option_quotes: spec("get_option_quotes", "read", ["instrument_ids"]),
} as const satisfies Record<string, ToolSpec>;

export type RobinhoodToolName = keyof typeof ROBINHOOD_TOOLS;

// ---------------------------------------------------------------------------
// Result parsing & error classification (exported for tests)
// ---------------------------------------------------------------------------

export interface ToolCallResult<T = unknown> {
  data: T;
  guide: string | null;
  receivedAt: IsoTimestamp;
  raw: unknown;
}

function firstText(result: McpToolResult): string | null {
  for (const block of result.content ?? []) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
  }
  return null;
}

/** Prefer structuredContent, else JSON in the first text block. Unwraps the official `{data, guide}` envelope. */
export function parseToolResult(result: McpToolResult, tool: string): { data: unknown; guide: string | null; raw: unknown } {
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const text = firstText(result);
    if (text === null) throw new BrokerError("schema_drift", `tool ${tool} returned neither structuredContent nor text content`, { tool });
    try {
      payload = JSON.parse(text);
    } catch {
      throw new BrokerError("schema_drift", `tool ${tool} returned non-JSON text content`, { tool });
    }
  }
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    const env = payload as { data: unknown; guide?: unknown };
    return { data: env.data, guide: typeof env.guide === "string" ? env.guide : null, raw: payload };
  }
  return { data: payload, guide: null, raw: payload };
}

const RATE_LIMIT_RE = /RATE_LIMITED|rate.?limit|too many requests/i;
const AUTH_RE = /unauthori[sz]ed|invalid[_ ]token|token.*expired|expired.*token|not authenticated|authentication required/i;

/** Classifies a tool result with isError=true. The server answered, so the write did NOT happen. */
export function classifyErrorResult(result: McpToolResult, tool: string): BrokerError {
  const text = redactSecrets(firstText(result) ?? "tool error without message");
  if (RATE_LIMIT_RE.test(text)) return new BrokerError("rate_limited", `Robinhood rate limited ${tool}`, { tool, retryable: true, details: { upstream: text } });
  if (AUTH_RE.test(text)) return new BrokerError("token_expired", `Robinhood rejected the credential on ${tool}`, { tool, details: { upstream: text } });
  return new BrokerError("upstream_rejected", `Robinhood rejected ${tool}: ${text}`, { tool, details: { upstream: text } });
}

function httpStatusOf(e: unknown): number | null {
  if (typeof e !== "object" || e === null) return null;
  const o = e as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown };
  for (const v of [o.status, o.statusCode]) if (typeof v === "number" && v >= 100 && v < 600) return v;
  if (o.name === "StreamableHTTPError" && typeof o.code === "number") return o.code;
  return null;
}

export class CallTimeoutError extends Error {
  override readonly name = "CallTimeoutError";
}

/** Classifies an exception thrown by the transport/SDK. `transport` errors may have reached the server. */
export function classifyThrown(e: unknown, tool: string): BrokerError {
  if (isBrokerError(e)) return e;
  const message = redactSecrets(e instanceof Error ? e.message : String(e));
  if (e instanceof CallTimeoutError) return new BrokerError("transport", `${tool} timed out`, { tool, retryable: true, cause: e });
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout || e.code === ErrorCode.ConnectionClosed) {
      return new BrokerError("transport", `${tool}: ${message}`, { tool, retryable: true, cause: e });
    }
    if (RATE_LIMIT_RE.test(message)) return new BrokerError("rate_limited", `Robinhood rate limited ${tool}`, { tool, retryable: true, cause: e });
    if (AUTH_RE.test(message)) return new BrokerError("token_expired", `${tool}: ${message}`, { tool, cause: e });
    return new BrokerError("upstream_rejected", `${tool}: ${message}`, { tool, cause: e, details: { jsonRpcCode: e.code } });
  }
  const status = httpStatusOf(e);
  if (status === 401 || status === 403 || AUTH_RE.test(message)) return new BrokerError("token_expired", `${tool}: upstream refused the credential${status ? ` (HTTP ${status})` : ""}`, { tool, cause: e });
  if (status === 429 || RATE_LIMIT_RE.test(message)) return new BrokerError("rate_limited", `Robinhood rate limited ${tool}`, { tool, retryable: true, cause: e });
  if (status !== null && status >= 400 && status < 500 && status !== 408) return new BrokerError("upstream_rejected", `${tool}: HTTP ${status}`, { tool, cause: e, details: { httpStatus: status } });
  return new BrokerError("transport", `${tool}: ${message}`, { tool, retryable: true, cause: e });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RobinhoodMcpClientOptions {
  connect: McpCallerFactory;
  /** Pre-flight credential check and 401 invalidation. Null only for tests of the raw pipeline. */
  tokenProvider?: AccessTokenProvider | null;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateLimiter?: TokenBucketRateLimiter;
  timeoutMs?: number;
  toolSpecs?: Record<string, ToolSpec>;
  unreliableAfter?: number;
  rateLimitBackoffMs?: number;
  maxRateLimitRetries?: number;
}

export interface ClientHealth {
  consecutiveFailures: number;
  lastHealthyAt: IsoTimestamp | null;
  lastErrorCode: BrokerErrorCode | null;
  lastErrorAt: IsoTimestamp | null;
  connected: boolean;
}

export class RobinhoodMcpClient {
  private readonly connectFactory: McpCallerFactory;
  private readonly tokenProvider: AccessTokenProvider | null;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: TokenBucketRateLimiter;
  private readonly timeoutMs: number;
  private readonly specs: Record<string, ToolSpec>;
  private readonly unreliableAfter: number;
  private readonly rateLimitBackoffMs: number;
  private readonly maxRateLimitRetries: number;

  private connection: Promise<McpCaller> | null = null;
  private toolCache: Map<string, McpToolDefinition> | null = null;
  private verifiedTools = new Set<string>();
  private consecutiveFailures = 0;
  private lastHealthyAt: IsoTimestamp | null = null;
  private lastErrorCode: BrokerErrorCode | null = null;
  private lastErrorAt: IsoTimestamp | null = null;
  private lastEventWasFailure = false;

  constructor(opts: RobinhoodMcpClientOptions) {
    this.connectFactory = opts.connect;
    this.tokenProvider = opts.tokenProvider ?? null;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.limiter = opts.rateLimiter ?? new TokenBucketRateLimiter({ now: this.clock, sleep: this.sleep });
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.specs = opts.toolSpecs ?? ROBINHOOD_TOOLS;
    this.unreliableAfter = opts.unreliableAfter ?? 3;
    this.rateLimitBackoffMs = opts.rateLimitBackoffMs ?? 5_000;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 2;
  }

  private nowIso(): IsoTimestamp {
    return new Date(this.clock()).toISOString();
  }

  get health(): ClientHealth {
    return { consecutiveFailures: this.consecutiveFailures, lastHealthyAt: this.lastHealthyAt, lastErrorCode: this.lastErrorCode, lastErrorAt: this.lastErrorAt, connected: this.connection !== null };
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastHealthyAt = this.nowIso();
    this.lastEventWasFailure = false;
  }

  private recordFailure(err: BrokerError, countsTowardsUnreliable: boolean): void {
    this.lastErrorCode = err.code;
    this.lastErrorAt = this.nowIso();
    this.lastEventWasFailure = true;
    if (countsTowardsUnreliable) this.consecutiveFailures += 1;
  }

  // ---- connection -------------------------------------------------------

  private connect(): Promise<McpCaller> {
    if (!this.connection) {
      const p = this.connectFactory().then(async (caller) => {
        const tools = await caller.listTools();
        this.toolCache = new Map(tools.map((t) => [t.name, t]));
        this.verifiedTools = new Set();
        return caller;
      });
      p.catch(() => {
        if (this.connection === p) this.connection = null;
      });
      this.connection = p;
    }
    return this.connection;
  }

  private async dropConnection(): Promise<void> {
    const p = this.connection;
    this.connection = null;
    this.toolCache = null;
    this.verifiedTools = new Set();
    if (!p) return;
    try {
      const caller = await p;
      await caller.close?.();
    } catch {
      // already broken
    }
  }

  async close(): Promise<void> {
    await this.dropConnection();
  }

  /** Cached tools/list (connects on first use). */
  async listTools(): Promise<McpToolDefinition[]> {
    await this.preflight();
    try {
      await this.connect();
    } catch (e) {
      const err = classifyThrown(e, "tools/list");
      this.recordFailure(err, err.code === "transport" || err.code === "unknown");
      throw err;
    }
    return [...(this.toolCache?.values() ?? [])];
  }

  /**
   * Fails closed when the advertised schema of `name` no longer matches what this adapter relies on:
   * the tool is missing, one of `requiredInputs` is no longer accepted, or the server now requires
   * an input we do not know how to send.
   */
  async assertToolSchema(name: string, requiredInputs: readonly string[], knownInputs?: readonly string[]): Promise<void> {
    if (this.verifiedTools.has(name)) return;
    if (!this.toolCache) await this.connect();
    const def = this.toolCache?.get(name);
    if (!def) throw new BrokerError("schema_drift", `tool ${name} is no longer advertised by the Robinhood MCP server`, { tool: name });
    const props = def.inputSchema?.properties ?? {};
    const serverRequired = Array.isArray(def.inputSchema?.required) ? def.inputSchema.required : [];
    const missing = requiredInputs.filter((k) => !(k in props));
    if (missing.length > 0) {
      throw new BrokerError("schema_drift", `tool ${name} no longer accepts input(s): ${missing.join(", ")}`, { tool: name, details: { missing } });
    }
    if (knownInputs) {
      const unexpected = serverRequired.filter((k) => !knownInputs.includes(k));
      if (unexpected.length > 0) {
        throw new BrokerError("schema_drift", `tool ${name} now requires input(s) this adapter does not send: ${unexpected.join(", ")}`, { tool: name, details: { unexpected } });
      }
    }
    this.verifiedTools.add(name);
  }

  private async preflight(): Promise<void> {
    if (!this.tokenProvider) return;
    try {
      await this.tokenProvider.getAccessToken();
    } catch (e) {
      const err = isBrokerError(e) ? e : new BrokerError("unknown", `credential check failed: ${e instanceof Error ? redactSecrets(e.message) : String(e)}`, { cause: e });
      this.recordFailure(err, err.code === "transport" || err.code === "unknown");
      throw err;
    }
  }

  private withTimeout<T>(p: Promise<T>, tool: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CallTimeoutError(`${tool} exceeded ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  // ---- calls --------------------------------------------------------------

  /** Calls a registered tool. Throws BrokerError; never returns a partial or fabricated answer. */
  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<ToolCallResult<T>> {
    const spec = this.specs[name];
    if (!spec) throw new BrokerError("invalid_request", `tool ${name} is not registered for use by this adapter`, { tool: name });

    await this.preflight();

    let reconnectAttempted = false;
    let rateLimitRetries = 0;

    for (;;) {
      await this.limiter.acquire();

      let caller: McpCaller;
      try {
        caller = await this.connect();
        await this.assertToolSchema(name, spec.requiredInputs, spec.knownInputs);
      } catch (e) {
        const err = classifyThrown(e, name);
        if (err.code === "transport" && spec.kind === "read" && !reconnectAttempted) {
          reconnectAttempted = true;
          await this.dropConnection();
          continue;
        }
        if (err.code === "transport") await this.dropConnection();
        this.recordFailure(err, err.code !== "upstream_rejected" && err.code !== "token_expired" && err.code !== "not_connected");
        throw err;
      }

      let result: McpToolResult;
      try {
        result = await this.withTimeout(caller.callTool(name, args, { timeoutMs: this.timeoutMs }), name);
      } catch (e) {
        const err = classifyThrown(e, name);
        if (err.code === "token_expired") this.tokenProvider?.invalidate();
        if (err.code === "transport" || err.code === "token_expired") {
          await this.dropConnection();
          if (spec.kind === "read" && !reconnectAttempted) {
            reconnectAttempted = true;
            if (err.code === "token_expired") await this.preflight();
            continue;
          }
          if (spec.kind === "write" && err.code === "transport") {
            const surfaced = new BrokerError("transport", `${err.message}. The request may have reached Robinhood and was not retried; verify with get_equity_orders before retrying with the same ref_id.`, {
              tool: name,
              retryable: false,
              mayHaveReached: true,
              cause: e,
            });
            this.recordFailure(surfaced, true);
            throw surfaced;
          }
        }
        this.recordFailure(err, err.code === "transport" || err.code === "unknown" || err.code === "rate_limited");
        throw err;
      }

      if (result.isError) {
        const err = classifyErrorResult(result, name);
        if (err.code === "rate_limited") {
          const backoff = this.rateLimitBackoffMs * 2 ** rateLimitRetries;
          this.limiter.penalize(backoff);
          if (spec.kind === "read" && rateLimitRetries < this.maxRateLimitRetries) {
            rateLimitRetries += 1;
            continue;
          }
          this.recordFailure(err, true);
          throw err;
        }
        if (err.code === "token_expired") this.tokenProvider?.invalidate();
        // The server answered: the connection is healthy even though the request was refused.
        if (err.code === "upstream_rejected") this.recordSuccess();
        else this.recordFailure(err, false);
        throw err;
      }

      let parsed: { data: unknown; guide: string | null; raw: unknown };
      try {
        parsed = parseToolResult(result, name);
      } catch (e) {
        const err = classifyThrown(e, name);
        this.recordFailure(err, true);
        throw err;
      }
      this.recordSuccess();
      return { data: parsed.data as T, guide: parsed.guide, receivedAt: this.nowIso(), raw: parsed.raw };
    }
  }

  /** Connection status without touching the network. */
  async status(): Promise<AdapterStatus> {
    const base = { lastHealthyAt: this.lastHealthyAt, consecutiveFailures: this.consecutiveFailures };
    if (this.tokenProvider) {
      let hasCred = false;
      try {
        hasCred = await this.tokenProvider.hasCredential();
      } catch {
        return { status: "error", detail: "credential store unavailable", ...base };
      }
      if (!hasCred) return { status: "not_connected", detail: "no Robinhood credential stored for this account", ...base };
      const lf = this.tokenProvider.lastFailure;
      if (lf?.code === "token_expired") return { status: "token_expired", detail: "refresh token rejected; reconnect the account", ...base };
    }
    const failing = this.lastEventWasFailure;
    if (failing && this.lastErrorCode === "token_expired") return { status: "token_expired", detail: "Robinhood rejected the access token; reconnect the account", ...base };
    if (failing && this.lastErrorCode === "schema_drift") return { status: "error", detail: "Robinhood MCP tool schema drifted; adapter is failing closed", ...base };
    if (this.consecutiveFailures >= this.unreliableAfter) return { status: "unreliable", detail: `${this.consecutiveFailures} consecutive failures (last: ${this.lastErrorCode ?? "unknown"})`, ...base };
    if (this.lastHealthyAt) return { status: "connected", detail: "healthy", ...base };
    return { status: "connecting", detail: "credential present; no successful call yet", ...base };
  }
}
