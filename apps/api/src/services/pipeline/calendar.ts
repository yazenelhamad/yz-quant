import type { EarningsRecord } from "@yz/broker";
import { newYorkOffsetMinutes } from "@yz/core";
import type { MarketRepository } from "@yz/db";
import { errorMessage, type PipelineLogger } from "./common.js";
import type { ResearchDataProvider } from "./researchData.js";

export interface CalendarRunSummary {
  source: string | null;
  symbols: number;
  earningsUpserted: number;
  calendarUpserted: number;
  economicEvents: "no_provider";
  errors: string[];
}

/** YYYY-MM-DD + am/pm → ISO instant in New York (bmo ≈ 08:00 ET, amc ≈ 16:30 ET, unknown ≈ 12:00 ET). */
export function earningsReportInstant(date: string, timing: string | null): { reportAt: string; timing: "bmo" | "amc" | "unknown" } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = (timing ?? "").toLowerCase();
  const kind: "bmo" | "amc" | "unknown" = t === "am" || t === "bmo" ? "bmo" : t === "pm" || t === "amc" ? "amc" : "unknown";
  const hh = kind === "bmo" ? 8 : kind === "amc" ? 16 : 12;
  const mm = kind === "amc" ? 30 : 0;
  // New York local time → instant, DST-aware via the shared calendar helper.
  const y = Number(date.slice(0, 4)), mo = Number(date.slice(5, 7)) - 1, d = Number(date.slice(8, 10));
  let instant = Date.UTC(y, mo, d, hh, mm);
  for (let i = 0; i < 2; i++) instant = Date.UTC(y, mo, d, hh, mm) - newYorkOffsetMinutes(new Date(instant)) * 60_000;
  return { reportAt: new Date(instant).toISOString(), timing: kind };
}

/**
 * Daily earnings-calendar ingestion for the universe. `economic_events` is intentionally left
 * untouched: Robinhood exposes no macro calendar and this platform never invents one.
 */
/** Days of past earnings reports kept fresh in the calendar (post-earnings guard window plus margin). */
export const RECENT_EARNINGS_DAYS = 21;

export class CalendarPipeline {
  lastRun: CalendarRunSummary | null = null;

  constructor(private readonly market: MarketRepository, private readonly research: ResearchDataProvider, private readonly log: PipelineLogger, private readonly clock: () => Date = () => new Date()) {}

  private async upsertRecords(records: EarningsRecord[], symbols: Set<string>, source: string): Promise<number> {
    let n = 0;
    for (const e of records) {
      if (!e.reportDate || !symbols.has(e.symbol.toUpperCase())) continue;
      const when = earningsReportInstant(e.reportDate, e.reportTiming);
      if (!when) continue;
      await this.market.upsertEarnings({ symbol: e.symbol.toUpperCase(), reportAt: when.reportAt, timing: when.timing, epsEstimate: e.epsEstimate, epsActual: e.epsActual, revenueEstimate: null, revenueActual: null, source });
      n++;
    }
    return n;
  }

  async run(universeSymbols: string[], heldSymbols: string[]): Promise<CalendarRunSummary> {
    const research = await this.research();
    const summary: CalendarRunSummary = { source: research?.name ?? null, symbols: universeSymbols.length, earningsUpserted: 0, calendarUpserted: 0, economicEvents: "no_provider", errors: [] };
    if (!research) { this.lastRun = summary; return summary; }
    const universe = new Set(universeSymbols.map((s) => s.toUpperCase()));
    // Forward calendar (next 30 days) filtered to the universe.
    const now = this.clock();
    try {
      const today = now.toISOString().slice(0, 10);
      const cal = await research.getEarningsCalendar({ startDate: today, days: 30 });
      summary.calendarUpserted += await this.upsertRecords(cal, universe, `${research.name}:get_earnings_calendar`);
    } catch (err) {
      summary.errors.push(`calendar: ${errorMessage(err)}`);
    }
    // Recent past reports (last 21 days): mean-reversion strategies refuse a post-earnings slide, so
    // they need to know a report happened even if it was never on the forward calendar we stored.
    // Fetched separately so a provider that refuses past dates cannot cost the forward calendar.
    try {
      const start = new Date(now.getTime() - RECENT_EARNINGS_DAYS * 86_400_000).toISOString().slice(0, 10);
      const past = await research.getEarningsCalendar({ startDate: start, days: RECENT_EARNINGS_DAYS });
      summary.calendarUpserted += await this.upsertRecords(past, universe, `${research.name}:get_earnings_calendar`);
    } catch (err) {
      summary.errors.push(`recent calendar: ${errorMessage(err)}`);
    }
    // Per-symbol history/upcoming for held symbols (bounded: these are the ones the dashboard shows as catalysts).
    for (const symbol of heldSymbols.slice(0, 50)) {
      try {
        const recs = await research.getEarnings(symbol);
        summary.earningsUpserted += await this.upsertRecords(recs, universe, `${research.name}:get_earnings_results`);
      } catch (err) {
        if (summary.errors.length < 10) summary.errors.push(`${symbol}: ${errorMessage(err)}`);
      }
    }
    if (summary.errors.length > 0) this.log.warn({ errors: summary.errors }, "earnings calendar run had errors");
    this.lastRun = summary;
    return summary;
  }
}
