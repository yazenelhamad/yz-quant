import type { Quote, TenantScope, TradeLifecycleState } from "@yz/core";
import { assertScope, assertSameScope } from "@yz/core";
import { SimulatedBrokerAdapter, type BrokerAdapter } from "@yz/broker";
import type { BrokerAccountRow } from "@yz/db";
import type { Repos } from "../../http/app.js";

export interface ShadowQuoteSource {
  getQuotes(symbols: string[], maxAgeSeconds?: number): Promise<Quote[]>;
}

/**
 * Per-scope simulated books for SHADOW mode on real (Robinhood) accounts. `BrokerService` only
 * builds simulated adapters for simulated accounts, so a Robinhood account that trades a strategy
 * at `live_shadow` stage (or whose autonomy is `shadow`) gets its own `SimulatedBrokerAdapter`
 * here: bound to the same scope and account number (so the account-mapping check passes), fed by
 * the shared market-data quotes, seeded with SHADOW_STARTING_CAPITAL and rehydrated from stored
 * shadow trades. Orders and fills produced against it are persisted with mode "shadow" by the
 * execution/monitor code. Nothing here ever reaches a real broker.
 */
export interface ShadowBookState {
  startingCapital: number;
  totalValue: number;
  cash: number;
  buyingPower: number;
  equityValue: number;
  positions: { symbol: string; quantity: number; averageCost: number; markPrice: number | null; marketValue: number | null; unrealizedPnl: number | null; asOf: string }[];
  realizedPnl: number;
  dailyPnlPct: number | null;
  weeklyPnlPct: number | null;
  drawdownPct: number;
  peakValue: number;
  asOf: string;
}

/** Trade states in which a shadow trade holds shares. */
const HOLDING_STATES: TradeLifecycleState[] = ["partially_filled", "filled", "monitoring", "reduce", "exit_requested"];

/**
 * One simulated book per account. Every book starts from SHADOW_STARTING_CAPITAL (never the real
 * account balance, which may be tiny) and is rehydrated from the stored shadow trades after a
 * restart, so simulated positions and realised P&L survive redeploys.
 */
export class ShadowBooks {
  private readonly books = new Map<string, SimulatedBrokerAdapter>();
  private readonly marks = new Map<string, { day: string; dayStart: number; week: string; weekStart: number; peak: number }>();
  private readonly startingCapital: number;

  constructor(private readonly repos: Repos, private readonly quotes: ShadowQuoteSource, private readonly clock: () => Date = () => new Date(), opts: { startingCapital?: number } = {}) {
    this.startingCapital = opts.startingCapital && opts.startingCapital > 0 ? opts.startingCapital : 100_000;
  }

  get capital(): number { return this.startingCapital; }

  async adapterFor(scope: TenantScope, account: BrokerAccountRow): Promise<BrokerAdapter> {
    assertScope(scope, "ShadowBooks.adapterFor");
    assertSameScope(scope, { userId: account.userId, brokerAccountId: account.id }, "ShadowBooks.adapterFor(account)");
    const key = `${scope.userId}\u0000${scope.brokerAccountId}`;
    const existing = this.books.get(key);
    if (existing) {
      assertSameScope(scope, existing.binding.scope, "ShadowBooks.adapterFor(existing)");
      return existing;
    }
    const seed = await this.rehydrate(scope);
    const adapter = new SimulatedBrokerAdapter({
      scope,
      accountNumber: account.accountNumber,
      quoteSource: { getQuotes: (symbols) => this.quotes.getQuotes([...symbols]) },
      clock: () => this.clock().getTime(),
      initialCash: seed.cash,
      initialPositions: seed.positions,
      slippageBps: 3,
      latencyMs: 500,
    });
    this.books.set(key, adapter);
    return adapter;
  }

  /** Cash and positions implied by the stored shadow trades of this scope. */
  private async rehydrate(scope: TenantScope): Promise<{ cash: number; positions: { symbol: string; quantity: number; averageCost: number }[]; realizedPnl: number }> {
    const [open, closed] = await Promise.all([
      this.repos.trades.list(scope, { mode: "shadow", states: HOLDING_STATES, limit: 500 }),
      this.repos.trades.list(scope, { mode: "shadow", states: ["closed"], limit: 5000 }),
    ]);
    const realizedPnl = closed.reduce((s, t) => s + (t.realizedPnl ?? 0) - (t.fees ?? 0), 0);
    const bySymbol = new Map<string, { quantity: number; cost: number }>();
    for (const t of open) {
      const qty = t.openQuantity ?? 0;
      const px = t.averageEntryPrice ?? null;
      if (qty <= 0 || px === null || !(px > 0)) continue;
      const cur = bySymbol.get(t.symbol) ?? { quantity: 0, cost: 0 };
      bySymbol.set(t.symbol, { quantity: cur.quantity + qty, cost: cur.cost + qty * px });
    }
    const positions = [...bySymbol.entries()].map(([symbol, p]) => ({ symbol, quantity: p.quantity, averageCost: p.cost / p.quantity }));
    const invested = positions.reduce((s, p) => s + p.quantity * p.averageCost, 0);
    return { cash: Math.max(0, this.startingCapital + realizedPnl - invested), positions, realizedPnl };
  }

  /** The book's current state with day/week P&L marks and a running peak (marks reset after a restart). */
  async bookState(scope: TenantScope, account: BrokerAccountRow): Promise<ShadowBookState> {
    const adapter = (await this.adapterFor(scope, account)) as SimulatedBrokerAdapter;
    const [portfolio, positions, closed] = await Promise.all([adapter.getPortfolio(), adapter.getPositions(), this.repos.trades.list(scope, { mode: "shadow", states: ["closed"], limit: 5000 })]);
    const realizedPnl = closed.reduce((s, t) => s + (t.realizedPnl ?? 0) - (t.fees ?? 0), 0);
    const now = this.clock();
    const day = now.toISOString().slice(0, 10);
    const week = weekKey(now);
    const key = `${scope.userId}\u0000${scope.brokerAccountId}`;
    let m = this.marks.get(key);
    if (!m) { m = { day, dayStart: portfolio.totalValue, week, weekStart: portfolio.totalValue, peak: Math.max(this.startingCapital, portfolio.totalValue) }; this.marks.set(key, m); }
    if (m.day !== day) { m.day = day; m.dayStart = portfolio.totalValue; }
    if (m.week !== week) { m.week = week; m.weekStart = portfolio.totalValue; }
    m.peak = Math.max(m.peak, portfolio.totalValue);
    return {
      startingCapital: this.startingCapital,
      totalValue: portfolio.totalValue, cash: portfolio.cash, buyingPower: portfolio.buyingPower, equityValue: portfolio.equityValue,
      positions: positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity, averageCost: p.averageCost ?? 0, markPrice: p.markPrice ?? null, marketValue: p.marketValue ?? null, unrealizedPnl: p.unrealizedPnl ?? null, asOf: p.asOf })),
      realizedPnl,
      dailyPnlPct: m.dayStart > 0 ? portfolio.totalValue / m.dayStart - 1 : null,
      weeklyPnlPct: m.weekStart > 0 ? portfolio.totalValue / m.weekStart - 1 : null,
      drawdownPct: m.peak > 0 ? Math.max(0, (m.peak - portfolio.totalValue) / m.peak) : 0,
      peakValue: m.peak,
      asOf: portfolio.asOf,
    };
  }

  has(scope: TenantScope): boolean {
    return this.books.has(`${scope.userId}\u0000${scope.brokerAccountId}`);
  }

  scopes(): TenantScope[] {
    return [...this.books.values()].map((a) => a.binding.scope);
  }
}

function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7)}`;
}
