import type { Freshness } from "@yz/core";
import type { MarketDataService } from "../marketData.js";
import { errorMessage, type PipelineLogger } from "./common.js";

export const DAILY_LOOKBACK_DAYS = 400;
export const INTRADAY_LOOKBACK_DAYS = 5;

export interface BarRunSummary {
  interval: "day" | "5minute";
  symbols: number;
  updated: number;
  failed: number;
  noSource: boolean;
  freshness: Record<Freshness, number>;
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

export interface QuoteRunSummary {
  symbols: number;
  quotes: number;
  source: string | null;
  error: string | null;
  at: string;
}

/**
 * Incremental bar/quote ingestion for the research universe. Delegates fetching + persistence
 * to `MarketDataService.ensureBars` (which is incremental) and keeps a freshness ledger per
 * symbol so the health collector and the data-quality gate can report it truthfully.
 */
export class BarPipeline {
  readonly freshness = new Map<string, { daily: Freshness; intraday: Freshness; dailyAt: string | null; intradayAt: string | null }>();
  lastDailyRun: BarRunSummary | null = null;
  lastIntradayRun: BarRunSummary | null = null;
  lastQuoteRun: QuoteRunSummary | null = null;

  constructor(private readonly marketData: MarketDataService, private readonly log: PipelineLogger, private readonly clock: () => Date = () => new Date()) {}

  async runDaily(symbols: string[]): Promise<BarRunSummary> {
    const s = await this.run(symbols, "day", DAILY_LOOKBACK_DAYS);
    this.lastDailyRun = s;
    return s;
  }

  async runIntraday(symbols: string[]): Promise<BarRunSummary> {
    const s = await this.run(symbols, "5minute", INTRADAY_LOOKBACK_DAYS);
    this.lastIntradayRun = s;
    return s;
  }

  async runQuotes(symbols: string[]): Promise<QuoteRunSummary> {
    const at = this.clock().toISOString();
    if (symbols.length === 0) {
      this.lastQuoteRun = { symbols: 0, quotes: 0, source: null, error: null, at };
      return this.lastQuoteRun;
    }
    const r = await this.marketData.refreshQuotes(symbols);
    this.lastQuoteRun = { symbols: symbols.length, quotes: r.quotes.length, source: r.source, error: r.error, at };
    return this.lastQuoteRun;
  }

  private async run(symbols: string[], interval: "day" | "5minute", lookbackDays: number): Promise<BarRunSummary> {
    const startedAt = this.clock().toISOString();
    const summary: BarRunSummary = { interval, symbols: symbols.length, updated: 0, failed: 0, noSource: false, freshness: { fresh: 0, aging: 0, stale: 0, unknown: 0 }, startedAt, finishedAt: startedAt, errors: [] };
    for (const symbol of symbols) {
      try {
        const r = await this.marketData.ensureBars(symbol, interval, lookbackDays);
        const entry = this.freshness.get(symbol) ?? { daily: "unknown", intraday: "unknown", dailyAt: null, intradayAt: null };
        const last = r.bars.length ? r.bars[r.bars.length - 1]!.time : null;
        if (interval === "day") { entry.daily = r.freshness; entry.dailyAt = last; } else { entry.intraday = r.freshness; entry.intradayAt = last; }
        this.freshness.set(symbol, entry);
        summary.freshness[r.freshness]++;
        if (r.error) {
          summary.failed++;
          if (r.error === "no market data source connected") summary.noSource = true;
          else if (summary.errors.length < 10) summary.errors.push(`${symbol}: ${r.error}`);
          if (this.marketData.failing) { summary.errors.push("market data source failing; aborting run"); break; }
        } else summary.updated++;
      } catch (err) {
        summary.failed++;
        if (summary.errors.length < 10) summary.errors.push(`${symbol}: ${errorMessage(err)}`);
      }
    }
    summary.finishedAt = this.clock().toISOString();
    if (summary.failed > 0 && !summary.noSource) this.log.warn({ interval, failed: summary.failed, errors: summary.errors }, "bar pipeline run had failures");
    return summary;
  }

  /** Aggregate daily-bar freshness across symbols (worst of held symbols drives the gate). */
  worstDailyFreshness(symbols: string[]): Freshness {
    const rank: Record<Freshness, number> = { fresh: 0, aging: 1, unknown: 2, stale: 3 };
    let worst: Freshness = symbols.length ? "fresh" : "unknown";
    for (const s of symbols) {
      const f = this.freshness.get(s)?.daily ?? "unknown";
      if (rank[f] > rank[worst]) worst = f;
    }
    return worst;
  }
}
