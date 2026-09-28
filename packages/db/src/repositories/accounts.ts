import { and, eq } from "drizzle-orm";
import type { TenantScope, UserRole } from "@yz/core";
import { CrossTenantError } from "@yz/core";
import { brokerAccounts, brokerCredentials, riskSettings, users } from "../schema/index.js";
import { newId, nowIso, Repository } from "./base.js";
import { scoped, stamp } from "../scope.js";
import { DEFAULT_RISK_SETTINGS, RiskSettingsSchema, type RiskSettings } from "@yz/core";

export type UserRow = typeof users.$inferSelect;
export type BrokerAccountRow = typeof brokerAccounts.$inferSelect;

export class UsersRepository extends Repository {
  async byEmail(email: string): Promise<UserRow | undefined> {
    return (await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1))[0];
  }
  async byUsername(username: string): Promise<UserRow | undefined> {
    return (await this.db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).limit(1))[0];
  }
  /** Resolve a login identifier: username first, then email. */
  async byIdentifier(identifier: string): Promise<UserRow | undefined> {
    const id = identifier.trim().toLowerCase();
    return (await this.byUsername(id)) ?? (id.includes("@") ? this.byEmail(id) : undefined);
  }
  async byId(id: string): Promise<UserRow | undefined> {
    return (await this.db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  }
  async list(): Promise<UserRow[]> {
    return this.db.select().from(users);
  }
  async count(): Promise<number> {
    return (await this.db.select().from(users)).length;
  }
  async create(input: { email?: string | null; username?: string | null; displayName: string; role: UserRole; passwordHash: string; brandName?: string | null }): Promise<UserRow> {
    if (!input.email && !input.username) throw new Error("a user needs a username or an email");
    const row = { id: newId(), email: input.email ? input.email.toLowerCase() : null, username: input.username ? input.username.trim().toLowerCase() : null, displayName: input.displayName, role: input.role, passwordHash: input.passwordHash, brandName: input.brandName ?? null };
    await this.db.insert(users).values(row);
    return (await this.byId(row.id))!;
  }
  async update(id: string, patch: Partial<typeof users.$inferInsert>): Promise<void> {
    await this.db.update(users).set({ ...patch, updatedAt: nowIso() }).where(eq(users.id, id));
  }
}

export class BrokerAccountsRepository extends Repository {
  /** Accounts owned by a user. This is the only lookup the API uses to resolve a scope. */
  async listForUser(userId: string): Promise<BrokerAccountRow[]> {
    return this.db.select().from(brokerAccounts).where(eq(brokerAccounts.userId, userId));
  }
  async listAll(): Promise<BrokerAccountRow[]> {
    return this.db.select().from(brokerAccounts);
  }
  /**
   * Resolve an account for a user. Returns undefined when the account does not exist OR
   * belongs to a different user — callers cannot distinguish the two, by design.
   */
  async forScope(scope: TenantScope): Promise<BrokerAccountRow | undefined> {
    const row = (await this.db.select().from(brokerAccounts)
      .where(and(eq(brokerAccounts.id, scope.brokerAccountId), eq(brokerAccounts.userId, scope.userId))).limit(1))[0];
    return row;
  }
  async byId(id: string): Promise<BrokerAccountRow | undefined> {
    return (await this.db.select().from(brokerAccounts).where(eq(brokerAccounts.id, id)).limit(1))[0];
  }
  async create(input: Omit<typeof brokerAccounts.$inferInsert, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<BrokerAccountRow> {
    const id = input.id ?? newId();
    await this.db.insert(brokerAccounts).values({ ...input, id });
    return (await this.byId(id))!;
  }
  async update(scope: TenantScope, patch: Partial<typeof brokerAccounts.$inferInsert>): Promise<void> {
    if (patch.userId !== undefined && patch.userId !== scope.userId) {
      throw new CrossTenantError("Cannot move a broker account to another user", scope, { userId: patch.userId, brokerAccountId: scope.brokerAccountId });
    }
    await this.db.update(brokerAccounts).set({ ...patch, updatedAt: nowIso() })
      .where(and(eq(brokerAccounts.id, scope.brokerAccountId), eq(brokerAccounts.userId, scope.userId)));
  }
}

export class BrokerCredentialsRepository extends Repository {
  async get(scope: TenantScope) {
    return (await this.db.select().from(brokerCredentials).where(scoped(brokerCredentials, scope)).limit(1))[0];
  }
  async upsert(scope: TenantScope, input: { credentialEnc: string; keyVersion: number; expiresAt: string | null }): Promise<void> {
    const existing = await this.get(scope);
    if (existing) {
      await this.db.update(brokerCredentials)
        .set({ credentialEnc: input.credentialEnc, keyVersion: input.keyVersion, expiresAt: input.expiresAt, lastRefreshedAt: nowIso(), revokedAt: null, updatedAt: nowIso() })
        .where(scoped(brokerCredentials, scope));
    } else {
      await this.db.insert(brokerCredentials).values(stamp(scope, { id: newId(), credentialEnc: input.credentialEnc, keyVersion: input.keyVersion, expiresAt: input.expiresAt, lastRefreshedAt: nowIso() }));
    }
  }
  async revoke(scope: TenantScope): Promise<void> {
    await this.db.update(brokerCredentials).set({ revokedAt: nowIso(), updatedAt: nowIso() }).where(scoped(brokerCredentials, scope));
  }
  async delete(scope: TenantScope): Promise<void> {
    await this.db.delete(brokerCredentials).where(scoped(brokerCredentials, scope));
  }
}

export class RiskSettingsRepository extends Repository {
  async get(scope: TenantScope): Promise<RiskSettings> {
    const row = (await this.db.select().from(riskSettings).where(scoped(riskSettings, scope)).limit(1))[0];
    if (!row) return { ...DEFAULT_RISK_SETTINGS };
    return RiskSettingsSchema.parse(row.settings);
  }
  async set(scope: TenantScope, settings: RiskSettings, updatedBy: string): Promise<RiskSettings> {
    const parsed = RiskSettingsSchema.parse(settings);
    const existing = (await this.db.select().from(riskSettings).where(scoped(riskSettings, scope)).limit(1))[0];
    if (existing) {
      await this.db.update(riskSettings).set({ settings: parsed, version: existing.version + 1, updatedBy, updatedAt: nowIso() }).where(scoped(riskSettings, scope));
    } else {
      await this.db.insert(riskSettings).values(stamp(scope, { id: newId(), settings: parsed, version: 1, updatedBy }));
    }
    return parsed;
  }
}
