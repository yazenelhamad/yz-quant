import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { loginAttempts, sessions } from "../schema/index.js";
import { newId, nowIso, Repository } from "./base.js";

export type SessionRow = typeof sessions.$inferSelect;

export class SessionsRepository extends Repository {
  async create(input: { userId: string; tokenHash: string; csrfToken: string; userAgent: string | null; ip: string | null; deviceLabel: string | null; mfaVerified: boolean; expiresAt: string }): Promise<SessionRow> {
    const id = newId();
    await this.db.insert(sessions).values({ id, ...input });
    return (await this.byId(id))!;
  }
  async byId(id: string): Promise<SessionRow | undefined> {
    return (await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0];
  }
  async byTokenHash(tokenHash: string): Promise<SessionRow | undefined> {
    return (await this.db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1))[0];
  }
  async touch(id: string, lastSeenAt: string): Promise<void> {
    await this.db.update(sessions).set({ lastSeenAt }).where(eq(sessions.id, id));
  }
  async update(id: string, patch: Partial<typeof sessions.$inferInsert>): Promise<void> {
    await this.db.update(sessions).set(patch).where(eq(sessions.id, id));
  }
  async revoke(id: string, reason: string): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: nowIso(), revokedReason: reason }).where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }
  async revokeAllForUser(userId: string, reason: string, exceptId?: string): Promise<number> {
    const rows = await this.activeForUser(userId);
    let n = 0;
    for (const r of rows) {
      if (r.id === exceptId) continue;
      await this.revoke(r.id, reason);
      n++;
    }
    return n;
  }
  async activeForUser(userId: string): Promise<SessionRow[]> {
    return this.db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, nowIso()))).orderBy(desc(sessions.lastSeenAt));
  }
  async countActiveForUser(userId: string): Promise<number> {
    return (await this.activeForUser(userId)).length;
  }
  async purgeExpired(): Promise<void> {
    await this.db.delete(sessions).where(sql`${sessions.expiresAt} < ${nowIso()}`);
  }
}

export class LoginAttemptsRepository extends Repository {
  async record(email: string, ip: string | null, success: boolean, reason: string | null): Promise<void> {
    await this.db.insert(loginAttempts).values({ id: newId(), email: email.toLowerCase(), ip, success, reason });
  }
  async recentFailures(email: string, sinceIso: string): Promise<number> {
    const rows = await this.db.select().from(loginAttempts).where(and(eq(loginAttempts.email, email.toLowerCase()), eq(loginAttempts.success, false), gt(loginAttempts.at, sinceIso)));
    return rows.length;
  }
}
