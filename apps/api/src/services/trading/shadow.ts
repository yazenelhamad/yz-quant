import type { Quote, TenantScope } from "@yz/core";
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
 * the shared market-data quotes, seeded with cash equal to the account's latest snapshot value at
 * first use. Orders and fills produced against it are persisted with mode "shadow" by the
 * execution/monitor code. Nothing here ever reaches a real broker.
 */
export class ShadowBooks {
  private readonly books = new Map<string, SimulatedBrokerAdapter>();

  constructor(private readonly repos: Repos, private readonly quotes: ShadowQuoteSource, private readonly clock: () => Date = () => new Date()) {}

  async adapterFor(scope: TenantScope, account: BrokerAccountRow): Promise<BrokerAdapter> {
    assertScope(scope, "ShadowBooks.adapterFor");
    assertSameScope(scope, { userId: account.userId, brokerAccountId: account.id }, "ShadowBooks.adapterFor(account)");
    const key = `${scope.userId}\u0000${scope.brokerAccountId}`;
    const existing = this.books.get(key);
    if (existing) {
      assertSameScope(scope, existing.binding.scope, "ShadowBooks.adapterFor(existing)");
      return existing;
    }
    const snapshot = await this.repos.snapshots.latest(scope);
    const initialCash = snapshot && snapshot.totalValue > 0 ? snapshot.totalValue : 100_000;
    const adapter = new SimulatedBrokerAdapter({
      scope,
      accountNumber: account.accountNumber,
      quoteSource: { getQuotes: (symbols) => this.quotes.getQuotes([...symbols]) },
      clock: () => this.clock().getTime(),
      initialCash,
      slippageBps: 3,
      latencyMs: 500,
    });
    this.books.set(key, adapter);
    return adapter;
  }

  has(scope: TenantScope): boolean {
    return this.books.has(`${scope.userId}\u0000${scope.brokerAccountId}`);
  }

  scopes(): TenantScope[] {
    return [...this.books.values()].map((a) => a.binding.scope);
  }
}
