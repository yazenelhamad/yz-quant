import { and, desc, eq, sql } from "drizzle-orm";
import type { AuditEvent, HealthComponent, TenantScope } from "@yz/core";
import { alerts, auditLogs, globalRiskState, healthChecks, jobRuns, killSwitches, systemEvents } from "../schema/index.js";
import { newId, nowIso, Repository } from "./base.js";
import { scoped, stamp } from "../scope.js";

export class AuditRepository extends Repository {
  async append(event: AuditEvent): Promise<void> {
    await this.db.insert(auditLogs).values({ ...event, id: event.id ?? newId(), at: event.at ?? nowIso() });
  }
  async recent(opts: { userId?: string; brokerAccountId?: string; category?: string; limit?: number } = {}) {
    const conds = [];
    if (opts.userId) conds.push(eq(auditLogs.userId, opts.userId));
    if (opts.brokerAccountId) conds.push(eq(auditLogs.brokerAccountId, opts.brokerAccountId));
    if (opts.category) conds.push(eq(auditLogs.category, opts.category));
    const q = this.db.select().from(auditLogs);
    const rows = conds.length ? await q.where(and(...conds)).orderBy(desc(auditLogs.at)).limit(opts.limit ?? 200) : await q.orderBy(desc(auditLogs.at)).limit(opts.limit ?? 200);
    return rows;
  }
}

export class SystemEventsRepository extends Repository {
  async record(component: string, level: "info" | "warning" | "error" | "critical", message: string, detail?: unknown) {
    await this.db.insert(systemEvents).values({ id: newId(), component, level, message, detail: detail ?? null });
  }
  async recent(limit = 200) {
    return this.db.select().from(systemEvents).orderBy(desc(systemEvents.at)).limit(limit);
  }
}

export class AlertsRepository extends Repository {
  async raise(input: { userId: string | null; brokerAccountId: string | null; severity: "info" | "warning" | "critical"; kind: string; title: string; message: string }) {
    const id = newId();
    await this.db.insert(alerts).values({ ...input, id });
    return id;
  }
  async forScope(scope: TenantScope, limit = 50) {
    return this.db.select().from(alerts).where(scoped(alerts as unknown as { userId: typeof alerts.userId; brokerAccountId: typeof alerts.brokerAccountId }, scope)).orderBy(desc(alerts.createdAt)).limit(limit);
  }
  async global(limit = 50) {
    return this.db.select().from(alerts).where(sql`${alerts.userId} is null`).orderBy(desc(alerts.createdAt)).limit(limit);
  }
  async acknowledge(id: string, by: string) {
    await this.db.update(alerts).set({ acknowledged: true, acknowledgedBy: by, acknowledgedAt: nowIso() }).where(eq(alerts.id, id));
  }
}

export class HealthRepository extends Repository {
  async set(component: HealthComponent) {
    const existing = (await this.db.select().from(healthChecks).where(eq(healthChecks.name, component.name)).limit(1))[0];
    const values = { status: component.status, detail: component.detail, metrics: component.metrics ?? null, checkedAt: component.checkedAt };
    if (existing) await this.db.update(healthChecks).set(values).where(eq(healthChecks.name, component.name));
    else await this.db.insert(healthChecks).values({ name: component.name, ...values });
  }
  async all() {
    return this.db.select().from(healthChecks);
  }
}

export class GlobalRiskRepository extends Repository {
  async get() {
    let row = (await this.db.select().from(globalRiskState).where(eq(globalRiskState.id, "global")).limit(1))[0];
    if (!row) {
      await this.db.insert(globalRiskState).values({ id: "global" });
      row = (await this.db.select().from(globalRiskState).where(eq(globalRiskState.id, "global")).limit(1))[0]!;
    }
    return row;
  }
  async update(patch: Partial<typeof globalRiskState.$inferInsert>, updatedBy: string) {
    await this.get();
    await this.db.update(globalRiskState).set({ ...patch, updatedBy, updatedAt: nowIso() }).where(eq(globalRiskState.id, "global"));
    return this.get();
  }
}

export class KillSwitchRepository extends Repository {
  async get(scope: TenantScope) {
    return (await this.db.select().from(killSwitches).where(scoped(killSwitches, scope)).limit(1))[0];
  }
  async trigger(scope: TenantScope, reasons: string[], triggeredBy: string, note: string | null, allowRiskReducingExits = true) {
    const existing = await this.get(scope);
    const merged = Array.from(new Set([...(existing?.reasons ?? []), ...reasons]));
    if (existing) {
      await this.db.update(killSwitches).set({ active: true, reasons: merged, triggeredAt: nowIso(), triggeredBy, note, allowRiskReducingExits, releasedAt: null, releasedBy: null, updatedAt: nowIso() }).where(scoped(killSwitches, scope));
    } else {
      await this.db.insert(killSwitches).values(stamp(scope, { id: newId(), active: true, reasons: merged, triggeredAt: nowIso(), triggeredBy, note, allowRiskReducingExits }));
    }
  }
  async release(scope: TenantScope, releasedBy: string) {
    await this.db.update(killSwitches).set({ active: false, reasons: [], releasedAt: nowIso(), releasedBy, updatedAt: nowIso() }).where(scoped(killSwitches, scope));
  }
}

export class JobRunsRepository extends Repository {
  async start(name: string, scope: TenantScope | null) {
    const id = newId();
    await this.db.insert(jobRuns).values({ id, name, userId: scope?.userId ?? null, brokerAccountId: scope?.brokerAccountId ?? null, status: "running" });
    return id;
  }
  async finish(id: string, status: "ok" | "error" | "skipped", detail?: unknown, error?: string) {
    await this.db.update(jobRuns).set({ status, finishedAt: nowIso(), detail: detail ?? null, error: error ?? null }).where(eq(jobRuns.id, id));
  }
  async recent(limit = 100) {
    return this.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
  }
}
