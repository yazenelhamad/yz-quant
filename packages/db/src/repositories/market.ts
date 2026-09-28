import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { instruments, marketBars, marketQuotes, marketRegimes, features, signals, newsEvents, earningsEvents } from "../schema/index.js";
import { newId, Repository } from "./base.js";

export class MarketRepository extends Repository {
  async upsertInstrument(row: typeof instruments.$inferInsert): Promise<void> {
    const existing = (await this.db.select().from(instruments).where(eq(instruments.symbol, row.symbol)).limit(1))[0];
    if (existing) await this.db.update(instruments).set({ ...row, updatedAt: new Date().toISOString() }).where(eq(instruments.symbol, row.symbol));
    else await this.db.insert(instruments).values(row);
  }
  async instrument(symbol: string) {
    return (await this.db.select().from(instruments).where(eq(instruments.symbol, symbol)).limit(1))[0];
  }
  async instrumentsFor(symbols: string[]) {
    if (symbols.length === 0) return [];
    return this.db.select().from(instruments).where(inArray(instruments.symbol, symbols));
  }
  async allInstruments() {
    return this.db.select().from(instruments);
  }

  async recordQuotes(rows: Omit<typeof marketQuotes.$inferInsert, "id">[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(marketQuotes).values(rows.map((r) => ({ ...r, id: newId() })));
  }
  /** Latest quote per symbol (by receipt time). */
  async latestQuotes(symbols: string[]) {
    if (symbols.length === 0) return [];
    const rows = await this.db.select().from(marketQuotes).where(inArray(marketQuotes.symbol, symbols)).orderBy(desc(marketQuotes.receivedAt)).limit(symbols.length * 5);
    const seen = new Map<string, typeof rows[number]>();
    for (const r of rows) if (!seen.has(r.symbol)) seen.set(r.symbol, r);
    return Array.from(seen.values());
  }
  async pruneQuotes(olderThanIso: string): Promise<void> {
    await this.db.delete(marketQuotes).where(lte(marketQuotes.receivedAt, olderThanIso));
  }

  async upsertBars(rows: Omit<typeof marketBars.$inferInsert, "id">[]): Promise<number> {
    if (rows.length === 0) return 0;
    let n = 0;
    for (const chunk of chunks(rows, 500)) {
      const res = await this.db.insert(marketBars).values(chunk.map((r) => ({ ...r, id: newId() })))
        .onConflictDoUpdate({ target: [marketBars.symbol, marketBars.interval, marketBars.time, marketBars.adjusted], set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, volume: sql`excluded.volume`, interpolated: sql`excluded.interpolated`, receivedAt: sql`excluded.received_at` } });
      n += chunk.length;
      void res;
    }
    return n;
  }
  async bars(symbol: string, interval: string, opts: { start?: string; end?: string; limit?: number; adjusted?: string } = {}) {
    const conds = [eq(marketBars.symbol, symbol), eq(marketBars.interval, interval), eq(marketBars.adjusted, opts.adjusted ?? "split")];
    if (opts.start) conds.push(gte(marketBars.time, opts.start));
    if (opts.end) conds.push(lte(marketBars.time, opts.end));
    const rows = await this.db.select().from(marketBars).where(and(...conds)).orderBy(desc(marketBars.time)).limit(opts.limit ?? 600);
    return rows.reverse();
  }
  async latestBarTime(symbol: string, interval: string): Promise<string | null> {
    const r = (await this.db.select({ t: sql<string>`max(${marketBars.time})` }).from(marketBars).where(and(eq(marketBars.symbol, symbol), eq(marketBars.interval, interval))))[0];
    return r?.t ?? null;
  }

  async recordRegime(row: Omit<typeof marketRegimes.$inferInsert, "id">): Promise<string> {
    const id = newId();
    await this.db.insert(marketRegimes).values({ ...row, id });
    return id;
  }
  async latestRegime() {
    return (await this.db.select().from(marketRegimes).orderBy(desc(marketRegimes.asOf)).limit(1))[0];
  }
  async regimeHistory(limit = 200) {
    return this.db.select().from(marketRegimes).orderBy(desc(marketRegimes.asOf)).limit(limit);
  }
  async unresolvedRegimes(beforeIso: string, limit = 100) {
    return this.db.select().from(marketRegimes).where(and(sql`${marketRegimes.forwardReturn5d} is null`, lte(marketRegimes.asOf, beforeIso))).limit(limit);
  }
  async resolveRegime(id: string, forwardReturn5d: number, forwardVol5d: number) {
    await this.db.update(marketRegimes).set({ forwardReturn5d, forwardVol5d }).where(eq(marketRegimes.id, id));
  }

  async upsertFeatures(row: Omit<typeof features.$inferInsert, "id">) {
    await this.db.insert(features).values({ ...row, id: newId() }).onConflictDoUpdate({ target: [features.symbol, features.asOf, features.featureVersion], set: { values: sql`excluded.values`, freshness: sql`excluded.freshness` } });
  }
  async latestFeatures(symbol: string, featureVersion: string) {
    return (await this.db.select().from(features).where(and(eq(features.symbol, symbol), eq(features.featureVersion, featureVersion))).orderBy(desc(features.asOf)).limit(1))[0];
  }

  async recordSignals(rows: Omit<typeof signals.$inferInsert, "id">[]) {
    if (rows.length === 0) return;
    await this.db.insert(signals).values(rows.map((r) => ({ ...r, id: newId() })));
  }
  async unresolvedSignals(beforeIso: string, limit = 500) {
    return this.db.select().from(signals).where(and(sql`${signals.resolvedAt} is null`, lte(signals.asOf, beforeIso))).limit(limit);
  }
  async resolveSignal(id: string, realizedReturnPct: number) {
    await this.db.update(signals).set({ realizedReturnPct, resolvedAt: new Date().toISOString() }).where(eq(signals.id, id));
  }
  async resolvedSignals(key: string, limit = 2000) {
    return this.db.select().from(signals).where(and(eq(signals.key, key), sql`${signals.resolvedAt} is not null`)).orderBy(desc(signals.asOf)).limit(limit);
  }
  async signalKeys(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ key: signals.key }).from(signals);
    return rows.map((r) => r.key);
  }

  async recordNews(rows: Omit<typeof newsEvents.$inferInsert, "id">[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      const res = await this.db.insert(newsEvents).values({ ...r, id: newId() }).onConflictDoNothing({ target: newsEvents.contentHash }).returning();
      n += res.length;
    }
    return n;
  }
  async newsFor(symbol: string, sinceIso: string, limit = 50) {
    const rows = await this.db.select().from(newsEvents).where(gte(newsEvents.publishedAt, sinceIso)).orderBy(desc(newsEvents.publishedAt)).limit(limit * 4);
    return rows.filter((r) => r.symbols.includes(symbol)).slice(0, limit);
  }
  async upsertEarnings(row: Omit<typeof earningsEvents.$inferInsert, "id">) {
    await this.db.insert(earningsEvents).values({ ...row, id: newId() }).onConflictDoUpdate({ target: [earningsEvents.symbol, earningsEvents.reportAt], set: { epsEstimate: sql`excluded.eps_estimate`, epsActual: sql`excluded.eps_actual`, revenueEstimate: sql`excluded.revenue_estimate`, revenueActual: sql`excluded.revenue_actual`, updatedAt: new Date().toISOString() } });
  }
  async upcomingEarnings(symbols: string[], fromIso: string, toIso: string) {
    if (symbols.length === 0) return [];
    return this.db.select().from(earningsEvents).where(and(inArray(earningsEvents.symbol, symbols), gte(earningsEvents.reportAt, fromIso), lte(earningsEvents.reportAt, toIso)));
  }
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
