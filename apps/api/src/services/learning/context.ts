import type { TenantScope } from "@yz/core";
import type { Repos } from "../../http/app.js";
import type { AuditService } from "../audit.js";
import type { LearningRepos } from "./repos.js";

export interface LearningLogger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/** Everything the learning modules need. Scope is always passed explicitly; there is no ambient user. */
export interface LearningContext {
  repos: Repos;
  lr: LearningRepos;
  audit: AuditService;
  clock: () => Date;
  log: LearningLogger;
}

export async function listScopes(ctx: LearningContext): Promise<TenantScope[]> {
  const accounts = await ctx.repos.accounts.listAll();
  return accounts.map((a) => ({ userId: a.userId, brokerAccountId: a.id }));
}

export function scopeKey(scope: TenantScope | null): string {
  return scope ? `${scope.userId}/${scope.brokerAccountId}` : "shared";
}

export function daysAgo(clock: () => Date, days: number): string {
  return new Date(clock().getTime() - days * 86_400_000).toISOString();
}
