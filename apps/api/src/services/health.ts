import type { BrokerConnectionStatus, HealthComponent, HealthStatus } from "@yz/core";
import { DEFAULT_FRESHNESS_POLICY, marketSessionAt } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { coreServices } from "./registry.js";
import { maskAccountNumber } from "../security/secrets.js";
import { dataPlaneRepo } from "./pipeline/common.js";

export interface BrokerStatusCacheEntry { status: BrokerConnectionStatus; detail: string; lastHealthyAt: string | null; consecutiveFailures: number; checkedAt: string }

export interface HealthServiceOptions {
  clock?: () => Date;
  /** Registered job intervals (ms) by job name, used to flag stale scheduler runs. */
  jobIntervals?: () => Map<string, number>;
  /** Live broker status results cached by the broker_status job, keyed by broker account id. */
  brokerStatuses?: () => Map<string, BrokerStatusCacheEntry>;
}

const BROKER_STATUS_HEALTH: Record<BrokerConnectionStatus, HealthStatus> = {
  connected: "healthy", connecting: "unknown", not_connected: "unknown", token_expired: "warning", error: "warning", unreliable: "critical", revoked: "critical",
};

/**
 * Collects one `HealthComponent` per subsystem and persists them through `repos.health` so the
 * existing GET /api/system/health (which reads `health_checks`) reflects them. Every status is
 * derived from observed state; nothing is assumed healthy by default ("unknown" when unobserved).
 */
export class HealthService {
  private readonly clock: () => Date;
  constructor(private readonly opts: HealthServiceOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
  }

  async collect(ctx: AppContext): Promise<HealthComponent[]> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const { repos } = ctx;
    const components: HealthComponent[] = [];
    const svc = safeCore(ctx);
    const ageMin = (iso: string | null | undefined): number | null => (iso ? Math.max(0, (now.getTime() - Date.parse(iso)) / 60_000) : null);

    // 1. market data
    if (svc?.marketData) components.push(svc.marketData.health());
    else components.push({ name: "market_data", status: "unknown", detail: "market data service not composed", checkedAt: nowIso });

    // 2/3. broker connections + reconciliation age per account
    const accounts = await repos.accounts.listAll();
    const session = marketSessionAt(now);
    const live = this.opts.brokerStatuses?.() ?? new Map<string, BrokerStatusCacheEntry>();
    for (const a of accounts) {
      const masked = maskAccountNumber(a.accountNumber);
      const cached = live.get(a.id);
      const status = (cached?.status ?? a.status) as BrokerConnectionStatus;
      const health = a.kind === "simulated" ? (status === "connected" ? "healthy" : "warning") : (BROKER_STATUS_HEALTH[status] ?? "unknown");
      components.push({
        name: `broker:${a.id}`, status: health,
        detail: `${a.kind === "simulated" ? "SIMULATED " : "Robinhood "}${masked}: ${cached?.detail ?? a.statusDetail ?? status}`, checkedAt: cached?.checkedAt ?? nowIso,
        metrics: { account: masked, kind: a.kind, status, lastHealthyAt: cached?.lastHealthyAt ?? a.lastHealthyAt, consecutiveFailures: cached?.consecutiveFailures ?? null },
      });
      const recAge = ageMin(a.lastReconciledAt);
      const limit = session === "regular" ? 15 : 6 * 60;
      let recStatus: HealthStatus = "unknown";
      let recDetail = `${masked}: never reconciled`;
      if (recAge !== null) {
        if (!a.reconciliationOk) { recStatus = "critical"; recDetail = `${masked}: last reconciliation mismatched ${recAge.toFixed(0)} min ago`; }
        else if (recAge > 4 * limit) { recStatus = "critical"; recDetail = `${masked}: reconciliation ${recAge.toFixed(0)} min old (limit ${limit})`; }
        else if (recAge > limit) { recStatus = "warning"; recDetail = `${masked}: reconciliation ${recAge.toFixed(0)} min old (limit ${limit})`; }
        else { recStatus = "healthy"; recDetail = `${masked}: reconciled ${recAge.toFixed(0)} min ago`; }
      } else if (a.status !== "connected") { recDetail = `${masked}: not connected`; }
      components.push({ name: `reconciliation:${a.id}`, status: recStatus, detail: recDetail, checkedAt: nowIso, metrics: { account: masked, ageMinutes: recAge, ok: a.reconciliationOk ? 1 : 0, lastReconciledAt: a.lastReconciledAt } });
    }

    // 4. scheduler
    if (svc?.scheduler) {
      const st = svc.scheduler.status();
      const intervals = this.opts.jobIntervals?.() ?? new Map<string, number>();
      const stale: string[] = [];
      const failed: string[] = [];
      for (const [key, s] of Object.entries(st)) {
        const name = key.split(":")[0] ?? key;
        const interval = intervals.get(name);
        const age = now.getTime() - Date.parse(s.at);
        if (!s.ok) failed.push(key);
        if (interval && age > 2 * interval) stale.push(key);
      }
      const missing = [...intervals.keys()].filter((n) => !Object.keys(st).some((k) => k.startsWith(`${n}:`)));
      const status: HealthStatus = failed.length > 0 ? "warning" : stale.length > 0 ? "warning" : Object.keys(st).length === 0 ? "unknown" : "healthy";
      const detail = status === "healthy" ? `${Object.keys(st).length} job run(s) tracked` : [failed.length ? `failed: ${failed.slice(0, 5).join(", ")}` : "", stale.length ? `stale: ${stale.slice(0, 5).join(", ")}` : "", Object.keys(st).length === 0 ? "no job has run yet" : ""].filter(Boolean).join("; ");
      components.push({ name: "scheduler", status, detail, checkedAt: nowIso, metrics: { tracked: Object.keys(st).length, failed: failed.length, stale: stale.length, notYetRun: missing.length } });
    } else {
      components.push({ name: "scheduler", status: "unknown", detail: "scheduler not composed", checkedAt: nowIso });
    }

    // 5. data freshness: regime age + held-symbol quote age
    const regime = await repos.market.latestRegime();
    const regimeAge = ageMin(regime?.asOf);
    const heldSymbols = new Set<string>();
    for (const a of accounts) for (const p of await repos.positions.list({ userId: a.userId, brokerAccountId: a.id })) heldSymbols.add(p.symbol);
    const quotes = await repos.market.latestQuotes([...heldSymbols]);
    const quoteAges = quotes.map((q) => (now.getTime() - Date.parse(q.receivedAt)) / 60_000);
    const oldestQuote = quoteAges.length ? Math.max(...quoteAges) : null;
    const missingQuotes = [...heldSymbols].filter((s) => !quotes.some((q) => q.symbol === s));
    const quoteLimit = session === "regular" ? 5 : session === "closed" ? 24 * 60 : 30;
    let fresh: HealthStatus = "healthy";
    const notes: string[] = [];
    if (regimeAge === null) { fresh = "unknown"; notes.push("no regime assessment yet"); }
    else if (regimeAge > DEFAULT_FRESHNESS_POLICY.regimeStaleMinutes) { fresh = "critical"; notes.push(`regime ${regimeAge.toFixed(0)} min old (stale)`); }
    else if (regimeAge > DEFAULT_FRESHNESS_POLICY.regimeAgingMinutes) { fresh = worst(fresh, "warning"); notes.push(`regime ${regimeAge.toFixed(0)} min old (aging)`); }
    if (heldSymbols.size > 0) {
      if (missingQuotes.length > 0) { fresh = worst(fresh, "warning"); notes.push(`no quote for ${missingQuotes.slice(0, 5).join(", ")}`); }
      if (oldestQuote !== null && oldestQuote > quoteLimit) { fresh = worst(fresh, oldestQuote > 4 * quoteLimit ? "critical" : "warning"); notes.push(`oldest held-symbol quote ${oldestQuote.toFixed(0)} min (limit ${quoteLimit})`); }
    }
    components.push({ name: "data_freshness", status: fresh, detail: notes.length ? notes.join("; ") : `regime ${regimeAge?.toFixed(0) ?? "?"} min old; ${quotes.length}/${heldSymbols.size} held symbols quoted`, checkedAt: nowIso, metrics: { regimeAgeMinutes: regimeAge, regimeAsOf: regime?.asOf ?? null, heldSymbols: heldSymbols.size, quotedSymbols: quotes.length, oldestQuoteMinutes: oldestQuote, session } });

    // 6. model APIs
    const configured = svc?.modelClient?.configured ?? false;
    components.push({ name: "model_apis", status: configured ? "healthy" : "unknown", detail: configured ? "AI models configured" : "AI models: not configured", checkedAt: nowIso, metrics: { configured: configured ? 1 : 0 } });

    // 7. learning engine (written by the learning service when present)
    const learning = await dataPlaneRepo(ctx).healthCheck("learning");
    if (learning) components.push({ name: "learning", status: learning.status as HealthStatus, detail: learning.detail, checkedAt: learning.checkedAt, metrics: (learning.metrics as HealthComponent["metrics"]) ?? undefined });
    else components.push({ name: "learning", status: "unknown", detail: "learning engine has not reported", checkedAt: nowIso });

    // 8. session security (informational)
    const users = await repos.users.list();
    const noMfa = users.filter((u) => u.active && !u.mfaEnabled);
    let unverified = 0;
    let activeSessions = 0;
    for (const u of users) {
      const sessions = await repos.sessions.activeForUser(u.id);
      activeSessions += sessions.length;
      if (u.mfaEnabled) unverified += sessions.filter((s) => !s.mfaVerified).length;
    }
    components.push({ name: "session_security", status: noMfa.length > 0 ? "warning" : "healthy", detail: noMfa.length > 0 ? `${noMfa.length} active user(s) without MFA enrolled; ${activeSessions} active session(s)` : `all users MFA-enrolled; ${activeSessions} active session(s), ${unverified} awaiting MFA`, checkedAt: nowIso, metrics: { usersWithoutMfa: noMfa.length, activeSessions, sessionsAwaitingMfa: unverified } });

    // 9. database
    const dbOk = await ctx.dbHandle.ping();
    components.push({ name: "database", status: dbOk ? "healthy" : "critical", detail: dbOk ? `${ctx.dbHandle.kind} reachable` : "database unreachable", checkedAt: nowIso });

    // Persist everything except "database", which /api/system/health probes live itself.
    for (const c of components) {
      if (c.name === "database") continue;
      try { await repos.health.set(c); } catch { /* health persistence must never break collection */ }
    }
    return components;
  }
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = { healthy: 0, unknown: 1, warning: 2, critical: 3 };
  return rank[b] > rank[a] ? b : a;
}

function safeCore(ctx: AppContext) {
  try { return coreServices(ctx); } catch { return null; }
}
