import type { Bar, Quote } from "@yz/core";
import { FEATURE, FEATURE_VERSION, computeFeatures } from "@yz/core";
import type { MarketRepository } from "@yz/db";
import { DAILY_LOOKBACK_DAYS, INTRADAY_LOOKBACK_DAYS } from "./bars.js";
import { errorMessage, rowToBar, type PipelineLogger } from "./common.js";

export interface FeatureRunSummary {
  asOf: string;
  symbols: number;
  computed: number;
  skipped: number;
  instrumentsUpdated: number;
  freshness: Record<string, number>;
  errors: string[];
}

/**
 * Computes the canonical feature set for every universe symbol from persisted bars/quotes and
 * upserts it under `FEATURE_VERSION`. Also derives `instruments.avgDollarVolume20` and `beta`
 * from the same computation so the risk engine and the feature engine never disagree.
 */
export class FeaturePipeline {
  lastRun: FeatureRunSummary | null = null;

  constructor(private readonly market: MarketRepository, private readonly log: PipelineLogger, private readonly clock: () => Date = () => new Date()) {}

  async loadBars(symbol: string, now: Date): Promise<{ daily: Bar[]; intraday: Bar[] }> {
    const [dailyRows, intradayRows] = await Promise.all([
      this.market.bars(symbol, "day", { start: new Date(now.getTime() - DAILY_LOOKBACK_DAYS * 86_400_000).toISOString(), limit: 600 }),
      this.market.bars(symbol, "5minute", { start: new Date(now.getTime() - INTRADAY_LOOKBACK_DAYS * 86_400_000).toISOString(), limit: 2000 }),
    ]);
    return { daily: dailyRows.map(rowToBar), intraday: intradayRows.map(rowToBar) };
  }

  async run(symbols: string[], benchmarkSymbol = "SPY"): Promise<FeatureRunSummary> {
    const now = this.clock();
    const asOf = now.toISOString();
    const summary: FeatureRunSummary = { asOf, symbols: symbols.length, computed: 0, skipped: 0, instrumentsUpdated: 0, freshness: {}, errors: [] };
    const benchmark = (await this.loadBars(benchmarkSymbol, now)).daily;
    if (benchmark.length === 0) summary.errors.push(`no ${benchmarkSymbol} bars: beta/residual features unavailable`);
    const quotes = new Map((await this.market.latestQuotes(symbols)).map((q) => [q.symbol, q]));
    for (const symbol of symbols) {
      try {
        const { daily, intraday } = await this.loadBars(symbol, now);
        if (daily.length === 0) { summary.skipped++; continue; }
        const qr = quotes.get(symbol);
        const quote: Quote | null = qr ? { symbol: qr.symbol, last: qr.last, bid: qr.bid, ask: qr.ask, previousClose: qr.previousClose, lastTradeAt: qr.lastTradeAt, session: qr.session as Quote["session"], instrumentState: qr.instrumentState as Quote["instrumentState"], provenance: { source: qr.source, observedAt: qr.observedAt, receivedAt: qr.receivedAt, reliability: qr.reliability } } : null;
        const fs = computeFeatures({ asOf, bars: daily, intradayBars: intraday, quote, benchmarkBars: symbol === benchmarkSymbol ? null : benchmark });
        await this.market.upsertFeatures({ symbol, asOf, featureVersion: FEATURE_VERSION, values: fs.values, freshness: fs.freshness });
        summary.computed++;
        summary.freshness[fs.freshness] = (summary.freshness[fs.freshness] ?? 0) + 1;
        const adv = fs.values[FEATURE.avgDollarVolume20] ?? null;
        const beta = fs.values[FEATURE.beta60] ?? null;
        if (adv !== null || beta !== null) {
          const existing = await this.market.instrument(symbol);
          await this.market.upsertInstrument({ symbol, assetClass: existing?.assetClass ?? "equity", avgDollarVolume20: adv ?? existing?.avgDollarVolume20 ?? null, beta: beta ?? existing?.beta ?? null });
          summary.instrumentsUpdated++;
        }
      } catch (err) {
        if (summary.errors.length < 10) summary.errors.push(`${symbol}: ${errorMessage(err)}`);
      }
    }
    if (summary.errors.length > 0) this.log.warn({ errors: summary.errors }, "feature pipeline had errors");
    this.lastRun = summary;
    return summary;
  }
}
