import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { assertScope, CrossTenantError, type TenantScope } from "@yz/core";

/**
 * Tenant-scoped query helpers.
 *
 * Every trading table has `user_id` and `broker_account_id`. `scoped()` produces the
 * WHERE fragment that must be present on every read and write. Repositories in this
 * package never expose an un-scoped API for those tables.
 */
export interface TenantColumns {
  userId: PgColumn;
  brokerAccountId: PgColumn;
}

export function scoped(table: TenantColumns, scope: TenantScope, extra?: SQL): SQL {
  assertScope(scope, "scoped()");
  const base = and(eq(table.userId, scope.userId), eq(table.brokerAccountId, scope.brokerAccountId))!;
  return extra ? and(base, extra)! : base;
}

/** Stamp a row with its tenant scope, refusing rows that already carry a different scope. */
export function stamp<T extends Record<string, unknown>>(scope: TenantScope, row: T): T & { userId: string; brokerAccountId: string } {
  assertScope(scope, "stamp()");
  const existingUser = row["userId"];
  const existingAccount = row["brokerAccountId"];
  if ((existingUser !== undefined && existingUser !== scope.userId) || (existingAccount !== undefined && existingAccount !== scope.brokerAccountId)) {
    throw new CrossTenantError("Row carries a different tenant scope", scope, {
      userId: String(existingUser),
      brokerAccountId: String(existingAccount),
    });
  }
  return { ...row, userId: scope.userId, brokerAccountId: scope.brokerAccountId };
}

/** Verify that a row read from the database belongs to the scope it was requested for. */
export function verifyRowScope<T extends { userId: string; brokerAccountId: string }>(scope: TenantScope, row: T | undefined, context: string): T | undefined {
  if (!row) return row;
  if (row.userId !== scope.userId || row.brokerAccountId !== scope.brokerAccountId) {
    throw new CrossTenantError(`Row returned outside of scope in ${context}`, scope, row);
  }
  return row;
}
