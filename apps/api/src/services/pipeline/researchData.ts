import type { AnalystRatings, BrokerAdapter, CuratedList, EarningsCalendarRange, EarningsRecord, IndexBar, IndexHistoricalsOptions, IndexRef, NewsArticle, RawRecord, WatchlistItem } from "@yz/broker";
import type { Repos } from "../../http/app.js";
import type { BrokerService } from "../brokerService.js";
import { maskAccountNumber } from "../../security/secrets.js";
import type { PipelineLogger } from "./common.js";

/**
 * Reference / research data that the shared pipeline reads (fundamentals, earnings, news, indexes).
 * None of it carries tenant data, so any connected Robinhood adapter may serve it. Everything
 * returned is DATA, never instructions.
 */
export interface ResearchDataAccess {
  readonly name: string;
  getFundamentals(symbol: string): Promise<RawRecord>;
  getEarnings(symbol: string): Promise<EarningsRecord[]>;
  getEarningsCalendar(range: EarningsCalendarRange): Promise<EarningsRecord[]>;
  getNews(symbol: string): Promise<NewsArticle[]>;
  getAnalystRatings(symbol: string): Promise<AnalystRatings | null>;
  getIndexes(symbols?: readonly string[]): Promise<IndexRef[]>;
  getIndexHistoricals(instrumentIds: readonly string[], opts: IndexHistoricalsOptions): Promise<IndexBar[]>;
  getCuratedLists(): Promise<CuratedList[]>;
  getWatchlistItems(listId: string): Promise<WatchlistItem[]>;
}

export type ResearchDataProvider = () => Promise<ResearchDataAccess | null>;

export function researchAccessFromAdapter(name: string, adapter: BrokerAdapter): ResearchDataAccess {
  return {
    name,
    getFundamentals: (s) => adapter.getFundamentals(s),
    getEarnings: (s) => adapter.getEarnings(s),
    getEarningsCalendar: (r) => adapter.getEarningsCalendar(r),
    getNews: (s) => adapter.getNews(s),
    getAnalystRatings: (s) => adapter.getAnalystRatings(s),
    getIndexes: (s) => adapter.getIndexes(s),
    getIndexHistoricals: (ids, o) => adapter.getIndexHistoricals(ids, o),
    getCuratedLists: () => adapter.getCuratedLists(),
    getWatchlistItems: (id) => adapter.getWatchlistItems(id),
  };
}

/**
 * Picks the first connected Robinhood Agentic account and exposes its adapter's research tools.
 * Mirrors `BrokerService.marketDataSource`. Returns null when no Robinhood account is connected:
 * callers must then leave the corresponding data empty (never invent reference data).
 */
export function createResearchDataProvider(repos: Repos, broker: BrokerService, log: PipelineLogger): ResearchDataProvider {
  return async () => {
    const all = await repos.accounts.listAll();
    for (const a of all) {
      if (a.kind !== "robinhood_agentic" || a.status !== "connected") continue;
      const scope = { userId: a.userId, brokerAccountId: a.id };
      try {
        const adapter = await broker.adapterFor(scope);
        if (!adapter) continue;
        return researchAccessFromAdapter(`robinhood_mcp:${maskAccountNumber(a.accountNumber)}`, adapter);
      } catch (err) {
        log.warn({ err }, "research data source construction failed");
      }
    }
    return null;
  };
}
