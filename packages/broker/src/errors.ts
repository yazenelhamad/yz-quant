/**
 * Typed broker errors.
 *
 * Every failure that leaves the broker package is a `BrokerError` (or a core
 * `CrossTenantError` for scope violations). Messages never contain secrets and
 * account numbers are always masked to their last four characters.
 */

export type BrokerErrorCode =
  /** No credential stored for this scope (user has not connected the account). */
  | "not_connected"
  /** Credential exists but the access token is expired and could not be refreshed (re-login required). */
  | "token_expired"
  /** Upstream throttled the call (RATE_LIMITED / HTTP 429). */
  | "rate_limited"
  /** Upstream answered the call and rejected it (order rejected, bad params, tool isError). */
  | "upstream_rejected"
  /** tools/list no longer matches the schema this adapter was built against. Fails closed. */
  | "schema_drift"
  /** Transport-level failure (network, timeout, connection closed). */
  | "transport"
  /** A request refused locally because it violates a Robinhood constraint (fractional/session/sellable). */
  | "constraint_violation"
  /** placeOrder called with a review older than the allowed window. */
  | "stale_review"
  /** placeOrder called with a review that was not ok / does not match the request. */
  | "review_rejected"
  /** Malformed request (both quantity and dollar amount, missing prices, ...). */
  | "invalid_request"
  /** The adapter has no implementation for this capability (e.g. simulated adapter without market data). */
  | "unsupported"
  | "unknown";

export interface BrokerErrorOptions {
  tool?: string | null;
  /** Safe to retry with the same idempotency key. */
  retryable?: boolean;
  /** A write may have reached the broker even though we got no answer. */
  mayHaveReached?: boolean;
  cause?: unknown;
  /** Structured, secret-free details (alert codes, upstream reason...). */
  details?: Record<string, unknown>;
}

export class BrokerError extends Error {
  override readonly name = "BrokerError";
  readonly code: BrokerErrorCode;
  readonly tool: string | null;
  readonly retryable: boolean;
  readonly mayHaveReached: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: BrokerErrorCode, message: string, opts: BrokerErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.tool = opts.tool ?? null;
    this.retryable = opts.retryable ?? false;
    this.mayHaveReached = opts.mayHaveReached ?? false;
    this.details = opts.details ?? {};
  }

  toJSON(): { name: string; code: BrokerErrorCode; message: string; tool: string | null; retryable: boolean; mayHaveReached: boolean; details: Record<string, unknown> } {
    return { name: this.name, code: this.code, message: this.message, tool: this.tool, retryable: this.retryable, mayHaveReached: this.mayHaveReached, details: this.details };
  }
}

export function isBrokerError(e: unknown): e is BrokerError {
  return e instanceof BrokerError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "BrokerError" && typeof (e as { code?: unknown }).code === "string");
}

/** `••••1234` — the only form an account number may take in logs, errors and UI. */
export function maskAccountNumber(accountNumber: string | null | undefined): string {
  if (!accountNumber) return "••••";
  const tail = accountNumber.slice(-4);
  return `••••${tail}`;
}

/** Remove bearer tokens / token-like fields from free text before it can reach a log. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/("?(?:access_token|refresh_token|code_verifier|client_secret|code)"?\s*[:=]\s*"?)[A-Za-z0-9._~+/=-]{8,}("?)/gi, "$1[redacted]$2");
}
