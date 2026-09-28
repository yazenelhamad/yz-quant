import type { Bar, BarInterval, MarketSession } from "@yz/core";
import { marketSessionAt, newYorkDate } from "@yz/core";
import { DataPlaneRepository } from "@yz/db";
import type { AppContext } from "../../http/app.js";

export interface PipelineLogger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

export const silentLogger: PipelineLogger = { info() {}, warn() {}, error() {} };

/** Lazily constructed data-plane repository over the same database handle as the other repositories. */
export function dataPlaneRepo(ctx: AppContext): DataPlaneRepository {
  const key = "__dataPlaneRepo";
  const existing = ctx.services[key] as DataPlaneRepository | undefined;
  if (existing) return existing;
  const repo = new DataPlaneRepository(ctx.repos.sessionsDb());
  ctx.services[key] = repo;
  return repo;
}

/**
 * Session-aware cadence gate. Jobs are registered on a short interval and early-return when the
 * cadence for the current market session is not due, keeping one place that decides "how often".
 */
export class Cadence {
  private readonly lastRunAt = new Map<string, number>();
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** True (and marks the run) when at least `intervalMs` elapsed since the last run for `key`. */
  due(key: string, intervalMs: number): boolean {
    const now = this.clock().getTime();
    const last = this.lastRunAt.get(key);
    if (last !== undefined && now - last < intervalMs) return false;
    this.lastRunAt.set(key, now);
    return true;
  }
  /** True once per New York calendar date. */
  dueDaily(key: string): boolean {
    const today = newYorkDate(this.clock());
    const marker = this.lastRunAt.get(`${key}:date`);
    const stamp = Number(today.replace(/-/g, ""));
    if (marker === stamp) return false;
    this.lastRunAt.set(`${key}:date`, stamp);
    return true;
  }
  /** Time of the last recorded run for a key (ms since epoch) or null. */
  last(key: string): number | null {
    return this.lastRunAt.get(key) ?? null;
  }
  /** Reset a key so the next `due` call runs (used when a run failed and should be retried). */
  reset(key: string): void {
    this.lastRunAt.delete(key);
  }
}

export function sessionNow(clock: () => Date): MarketSession {
  return marketSessionAt(clock());
}

/** Hour of day in New York (0-23) for an instant. */
export function newYorkHour(at: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" });
  return Number(fmt.format(at)) % 24;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export function rowToBar(r: { symbol: string; interval: string; time: string; open: number; high: number; low: number; close: number; volume: number; interpolated: boolean; adjusted: string; source: string; receivedAt: string }): Bar {
  return { symbol: r.symbol, interval: r.interval as BarInterval, time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, interpolated: r.interpolated, adjusted: r.adjusted as Bar["adjusted"], provenance: { source: r.source, observedAt: r.time, receivedAt: r.receivedAt, reliability: 1 } };
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
