import type { Bar, BarInterval, Quote, Tradability, Freshness, HealthComponent } from "@yz/core";
import { marketSessionAt, quoteQuality, classifyAge, ageSeconds, DEFAULT_FRESHNESS_POLICY } from "@yz/core";
import type { MarketRepository } from "@yz/db";

/**
 * Minimal surface a market data source must provide. The Robinhood adapter of a connected account
 * satisfies it (quotes/bars are identical regardless of whose credential fetched them); an external
 * provider can be added later without touching the service.
 */
export interface MarketDataSource {
  readonly name: string;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getBars(symbols: string[], opts: { start: string; end?: string; interval: BarInterval; adjustment?: "none" | "split" | "all" }): Promise<Bar[]>;
  getTradability(symbols: string[]): Promise<Tradability[]>;
}

export interface QuoteWithQuality extends Quote { freshness: Freshness; ageSeconds: number | null }

interface Logger { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void }

export class MarketDataService {
  private consecutiveFailures = 0;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: MarketRepository,
    private readonly sourceProvider: () => Promise<MarketDataSource | null>,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Refresh quotes from the source and persist them with provenance. Never fabricates on failure. */
  async refreshQuotes(symbols: string[]): Promise<{ quotes: QuoteWithQuality[]; source: string | null; error: string | null }> {
    const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter(Boolean);
    if (uniq.length === 0) return { quotes: [], source: null, error: null };
    const source = await this.sourceProvider();
    if (!source) return { quotes: [], source: null, error: "no market data source connected" };
    const key = `quotes:${uniq.sort().join(",")}`;
    if (this.inflight.has(key)) return this.inflight.get(key) as Promise<{ quotes: QuoteWithQuality[]; source: string | null; error: string | null }>;
    const p = (async () => {
      try {
        const quotes = await source.getQuotes(uniq);
        const now = this.clock();
        await this.repo.recordQuotes(quotes.map((q) => ({
          symbol: q.symbol, last: q.last, bid: q.bid, ask: q.ask, previousClose: q.previousClose, lastTradeAt: q.lastTradeAt,
          session: q.session, instrumentState: q.instrumentState, source: q.provenance.source, observedAt: q.provenance.observedAt, receivedAt: q.provenance.receivedAt, reliability: q.provenance.reliability,
        })));
        this.consecutiveFailures = 0;
        this.lastSuccessAt = now.toISOString();
        this.lastError = null;
        return { quotes: quotes.map((q) => this.withQuality(q, now)), source: source.name, error: null };
      } catch (err) {
        this.consecutiveFailures++;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.log.warn({ err, symbols: uniq.length }, "quote refresh failed");
        return { quotes: [], source: source.name, error: this.lastError };
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Cached quotes, refreshed when older than maxAgeSeconds. Missing quotes are simply absent. */
  async getQuotes(symbols: string[], maxAgeSeconds = 30): Promise<QuoteWithQuality[]> {
    const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
    const now = this.clock();
    const cached = await this.repo.latestQuotes(uniq);
    const fresh = new Map<string, QuoteWithQuality>();
    const needs: string[] = [];
    for (const s of uniq) {
      const c = cached.find((r) => r.symbol === s);
      if (c && (now.getTime() - new Date(c.receivedAt).getTime()) / 1000 <= maxAgeSeconds) {
        fresh.set(s, this.withQuality(this.rowToQuote(c), now));
      } else needs.push(s);
    }
    if (needs.length > 0) {
      const refreshed = await this.refreshQuotes(needs);
      for (const q of refreshed.quotes) fresh.set(q.symbol, q);
      // Fall back to the cached (older) quote, correctly labelled aging/stale, when the refresh failed.
      for (const s of needs) {
        if (!fresh.has(s)) {
          const c = cached.find((r) => r.symbol === s);
          if (c) fresh.set(s, this.withQuality(this.rowToQuote(c), now));
        }
      }
    }
    return uniq.map((s) => fresh.get(s)).filter((q): q is QuoteWithQuality => !!q);
  }

  /** Ensure daily (or intraday) bars exist up to now; fetch incrementally; return ascending bars. */
  async ensureBars(symbol: string, interval: BarInterval, lookbackDays: number): Promise<{ bars: Bar[]; freshness: Freshness; error: string | null }> {
    const sym = symbol.toUpperCase();
    const now = this.clock();
    const latest = await this.repo.latestBarTime(sym, interval);
    const start = latest ? new Date(new Date(latest).getTime() - 2 * 86_400_000) : new Date(now.getTime() - lookbackDays * 86_400_000);
    let error: string | null = null;
    const source = await this.sourceProvider();
    if (source) {
      try {
        const fetched = await source.getBars([sym], { start: start.toISOString(), end: now.toISOString(), interval, adjustment: "split" });
        await this.repo.upsertBars(fetched.filter((b) => b.symbol === sym).map((b) => ({
          symbol: b.symbol, interval: b.interval, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
          interpolated: b.interpolated, adjusted: b.adjusted, source: b.provenance?.source ?? source.name, receivedAt: now.toISOString(),
        })));
        this.consecutiveFailures = 0;
        this.lastSuccessAt = now.toISOString();
      } catch (err) {
        this.consecutiveFailures++;
        error = err instanceof Error ? err.message : String(err);
        this.lastError = error;
        this.log.warn({ err, symbol: sym }, "bar refresh failed");
      }
    } else {
      error = "no market data source connected";
    }
    const rows = await this.repo.bars(sym, interval, { start: new Date(now.getTime() - lookbackDays * 86_400_000).toISOString(), limit: 5000 });
    const bars: Bar[] = rows.map((r) => ({ symbol: r.symbol, interval: r.interval as BarInterval, time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, interpolated: r.interpolated, adjusted: r.adjusted as Bar["adjusted"], provenance: { source: r.source, observedAt: r.time, receivedAt: r.receivedAt, reliability: 1 } }));
    const lastTime = bars.length ? bars[bars.length - 1]!.time : null;
    const age = ageSeconds(lastTime, now.toISOString());
    const dayS = 86_400;
    const freshness: Freshness = interval === "day"
      ? classifyAge(age, (DEFAULT_FRESHNESS_POLICY.barsAgingDays + 1.5) * dayS, (DEFAULT_FRESHNESS_POLICY.barsStaleDays + 1.5) * dayS)
      : classifyAge(age, 30 * 60, 3 * 3600);
    return { bars, freshness, error };
  }

  async getTradability(symbols: string[]): Promise<Tradability[]> {
    const source = await this.sourceProvider();
    if (!source) return [];
    return source.getTradability(symbols.map((s) => s.toUpperCase()));
  }

  health(): HealthComponent {
    const now = this.clock().toISOString();
    const status = this.consecutiveFailures >= 3 ? "critical" : this.consecutiveFailures > 0 ? "warning" : this.lastSuccessAt ? "healthy" : "unknown";
    return { name: "market_data", status, detail: status === "healthy" ? `last success ${this.lastSuccessAt}` : this.lastError ?? "no successful fetch yet", checkedAt: now, metrics: { consecutiveFailures: this.consecutiveFailures, lastSuccessAt: this.lastSuccessAt } };
  }

  get failing(): boolean { return this.consecutiveFailures >= 3; }

  private withQuality(q: Quote, now: Date): QuoteWithQuality {
    const open = marketSessionAt(now) === "regular";
    const quality = quoteQuality({ observedAt: q.provenance.observedAt, reliability: q.provenance.reliability, marketOpen: open }, now.toISOString());
    return { ...q, freshness: quality.freshness, ageSeconds: quality.ageSeconds };
  }

  private rowToQuote(r: { symbol: string; last: number; bid: number | null; ask: number | null; previousClose: number | null; lastTradeAt: string | null; session: string; instrumentState: string; source: string; observedAt: string; receivedAt: string; reliability: number }): Quote {
    return { symbol: r.symbol, last: r.last, bid: r.bid, ask: r.ask, previousClose: r.previousClose, lastTradeAt: r.lastTradeAt, session: r.session as Quote["session"], instrumentState: r.instrumentState as Quote["instrumentState"], provenance: { source: r.source, observedAt: r.observedAt, receivedAt: r.receivedAt, reliability: r.reliability } };
  }
}
