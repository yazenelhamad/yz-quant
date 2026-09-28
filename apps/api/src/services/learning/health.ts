import type { HealthComponent, HealthStatus } from "@yz/core";
import type { HealthRepository } from "@yz/db";

export interface LearningHealthView {
  status: HealthStatus;
  lastRunAt: string | null;
  frozen: boolean;
  reason: string | null;
  failedJobs: string[];
  lastRuns: Record<string, { at: string; ok: boolean; error: string | null }>;
}

/**
 * Tracks learning job outcomes. Any failure freezes adaptation (health "learning" = critical with
 * `frozen: true`) until the failed job succeeds again; trading keeps running on the last validated
 * strategy versions in the meantime. The state is persisted on every change so the dashboard and the
 * trading plane read the same answer after a restart.
 */
export class LearningHealthTracker {
  private readonly failed = new Map<string, string>();
  private readonly lastRuns = new Map<string, { at: string; ok: boolean; error: string | null }>();
  private lastRunAt: string | null = null;

  constructor(private readonly health: HealthRepository, private readonly clock: () => Date) {}

  get frozen(): boolean { return this.failed.size > 0; }

  async recordSuccess(job: string, detail?: Record<string, number | string | null>): Promise<void> {
    const at = this.clock().toISOString();
    this.failed.delete(job);
    this.lastRuns.set(job, { at, ok: true, error: null });
    this.lastRunAt = at;
    await this.persist(detail);
  }

  async recordFailure(job: string, error: unknown): Promise<void> {
    const at = this.clock().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.failed.set(job, message);
    this.lastRuns.set(job, { at, ok: false, error: message });
    this.lastRunAt = at;
    await this.persist();
  }

  view(): LearningHealthView {
    const frozen = this.frozen;
    const reason = frozen ? [...this.failed.entries()].map(([job, err]) => `${job}: ${err}`).join("; ") : null;
    return {
      status: frozen ? "critical" : this.lastRunAt ? "healthy" : "unknown",
      lastRunAt: this.lastRunAt,
      frozen,
      reason,
      failedJobs: [...this.failed.keys()],
      lastRuns: Object.fromEntries(this.lastRuns),
    };
  }

  component(extra?: Record<string, number | string | null>): HealthComponent {
    const v = this.view();
    return {
      name: "learning",
      status: v.status,
      detail: v.frozen ? `adaptation frozen: ${v.reason}` : v.lastRunAt ? `last learning run ${v.lastRunAt}` : "no learning run yet",
      checkedAt: this.clock().toISOString(),
      metrics: { frozen: v.frozen ? 1 : 0, failedJobs: v.failedJobs.join(",") || null, lastRunAt: v.lastRunAt, ...(extra ?? {}) },
    };
  }

  private async persist(extra?: Record<string, number | string | null>): Promise<void> {
    const c = this.component(extra);
    // `frozen` is stored as a real boolean in metrics so consumers can test it directly.
    await this.health.set({ ...c, metrics: { ...(c.metrics ?? {}), frozen: this.frozen as unknown as number } }).catch(() => undefined);
  }
}
