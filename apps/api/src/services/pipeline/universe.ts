import type { Tradability } from "@yz/core";
import type { DataPlaneRepository } from "@yz/db";
import type { Repos } from "../../http/app.js";
import type { MarketDataService } from "../marketData.js";
import { chunk, errorMessage, type PipelineLogger } from "./common.js";
import type { ResearchDataProvider } from "./researchData.js";

export const SECTOR_ETFS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"] as const;
export const INDEX_ETFS = ["SPY", "QQQ"] as const;

/** Curated liquid US large/mid caps (research universe seed). Symbols only; every attribute is fetched, never assumed. */
export const DEFAULT_STOCKS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK.B", "JPM",
  "LLY", "V", "MA", "UNH", "XOM", "COST", "HD", "PG", "JNJ", "ABBV",
  "NFLX", "CRM", "BAC", "ORCL", "KO", "CVX", "MRK", "AMD", "PEP", "WMT",
  "ADBE", "CSCO", "TMO", "ACN", "MCD", "LIN", "ABT", "WFC", "INTU", "DIS",
  "QCOM", "TXN", "CAT", "AMGN", "GE", "IBM", "NOW", "ISRG", "GS", "BKNG",
  "UBER", "AMAT", "PFE", "HON", "LOW", "SPGI", "BLK", "MS", "NKE", "PANW",
] as const;

export const DEFAULT_UNIVERSE: readonly string[] = [...DEFAULT_STOCKS, ...SECTOR_ETFS, ...INDEX_ETFS];

/** Most symbols discovery may add on top of the curated universe (bars/features/candidates cost scale with it). */
export const DISCOVERY_MAX_SYMBOLS = 120;
/** Symbols taken from each curated list at most. */
export const DISCOVERY_PER_LIST = 100;

export interface DiscoveredSymbol { symbol: string; list: string }

/**
 * Pure selection of discovery candidates: US stocks/ETFs only (objectType "instrument"), valid
 * tickers, no duplicates, nothing already in the base universe, capped per list and overall.
 * Order of lists is preserved so earlier (more relevant) lists win the cap.
 */
export function selectDiscovered(lists: { name: string; items: { symbol: string; objectType: string }[] }[], base: readonly string[], max = DISCOVERY_MAX_SYMBOLS, perList = DISCOVERY_PER_LIST): DiscoveredSymbol[] {
  const taken = new Set(base.map((s) => s.toUpperCase()));
  const out: DiscoveredSymbol[] = [];
  for (const l of lists) {
    let n = 0;
    for (const it of l.items) {
      if (out.length >= max) return out;
      if (n >= perList) break;
      const sym = it.symbol.toUpperCase();
      if (it.objectType !== "instrument" || !isSymbol(sym) || taken.has(sym)) continue;
      taken.add(sym);
      out.push({ symbol: sym, list: l.name });
      n += 1;
    }
  }
  return out;
}

export interface UniverseSnapshot {
  symbols: string[];
  /** Symbols added by discovery from the broker's curated lists (subset of `symbols`). */
  discovered: string[];
  held: string[];
  ordered: string[];
  allowed: string[];
  candidates: string[];
}

/**
 * The shared research universe: the curated default list plus everything currently held or
 * ordered in any account plus per-user allowed symbols. Persists reference data into
 * `instruments` from broker fundamentals/tradability when a Robinhood connection exists.
 */
export class UniverseService {
  constructor(
    private readonly repos: Repos,
    private readonly dataPlane: DataPlaneRepository,
    private readonly marketData: MarketDataService,
    private readonly research: ResearchDataProvider,
    private readonly log: PipelineLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Discovered symbols (kept in memory; rediscovered hourly and after every restart). */
  private discovered: DiscoveredSymbol[] = [];

  get discoveredSymbols(): readonly DiscoveredSymbol[] { return this.discovered; }

  /**
   * Widen the research universe with the broker's curated discovery lists ("100 Most Popular",
   * "Daily Movers", ...). Nothing is invented: with no connected broker the list stays as it was.
   * Returns the symbols that are new since the last discovery so their reference data can be fetched.
   */
  async discover(): Promise<{ source: string | null; lists: number; discovered: number; added: string[]; errors: string[] }> {
    const research = await this.research();
    if (!research) return { source: null, lists: 0, discovered: this.discovered.length, added: [], errors: ["no connected broker"] };
    const errors: string[] = [];
    let lists: { name: string; items: { symbol: string; objectType: string }[] }[] = [];
    try {
      const curated = await research.getCuratedLists();
      for (const l of curated) {
        try { lists.push({ name: l.name, items: await research.getWatchlistItems(l.id) }); }
        catch (err) { errors.push(`${l.name}: ${errorMessage(err)}`); }
      }
    } catch (err) {
      errors.push(`curated lists: ${errorMessage(err)}`);
      return { source: research.name, lists: 0, discovered: this.discovered.length, added: [], errors };
    }
    const before = new Set(this.discovered.map((d) => d.symbol));
    const next = selectDiscovered(lists, DEFAULT_UNIVERSE);
    // Keep previously discovered symbols that are currently held/ordered so their pipeline data continues.
    const { held, ordered } = await this.heldAndOrdered();
    const keep = new Set([...held, ...ordered]);
    const nextSet = new Set(next.map((d) => d.symbol));
    for (const d of this.discovered) if (keep.has(d.symbol) && !nextSet.has(d.symbol)) next.push(d);
    this.discovered = next;
    const added = next.map((d) => d.symbol).filter((s) => !before.has(s)).sort();
    if (errors.length > 0) this.log.warn({ errors: errors.slice(0, 5) }, "universe discovery had errors");
    return { source: research.name, lists: lists.length, discovered: next.length, added, errors };
  }

  /** Symbols held or with open orders in any account, read through each account's scope. */
  async heldAndOrdered(): Promise<{ held: string[]; ordered: string[]; bySymbolAccounts: Map<string, number> }> {
    const held = new Set<string>();
    const ordered = new Set<string>();
    const bySymbolAccounts = new Map<string, number>();
    const accounts = await this.repos.accounts.listAll();
    for (const a of accounts) {
      const scope = { userId: a.userId, brokerAccountId: a.id };
      const [positions, open] = await Promise.all([this.repos.positions.list(scope), this.repos.orders.open(scope)]);
      for (const p of positions) {
        const s = p.symbol.toUpperCase();
        held.add(s);
        bySymbolAccounts.set(s, (bySymbolAccounts.get(s) ?? 0) + 1);
      }
      for (const o of open) ordered.add(o.symbol.toUpperCase());
    }
    return { held: [...held].sort(), ordered: [...ordered].sort(), bySymbolAccounts };
  }

  async snapshot(): Promise<UniverseSnapshot> {
    const [{ held, ordered }, allowed, candidates] = await Promise.all([this.heldAndOrdered(), this.dataPlane.allowedSymbolsUnion(), this.dataPlane.candidateSymbols()]);
    const symbols = new Set<string>(DEFAULT_UNIVERSE);
    for (const d of this.discovered) symbols.add(d.symbol);
    for (const s of [...held, ...ordered, ...allowed]) if (isSymbol(s)) symbols.add(s);
    return { symbols: [...symbols].sort(), discovered: this.discovered.map((d) => d.symbol).sort(), held, ordered, allowed: allowed.sort(), candidates: candidates.map((c) => c.toUpperCase()).sort() };
  }

  async symbols(): Promise<string[]> {
    return (await this.snapshot()).symbols;
  }

  /** Symbols that need intraday bars / frequent quotes: held, ordered and active candidates. */
  async activeSymbols(): Promise<string[]> {
    const s = await this.snapshot();
    return [...new Set([...s.held, ...s.ordered, ...s.candidates])].sort();
  }

  /**
   * Refresh `instruments` rows: name/sector/industry/market cap from fundamentals, tradeable /
   * fractional / state from tradability. Fields the broker does not return stay null.
   */
  async refreshInstruments(symbols?: string[]): Promise<{ symbols: number; fundamentals: number; tradability: number; source: string | null; errors: string[] }> {
    const list = symbols ?? (await this.symbols());
    const errors: string[] = [];
    const now = this.clock().toISOString();
    // Tradability (batched; the adapter handles chunking upstream).
    const tradability = new Map<string, Tradability>();
    for (const part of chunk(list, 20)) {
      try {
        for (const t of await this.marketData.getTradability(part)) tradability.set(t.symbol.toUpperCase(), t);
      } catch (err) {
        errors.push(`tradability: ${errorMessage(err)}`);
        break;
      }
    }
    const research = await this.research();
    let fundamentals = 0;
    for (const symbol of list) {
      const existing = await this.repos.market.instrument(symbol);
      const row: Record<string, unknown> = { symbol, assetClass: existing?.assetClass ?? "equity" };
      const t = tradability.get(symbol);
      if (t) {
        row["tradeable"] = t.tradeable;
        row["fractional"] = t.fractional;
        row["state"] = t.halted ? "halted" : t.tradeable ? "active" : t.accountRule === "position_closing_only" ? "closing_only" : "inactive";
      }
      if (research) {
        try {
          const f = await research.getFundamentals(symbol);
          const d = f.data as Record<string, unknown>;
          const str = (k: string): string | null => (typeof d[k] === "string" && (d[k] as string).length > 0 ? (d[k] as string) : null);
          const num = (k: string): number | null => { const v = d[k]; const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
          row["sector"] = str("sector") ?? existing?.sector ?? null;
          row["industry"] = str("industry") ?? existing?.industry ?? null;
          row["marketCap"] = num("market_cap") ?? existing?.marketCap ?? null;
          const name = str("name") ?? str("simple_name") ?? null;
          if (name) row["name"] = name;
          row["meta"] = { ...(existing?.meta && typeof existing.meta === "object" ? existing.meta as Record<string, unknown> : {}), fundamentals: { description: str("description"), ceo: str("ceo"), headquarters: [str("headquarters_city"), str("headquarters_state")].filter(Boolean).join(", ") || null, peRatio: num("pe_ratio"), pbRatio: num("pb_ratio"), dividendYield: num("dividend_yield"), sharesOutstanding: num("shares_outstanding"), averageVolume30d: num("average_volume_30_days"), high52w: num("high_52_weeks"), low52w: num("low_52_weeks"), marketDate: str("market_date"), source: f.provenance.source, observedAt: f.provenance.observedAt, receivedAt: now } };
          fundamentals++;
        } catch (err) {
          errors.push(`${symbol} fundamentals: ${errorMessage(err)}`);
          if (errors.length > 10) break;
        }
      }
      if (SECTOR_ETFS.includes(symbol as (typeof SECTOR_ETFS)[number]) || INDEX_ETFS.includes(symbol as (typeof INDEX_ETFS)[number])) row["assetClass"] = "etf";
      await this.repos.market.upsertInstrument(row as { symbol: string });
    }
    if (errors.length > 0) this.log.warn({ errors: errors.slice(0, 5), count: errors.length }, "instrument refresh had errors");
    return { symbols: list.length, fundamentals, tradability: tradability.size, source: research?.name ?? null, errors };
  }
}

function isSymbol(s: string): boolean {
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s);
}
