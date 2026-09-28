/**
 * Identity and tenancy primitives.
 *
 * Every trading-related object in the platform belongs to exactly one user and one
 * broker account. `TenantScope` is the value that every repository and every engine
 * that touches capital must be handed explicitly; there is no implicit "current user".
 */

export type UserId = string;
export type BrokerAccountId = string;
export type StrategyId = string;
export type StrategyVersionId = string;
export type TradeId = string;
export type OrderId = string;
export type ThesisId = string;
export type SessionId = string;

export type UserRole = "admin" | "trader";

export interface TenantScope {
  readonly userId: UserId;
  readonly brokerAccountId: BrokerAccountId;
}

export function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.userId === b.userId && a.brokerAccountId === b.brokerAccountId;
}

export function assertScope(scope: TenantScope | null | undefined, context: string): asserts scope is TenantScope {
  if (!scope || typeof scope.userId !== "string" || scope.userId.length === 0 || typeof scope.brokerAccountId !== "string" || scope.brokerAccountId.length === 0) {
    throw new ScopeError(`Missing or invalid tenant scope in ${context}`);
  }
}

export class ScopeError extends Error {
  override readonly name = "ScopeError";
}

/** Thrown whenever an object from one scope is about to be used inside another. */
export class CrossTenantError extends Error {
  override readonly name = "CrossTenantError";
  constructor(message: string, readonly expected: TenantScope, readonly actual: TenantScope) {
    super(message);
  }
}

export function assertSameScope(expected: TenantScope, actual: TenantScope, context: string): void {
  if (!sameScope(expected, actual)) {
    throw new CrossTenantError(`Cross-tenant access in ${context}`, expected, actual);
  }
}

/** ISO-8601 timestamp string in UTC. */
export type IsoTimestamp = string;
