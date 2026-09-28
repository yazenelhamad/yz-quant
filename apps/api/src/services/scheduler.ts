import type { TenantScope } from "@yz/core";
import type { Repos } from "../http/app.js";

export interface JobDefinition {
  name: string;
  /** Interval in ms. */
  everyMs: number;
  /** Per-scope jobs run once per active broker account, serialised per account. Global jobs run once. */
  kind: "global" | "per_account";
  run: (ctx: { scope: TenantScope | null; signal: AbortSignal }) => Promise<unknown>;
  /** Do not run if the previous run of the same key is still going (default true). */
  skipIfRunning?: boolean;
  timeoutMs?: number;
}

interface Logger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/**
 * Minimal in-process scheduler. One instance per API process. Jobs are keyed by name plus scope so
 * user A's trading cycle can never block or be blocked by user B's, while the same account never
 * runs two cycles concurrently.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = new Map<string, Promise<unknown>>();
  private lastStatus = new Map<string, { at: string; ok: boolean; error: string | null; durationMs: number }>();
  private stopped = false;

  constructor(
    private readonly repos: Repos,
    private readonly log: Logger,
    private readonly listScopes: () => Promise<TenantScope[]>,
  ) {}

  register(job: JobDefinition, opts: { runImmediately?: boolean } = {}): void {
    const tick = () => { void this.dispatch(job); };
    const t = setInterval(tick, job.everyMs);
    t.unref();
    this.timers.push(t);
    if (opts.runImmediately) setTimeout(tick, 250).unref();
  }

  async dispatch(job: JobDefinition): Promise<void> {
    if (this.stopped) return;
    if (job.kind === "global") { await this.runOne(job, null); return; }
    let scopes: TenantScope[] = [];
    try { scopes = await this.listScopes(); } catch (err) { this.log.error({ err, job: job.name }, "failed to list scopes"); return; }
    await Promise.all(scopes.map((scope) => this.runOne(job, scope)));
  }

  /** Run a job now for a scope (used by API routes such as "sync now"). */
  async runOne(job: JobDefinition, scope: TenantScope | null): Promise<unknown> {
    const key = `${job.name}:${scope ? `${scope.userId}/${scope.brokerAccountId}` : "global"}`;
    if (job.skipIfRunning !== false && this.running.has(key)) return this.running.get(key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), job.timeoutMs ?? 120_000);
    const started = Date.now();
    const p = (async () => {
      const runId = await this.repos.jobs.start(job.name, scope).catch(() => null);
      try {
        const detail = await job.run({ scope, signal: controller.signal });
        this.lastStatus.set(key, { at: new Date().toISOString(), ok: true, error: null, durationMs: Date.now() - started });
        if (runId) await this.repos.jobs.finish(runId, "ok", detail).catch(() => undefined);
        return detail;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastStatus.set(key, { at: new Date().toISOString(), ok: false, error: message, durationMs: Date.now() - started });
        this.log.error({ err, job: job.name, scope }, "job failed");
        if (runId) await this.repos.jobs.finish(runId, "error", null, message).catch(() => undefined);
        await this.repos.systemEvents.record("scheduler", "error", `job ${job.name} failed: ${message}`, { scope }).catch(() => undefined);
        return null;
      } finally {
        clearTimeout(timeout);
        this.running.delete(key);
      }
    })();
    this.running.set(key, p);
    return p;
  }

  status(): Record<string, { at: string; ok: boolean; error: string | null; durationMs: number }> {
    return Object.fromEntries(this.lastStatus);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
