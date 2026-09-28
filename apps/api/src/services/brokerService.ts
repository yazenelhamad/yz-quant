import type { BrokerConnectionStatus, TenantScope } from "@yz/core";
import { CrossTenantError, TERMINAL_ORDER_STATES, marketSessionAt } from "@yz/core";
import {
  AdapterRegistry, EncryptedCredentialCodec, EncryptedCredentialStore, beginAuthorization, createAdapter, exchangeCode, oauthEndpointsFromEnv, reconcile, classifyReconciliationFailure, deriveFills,
  type BrokerAdapter, type EnvelopeStore, type OAuthEndpoints, type QuoteSource, type FetchLike,
} from "@yz/broker";
import type { BrokerAccountRow } from "@yz/db";
import { brokerOauthStates } from "@yz/db";
import { and, eq } from "drizzle-orm";
import type { Env } from "../config/env.js";
import type { Repos } from "../http/app.js";
import type { AuditService } from "./audit.js";
import { decodeMasterKey } from "../config/env.js";
import { maskAccountNumber } from "../security/secrets.js";
import { loopbackRedirectUri, parsePastedRedirect } from "./broker/pasteback.js";
import type { MarketDataSource } from "./marketData.js";

interface Logger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/** Envelope persistence over the broker_credentials table. Scope is enforced by the repository. */
class DbEnvelopeStore implements EnvelopeStore {
  constructor(private readonly repos: Repos, private readonly keyVersion: number) {}
  async load(scope: TenantScope): Promise<string | null> {
    const row = await this.repos.credentials.get(scope);
    if (!row || row.revokedAt) return null;
    return row.credentialEnc;
  }
  async save(scope: TenantScope, envelope: string): Promise<void> {
    await this.repos.credentials.upsert(scope, { credentialEnc: envelope, keyVersion: this.keyVersion, expiresAt: null });
  }
  async delete(scope: TenantScope): Promise<void> {
    await this.repos.credentials.delete(scope);
  }
}

export interface SyncResult {
  scope: TenantScope;
  ok: boolean;
  status: BrokerConnectionStatus;
  detail: string;
  portfolio: { totalValue: number; cash: number; buyingPower: number } | null;
  positions: number;
  orders: number;
  fills: number;
  reconciliation: { ok: boolean; action: string; reasons: string[] } | null;
  paused: boolean;
  error: string | null;
}

/**
 * Owns broker adapters (one per account, bound to its scope), the OAuth connection flow, and the
 * account synchronisation + reconciliation cycle. Never returns an adapter for a different scope.
 */
export class BrokerService {
  readonly registry = new AdapterRegistry();
  private readonly codec: EncryptedCredentialCodec;
  private readonly envelopes: EnvelopeStore;
  private readonly endpoints: OAuthEndpoints;
  private readonly fetchImpl: FetchLike;
  /** Set by the composition root once the shared market data service exists (simulated accounts price off it). */
  quoteSource: QuoteSource | null;
  private readonly clock: () => Date;
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    private readonly env: Env,
    private readonly repos: Repos,
    private readonly audit: AuditService,
    private readonly log: Logger,
    opts: { quoteSource?: QuoteSource | null; fetch?: FetchLike; clock?: () => Date; codec?: EncryptedCredentialCodec } = {},
  ) {
    this.codec = opts.codec ?? new EncryptedCredentialCodec({ version: `k${env.SECRETS_MASTER_KEY_VERSION}`, key: new Uint8Array(decodeMasterKey(env.SECRETS_MASTER_KEY)) });
    this.envelopes = new DbEnvelopeStore(repos, env.SECRETS_MASTER_KEY_VERSION);
    this.endpoints = oauthEndpointsFromEnv(env as unknown as Record<string, string | undefined>);
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.quoteSource = opts.quoteSource ?? null;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Resolve (or lazily construct) the adapter bound to an account. Verifies ownership via the repository. */
  async adapterFor(scope: TenantScope): Promise<BrokerAdapter | null> {
    const account = await this.repos.accounts.forScope(scope);
    if (!account) return null;
    return this.registry.getOrCreate(scope, () => this.build(scope, account));
  }

  private build(scope: TenantScope, account: BrokerAccountRow): BrokerAdapter {
    if (account.kind === "simulated") {
      const source = this.quoteSource;
      if (!source) throw new Error("simulated accounts need a live quote source (connect a Robinhood account first)");
      return createAdapter({ kind: "simulated", scope, accountNumber: account.accountNumber, clock: () => this.clock().getTime(), simulated: { quoteSource: source, initialCash: 100_000, slippageBps: 3, latencyMs: 500 } });
    }
    return createAdapter({
      kind: "robinhood_agentic",
      scope,
      accountNumber: account.accountNumber,
      envelopeStore: this.envelopes,
      codec: this.codec,
      endpoints: this.endpoints,
      fetch: this.fetchImpl,
      clock: () => this.clock().getTime(),
      brokerageAccountType: account.brokerageAccountType ?? undefined,
    });
  }

  /** A shared market-data source: the first connected Robinhood adapter (quotes carry no tenant data). */
  async marketDataSource(): Promise<MarketDataSource | null> {
    const all = await this.repos.accounts.listAll();
    for (const a of all) {
      if (a.kind !== "robinhood_agentic" || a.status !== "connected") continue;
      const scope = { userId: a.userId, brokerAccountId: a.id };
      try {
        const adapter = await this.registry.getOrCreate(scope, () => this.build(scope, a));
        return {
          name: `robinhood_mcp:${maskAccountNumber(a.accountNumber)}`,
          getQuotes: (symbols) => adapter.getQuotes(symbols),
          getBars: (symbols, opts) => adapter.getBars(symbols, { start: opts.start, end: opts.end, interval: opts.interval, adjustment: opts.adjustment ?? "split" }),
          getTradability: (symbols) => adapter.getTradability(symbols),
        };
      } catch (err) {
        this.log.warn({ err }, "market data source construction failed");
      }
    }
    return null;
  }

  // ---------------- OAuth connection flow ----------------

  /**
   * Start the OAuth flow. In loopback mode (the default, because Robinhood's consent page only
   * completes for loopback redirects) the browser is sent back to 127.0.0.1 and the user pastes
   * that address into the dashboard; in hosted mode the server callback receives the code.
   */
  async beginConnect(scope: TenantScope, hostedRedirectUri: string): Promise<{ authorizationUrl: string; redirectUri: string; mode: "loopback" | "hosted" }> {
    const account = await this.repos.accounts.forScope(scope);
    if (!account) throw new CrossTenantError("account not in scope", scope, scope);
    if (account.kind !== "robinhood_agentic") throw new Error("only Robinhood Agentic accounts can be connected");
    const mode = this.env.ROBINHOOD_REDIRECT_MODE;
    const redirectUri = mode === "loopback" ? loopbackRedirectUri(this.env.ROBINHOOD_LOOPBACK_PORT) : hostedRedirectUri;
    const start = await beginAuthorization({ redirectUri, fetch: this.fetchImpl, endpoints: this.endpoints, applicationType: mode === "loopback" ? "native" : "web", clientName: "The Palestinian Quant" });
    const expiresAt = new Date(this.clock().getTime() + 10 * 60_000).toISOString();
    await this.repos.accounts.update(scope, { status: "connecting", statusDetail: "Waiting for Robinhood authorization" });
    await this.dbInsertOauthState(scope, { state: start.state, codeVerifier: start.codeVerifier, clientId: start.clientId, redirectUri: start.redirectUri, expiresAt });
    await this.audit.record({ category: "broker", action: "connect_started", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { mode } });
    return { authorizationUrl: start.authorizationUrl, redirectUri, mode };
  }

  /**
   * Complete the flow from the address the user pasted (loopback mode). The pending state must
   * belong to the requesting scope; a state from another user's flow is refused and audited.
   */
  async completeConnectFromPaste(scope: TenantScope, pasted: string): Promise<{ scope: TenantScope; accountNumberMasked: string }> {
    const account = await this.repos.accounts.forScope(scope);
    if (!account) throw new CrossTenantError("account not in scope", scope, scope);
    const parsed = parsePastedRedirect(pasted);
    if (parsed.error) {
      const msg = `${parsed.error}${parsed.errorDescription ? `: ${parsed.errorDescription}` : ""}`.slice(0, 300);
      await this.repos.accounts.update(scope, { status: "error", statusDetail: `Robinhood reported: ${msg}` });
      await this.audit.record({ category: "broker", action: "connect_denied", result: "rejected", userId: scope.userId, brokerAccountId: scope.brokerAccountId, error: msg });
      throw new Error(`Robinhood reported: ${msg}`);
    }
    if (!parsed.code) throw new Error("The pasted address carries no authorization code. Copy the full address from the browser's address bar after approving on Robinhood.");
    const pending = parsed.state ? await this.dbTakeOauthState(parsed.state) : await this.dbTakeLatestOauthStateForScope(scope);
    if (!pending) throw new Error("Unknown or expired authorization state. Press Connect Robinhood again and paste the new address within 10 minutes.");
    if (pending.userId !== scope.userId || pending.brokerAccountId !== scope.brokerAccountId) {
      await this.audit.record({ category: "broker", action: "connect_cross_scope_refused", result: "rejected", userId: scope.userId, brokerAccountId: scope.brokerAccountId, error: "authorization state belongs to another account" });
      throw new CrossTenantError("authorization state belongs to another account", scope, { userId: pending.userId, brokerAccountId: pending.brokerAccountId });
    }
    return this.completeWithPending(pending, parsed.code);
  }

  /**
   * Complete the OAuth flow. The `state` binds the callback to the (user, account) that started it;
   * the caller must additionally verify the session user matches the returned scope.
   */
  async completeConnect(state: string, code: string): Promise<{ scope: TenantScope; accountNumberMasked: string }> {
    const pending = await this.dbTakeOauthState(state);
    if (!pending) throw new Error("Unknown or expired authorization state");
    return this.completeWithPending(pending, code);
  }

  private async completeWithPending(pending: { userId: string; brokerAccountId: string; codeVerifier: string; clientId: string; redirectUri: string }, code: string): Promise<{ scope: TenantScope; accountNumberMasked: string }> {
    const scope: TenantScope = { userId: pending.userId, brokerAccountId: pending.brokerAccountId };
    const cred = await exchangeCode({ code, codeVerifier: pending.codeVerifier, clientId: pending.clientId, redirectUri: pending.redirectUri, fetch: this.fetchImpl, endpoints: this.endpoints, now: () => Math.floor(this.clock().getTime() / 1000) });
    await new EncryptedCredentialStore(this.envelopes, this.codec).save(scope, cred);
    await this.repos.credentials.upsert(scope, { credentialEnc: (await this.envelopes.load(scope))!, keyVersion: this.env.SECRETS_MASTER_KEY_VERSION, expiresAt: new Date(cred.expires_at * 1000).toISOString() });
    this.registry.delete(scope);
    const account = (await this.repos.accounts.forScope(scope))!;
    // Discover the agentic account number from get_accounts.
    const probe = createAdapter({ kind: "robinhood_agentic", scope, accountNumber: account.accountNumber, envelopeStore: this.envelopes, codec: this.codec, endpoints: this.endpoints, fetch: this.fetchImpl, clock: () => this.clock().getTime() });
    const listings = await probe.getAccounts();
    const agentic = listings.find((l) => l.agenticAllowed && !l.deactivated);
    if (!agentic) {
      await this.repos.accounts.update(scope, { status: "error", statusDetail: "No agentic-enabled account found. Open an Agentic account in the Robinhood app first." });
      await this.audit.record({ category: "broker", action: "connect_failed", result: "error", userId: scope.userId, brokerAccountId: scope.brokerAccountId, error: "no agentic account" });
      throw new Error("No agentic-enabled Robinhood account was found for this login");
    }
    // Refuse to bind the same Robinhood account to two platform users.
    const others = (await this.repos.accounts.listAll()).filter((a) => a.id !== scope.brokerAccountId && a.accountNumber === agentic.accountNumber);
    if (others.length > 0) {
      await this.repos.accounts.update(scope, { status: "error", statusDetail: "This Robinhood account is already connected to another user" });
      await this.envelopes.delete(scope);
      throw new Error("This Robinhood account is already connected to another user");
    }
    await this.repos.accounts.update(scope, {
      accountNumber: agentic.accountNumber,
      rhsAccountNumber: agentic.rhsAccountNumber,
      agenticAllowed: true,
      accountType: agentic.accountType,
      brokerageAccountType: agentic.brokerageAccountType,
      optionsEnabledAtBroker: agentic.optionsEnabled,
      status: "connected",
      statusDetail: `Connected to Robinhood Agentic account ${maskAccountNumber(agentic.accountNumber)}`,
      lastHealthyAt: this.clock().toISOString(),
    });
    this.registry.delete(scope);
    await this.audit.record({ category: "broker", action: "connected", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { accountNumber: maskAccountNumber(agentic.accountNumber), accountType: agentic.accountType } });
    return { scope, accountNumberMasked: maskAccountNumber(agentic.accountNumber) };
  }

  async disconnect(scope: TenantScope, actor: string): Promise<void> {
    await this.envelopes.delete(scope);
    this.registry.delete(scope);
    await this.repos.accounts.update(scope, { status: "not_connected", statusDetail: "Disconnected", tradingPaused: true, pausedReason: "Broker disconnected", agenticAllowed: false });
    await this.audit.record({ category: "broker", action: "disconnected", result: "ok", userId: scope.userId, brokerAccountId: scope.brokerAccountId, actorUserId: actor });
  }

  async status(scope: TenantScope): Promise<{ status: BrokerConnectionStatus; detail: string; lastHealthyAt: string | null; consecutiveFailures: number; tools: string[] | null }> {
    const account = await this.repos.accounts.forScope(scope);
    if (!account) throw new CrossTenantError("account not in scope", scope, scope);
    if (account.kind === "robinhood_agentic" && !(await this.repos.credentials.get(scope))) {
      return { status: "not_connected", detail: "Robinhood: not connected", lastHealthyAt: null, consecutiveFailures: 0, tools: null };
    }
    try {
      const adapter = await this.adapterFor(scope);
      if (!adapter) return { status: "not_connected", detail: "No adapter", lastHealthyAt: null, consecutiveFailures: 0, tools: null };
      const s = await adapter.status();
      let tools: string[] | null = null;
      try { tools = await adapter.listTools(); } catch { tools = null; }
      return { ...s, tools };
    } catch (err) {
      return { status: "error", detail: err instanceof Error ? err.message : String(err), lastHealthyAt: account.lastHealthyAt, consecutiveFailures: this.consecutiveFailures.get(key(scope)) ?? 0, tools: null };
    }
  }

  // ---------------- Sync + reconciliation ----------------

  /**
   * Pull portfolio, positions and orders from the broker (source of truth), persist them, derive
   * fills from order deltas, compute P&L/drawdown, reconcile against the internal ledger, and pause
   * the account (never the other user's) when reconciliation fails.
   */
  async sync(scope: TenantScope): Promise<SyncResult> {
    const account = await this.repos.accounts.forScope(scope);
    if (!account) throw new CrossTenantError("account not in scope", scope, scope);
    const base: SyncResult = { scope, ok: false, status: account.status as BrokerConnectionStatus, detail: "", portfolio: null, positions: 0, orders: 0, fills: 0, reconciliation: null, paused: account.tradingPaused, error: null };
    if (account.kind === "robinhood_agentic" && !(await this.repos.credentials.get(scope))) {
      return { ...base, status: "not_connected", detail: "Robinhood: not connected" };
    }
    let adapter: BrokerAdapter;
    try {
      const a = await this.adapterFor(scope);
      if (!a) return { ...base, detail: "no adapter" };
      adapter = a;
    } catch (err) {
      return { ...base, status: "error", detail: String(err), error: String(err) };
    }
    const now = this.clock();
    try {
      const [portfolio, positions, brokerOrders] = await Promise.all([adapter.getPortfolio(), adapter.getPositions(), adapter.getOrders({})]);
      // Positions → mark with quotes when available (never fabricate).
      const symbols = positions.map((p) => p.symbol);
      let marks = new Map<string, { last: number; at: string }>();
      if (symbols.length > 0) {
        try {
          const quotes = await adapter.getQuotes(symbols);
          marks = new Map(quotes.map((q) => [q.symbol, { last: q.last, at: q.provenance.observedAt }]));
        } catch (err) { this.log.warn({ err }, "quote fetch during sync failed; positions left unmarked"); }
      }
      const existing = await this.repos.positions.list(scope);
      const existingBySymbol = new Map(existing.map((p) => [p.symbol, p]));
      await this.repos.positions.replaceAll(scope, positions.map((p) => {
        const mark = marks.get(p.symbol);
        const mv = mark ? mark.last * p.quantity : null;
        return {
          symbol: p.symbol, assetClass: p.assetClass, quantity: p.quantity, intradayQuantity: p.intradayQuantity, sharesAvailableForSells: p.sharesAvailableForSells,
          averageCost: p.averageCost, markPrice: mark?.last ?? null, marketValue: mv, unrealizedPnl: mv != null && p.averageCost != null ? mv - p.averageCost * p.quantity : null,
          tradeId: existingBySymbol.get(p.symbol)?.tradeId ?? null, strategyId: existingBySymbol.get(p.symbol)?.strategyId ?? null,
          asOf: p.asOf, source: p.provenance.source, raw: p.provenance,
        };
      }));
      // Orders: upsert by broker id / ref id, derive fills from deltas.
      let fillsRecorded = 0;
      for (const bo of brokerOrders) {
        const prev = (await this.repos.orders.byBrokerOrderId(scope, bo.brokerOrderId)) ?? (bo.refId ? await this.repos.orders.byRefId(scope, bo.refId) : undefined);
        if (prev) {
          const prevOrder = prev.brokerOrderId ? { ...bo, brokerOrderId: prev.brokerOrderId, state: prev.state as typeof bo.state, cumulativeQuantity: prev.cumulativeQuantity, averagePrice: prev.averagePrice, fees: prev.fees } : null;
          const fills = prevOrder ? deriveFills(prevOrder, bo) : [];
          for (const f of fills) {
            await this.repos.fills.record(scope, { orderId: prev.id, brokerOrderId: bo.brokerOrderId, tradeId: prev.tradeId, symbol: f.symbol, side: f.side, quantity: f.quantity, price: f.price, fees: f.fees, derived: true, mode: prev.mode, at: f.at });
            fillsRecorded++;
          }
          await this.repos.orders.update(scope, prev.id, { brokerOrderId: bo.brokerOrderId, state: bo.state, cumulativeQuantity: bo.cumulativeQuantity, averagePrice: bo.averagePrice, fees: bo.fees, lastBrokerSyncAt: now.toISOString(), raw: bo.raw ?? null });
        } else {
          // An order the platform did not place (placed in the Robinhood app or by another agent). Recorded, flagged external.
          await this.repos.orders.create(scope, {
            brokerOrderId: bo.brokerOrderId, refId: bo.refId ?? `external-${bo.brokerOrderId}`, accountNumber: account.accountNumber, symbol: bo.symbol, side: bo.side, type: bo.type,
            quantity: bo.quantity, limitPrice: bo.limitPrice, stopPrice: bo.stopPrice, timeInForce: bo.timeInForce, marketHours: bo.marketHours, mode: "live", state: bo.state,
            cumulativeQuantity: bo.cumulativeQuantity, averagePrice: bo.averagePrice, fees: bo.fees, submittedAt: bo.createdAt, lastBrokerSyncAt: now.toISOString(), raw: { external: true, placedAgent: bo.placedAgent, ...(bo.raw && typeof bo.raw === "object" ? bo.raw as Record<string, unknown> : {}) },
          });
        }
      }
      // Portfolio snapshot with P&L / drawdown.
      const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
      const weekStart = new Date(dayStart); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
      const [firstToday, peak, latestPrev] = await Promise.all([this.repos.snapshots.firstSince(scope, dayStart.toISOString()), this.repos.snapshots.peak(scope), this.repos.snapshots.latest(scope)]);
      const baselineDay = firstToday?.totalValue ?? latestPrev?.totalValue ?? null;
      const dailyPnl = baselineDay != null ? portfolio.totalValue - baselineDay : null;
      const totalPnl = latestPrev?.totalPnl != null && latestPrev.totalValue ? latestPrev.totalPnl + (portfolio.totalValue - latestPrev.totalValue) : (latestPrev ? portfolio.totalValue - latestPrev.totalValue : 0);
      const newPeak = Math.max(peak ?? 0, portfolio.totalValue);
      const drawdownPct = newPeak > 0 ? Math.max(0, (newPeak - portfolio.totalValue) / newPeak) : null;
      const exposurePct = portfolio.totalValue > 0 ? (portfolio.equityValue + portfolio.optionsValue + portfolio.cryptoValue) / portfolio.totalValue : null;
      await this.repos.snapshots.record(scope, { asOf: portfolio.asOf, totalValue: portfolio.totalValue, equityValue: portfolio.equityValue, optionsValue: portfolio.optionsValue, cryptoValue: portfolio.cryptoValue, cash: portfolio.cash, pendingDeposits: portfolio.pendingDeposits, buyingPower: portfolio.buyingPower, unleveragedBuyingPower: portfolio.unleveragedBuyingPower, currency: portfolio.currency, dailyPnl, totalPnl, drawdownPct, exposurePct, source: portfolio.provenance.source, raw: null });
      void weekStart;

      // Reconcile the internal ledger against the broker.
      const openTrades = await this.repos.trades.list(scope, { mode: "live", states: ["filled", "monitoring", "reduce", "partially_filled", "exit_requested"], limit: 500 });
      const internalPositions = openTrades.filter((t) => t.openQuantity > 0).map((t) => ({ symbol: t.symbol, quantity: t.openQuantity }));
      const internalOpen = (await this.repos.orders.open(scope)).filter((o) => o.mode === "live").map((o) => ({ brokerOrderId: o.brokerOrderId, refId: o.refId, symbol: o.symbol, side: o.side, state: o.state as never, quantity: o.quantity, cumulativeQuantity: o.cumulativeQuantity }));
      const externalSymbols = existing.filter((p) => !p.tradeId).map((p) => p.symbol).concat(positions.filter((p) => !existingBySymbol.has(p.symbol)).map((p) => p.symbol));
      const rec = reconcile({ positions: mergeQuantities(internalPositions), openOrders: internalOpen, cash: null, externalSymbols }, { positions, orders: brokerOrders.filter((o) => !TERMINAL_ORDER_STATES.has(o.state)), portfolio }, {});
      await this.repos.reconciliations.record(scope, { ok: rec.ok, positionMismatches: rec.positionMismatches, orderMismatches: rec.orderMismatches, cashDifference: rec.cashDifference, unexpectedPositions: rec.unexpectedPositions.map((u) => u.symbol), action: rec.ok ? "none" : "paused_account", detail: rec.reasons.join("; ") || null, at: now.toISOString() });
      let paused = account.tradingPaused;
      if (!rec.ok) {
        paused = true;
        await this.repos.accounts.update(scope, { tradingPaused: true, pausedReason: `Reconciliation failed: ${rec.reasons.join("; ")}`, reconciliationOk: false, lastReconciledAt: now.toISOString(), status: "connected", statusDetail: "Connected; reconciliation mismatch", lastHealthyAt: now.toISOString() });
        await this.repos.killSwitches.trigger(scope, ["reconciliation_failed"], "system", rec.reasons.join("; "), true);
        await this.repos.alerts.raise({ userId: scope.userId, brokerAccountId: scope.brokerAccountId, severity: "critical", kind: "broker", title: "Reconciliation failed", message: rec.reasons.join("; ") });
        await this.audit.record({ category: "reconciliation", action: "failed", result: "rejected", userId: scope.userId, brokerAccountId: scope.brokerAccountId, detail: { reasons: rec.reasons } });
      } else {
        await this.repos.accounts.update(scope, { reconciliationOk: true, lastReconciledAt: now.toISOString(), status: "connected", statusDetail: `Connected (${marketSessionAt(now)} session)`, lastHealthyAt: now.toISOString() });
      }
      this.consecutiveFailures.set(key(scope), 0);
      return { ...base, ok: true, status: "connected", detail: "synced", portfolio: { totalValue: portfolio.totalValue, cash: portfolio.cash, buyingPower: portfolio.buyingPower }, positions: positions.length, orders: brokerOrders.length, fills: fillsRecorded, reconciliation: { ok: rec.ok, action: rec.action, reasons: rec.reasons }, paused };
    } catch (err) {
      const n = (this.consecutiveFailures.get(key(scope)) ?? 0) + 1;
      this.consecutiveFailures.set(key(scope), n);
      const cls = classifyReconciliationFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      const status: BrokerConnectionStatus = /token_expired|not_connected/.test(message) ? "token_expired" : n >= 3 ? "unreliable" : "error";
      await this.repos.accounts.update(scope, { status, statusDetail: message.slice(0, 300) });
      if (n >= 3) {
        await this.repos.killSwitches.trigger(scope, ["broker_unreliable"], "system", message.slice(0, 300), true);
        await this.repos.accounts.update(scope, { tradingPaused: true, pausedReason: "Broker connection unreliable" });
      }
      await this.audit.record({ category: "broker", action: "sync_failed", result: "error", userId: scope.userId, brokerAccountId: scope.brokerAccountId, error: message, detail: { classification: cls, consecutiveFailures: n } });
      this.log.warn({ err, scope: scope.brokerAccountId, classification: cls }, "broker sync failed");
      return { ...base, ok: false, status, detail: message, error: message, paused: n >= 3 ? true : base.paused };
    }
  }

  private async dbInsertOauthState(scope: TenantScope, s: { state: string; codeVerifier: string; clientId: string; redirectUri: string; expiresAt: string }): Promise<void> {
    await this.repos.accounts.forScope(scope); // ownership check
    await this.repos.users.byId(scope.userId);
    const db = this.repos.sessionsDb();
    await db.insert(brokerOauthStates).values({ id: crypto.randomUUID(), userId: scope.userId, brokerAccountId: scope.brokerAccountId, ...s });
  }

  /** Newest unexpired pending state for a scope (for a paste without a state parameter). Consumed on read. */
  private async dbTakeLatestOauthStateForScope(scope: TenantScope): Promise<{ userId: string; brokerAccountId: string; codeVerifier: string; clientId: string; redirectUri: string } | null> {
    const db = this.repos.sessionsDb();
    const rows = await db.select().from(brokerOauthStates).where(and(eq(brokerOauthStates.userId, scope.userId), eq(brokerOauthStates.brokerAccountId, scope.brokerAccountId)));
    const live = rows.filter((r) => new Date(r.expiresAt) >= this.clock()).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
    const row = live[0];
    if (!row) return null;
    await db.delete(brokerOauthStates).where(eq(brokerOauthStates.id, row.id));
    return row;
  }

  private async dbTakeOauthState(state: string): Promise<{ userId: string; brokerAccountId: string; codeVerifier: string; clientId: string; redirectUri: string } | null> {
    const db = this.repos.sessionsDb();
    const row = (await db.select().from(brokerOauthStates).where(eq(brokerOauthStates.state, state)).limit(1))[0];
    if (!row) return null;
    await db.delete(brokerOauthStates).where(and(eq(brokerOauthStates.id, row.id), eq(brokerOauthStates.state, state)));
    if (new Date(row.expiresAt) < this.clock()) return null;
    return row;
  }
}

function mergeQuantities(rows: { symbol: string; quantity: number }[]): { symbol: string; quantity: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.symbol, (m.get(r.symbol) ?? 0) + r.quantity);
  return [...m].map(([symbol, quantity]) => ({ symbol, quantity }));
}

const key = (s: TenantScope) => `${s.userId}/${s.brokerAccountId}`;
