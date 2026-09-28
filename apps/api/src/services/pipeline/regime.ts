import type { Bar, RegimeAssessment, RegimeLabel } from "@yz/core";
import { FEATURE, FEATURE_VERSION, REGIME_ENGINE_VERSION, assessRegime, closes, regimeUsefulnessScore, simpleReturns, stddev, usableBars, type RegimeUsefulness } from "@yz/core";
import type { DataPlaneRepository, MarketRepository } from "@yz/db";
import { SECTOR_ETFS } from "./universe.js";
import { errorMessage, rowToBar, type PipelineLogger } from "./common.js";
import type { ResearchDataProvider } from "./researchData.js";

export interface RegimeRow {
  id: string; asOf: string; primary: string; probabilities: Record<string, number>; confidence: number; abnormality: number; metrics: unknown;
  familyBias: Record<string, number>; explanation: string[]; dataQuality: string; engineVersion: string; forwardReturn5d: number | null; forwardVol5d: number | null;
}

export function rowToAssessment(r: RegimeRow): RegimeAssessment {
  return {
    asOf: r.asOf, primary: r.primary as RegimeLabel, probabilities: r.probabilities as RegimeAssessment["probabilities"], confidence: r.confidence, abnormality: r.abnormality,
    metrics: r.metrics as RegimeAssessment["metrics"], familyBias: r.familyBias, explanation: r.explanation, dataQuality: r.dataQuality as RegimeAssessment["dataQuality"],
  };
}

export interface RegimeRunSummary {
  id: string | null;
  asOf: string;
  primary: string | null;
  confidence: number | null;
  dataQuality: string;
  inputs: { spyBars: number; qqqBars: number; vixBars: number; sectorEtfs: number; breadthSymbols: number; universeSymbols: number; eventDriven: boolean };
  errors: string[];
}

/**
 * Assesses the market regime from persisted bars, features and (when a Robinhood connection
 * exists) the VIX index history; resolves forward returns for usefulness scoring later.
 */
export class RegimePipeline {
  lastRun: RegimeRunSummary | null = null;

  constructor(
    private readonly market: MarketRepository,
    private readonly dataPlane: DataPlaneRepository,
    private readonly research: ResearchDataProvider,
    private readonly log: PipelineLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async dailyBars(symbol: string, now: Date, days = 420, limit = 600): Promise<Bar[]> {
    const rows = await this.market.bars(symbol, "day", { start: new Date(now.getTime() - days * 86_400_000).toISOString(), limit });
    return rows.map(rowToBar);
  }

  /** VIX daily history via index tools; null when no connection or the index is unavailable. */
  async vixBars(now: Date, errors: string[]): Promise<Bar[] | null> {
    const research = await this.research();
    if (!research) return null;
    try {
      const refs = await research.getIndexes(["VIX"]);
      const vix = refs.find((r) => r.symbol.toUpperCase() === "VIX") ?? refs.find((r) => r.symbol.toUpperCase().includes("VIX"));
      if (!vix) return null;
      const bars = await research.getIndexHistoricals([vix.id], { start: new Date(now.getTime() - 400 * 86_400_000).toISOString(), end: now.toISOString(), interval: "day" });
      return bars.map((b) => ({ symbol: "VIX", interval: "day" as const, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0, interpolated: b.interpolated, adjusted: "none" as const, provenance: b.provenance }));
    } catch (err) {
      errors.push(`vix: ${errorMessage(err)}`);
      return null;
    }
  }

  async assess(universeSymbols: string[]): Promise<RegimeRunSummary> {
    const now = this.clock();
    const asOf = now.toISOString();
    const errors: string[] = [];
    const [spy, qqq, vix] = await Promise.all([this.dailyBars("SPY", now), this.dailyBars("QQQ", now), this.vixBars(now, errors)]);
    const sectorEtfs: Record<string, Bar[]> = {};
    for (const etf of SECTOR_ETFS) {
      const bars = await this.dailyBars(etf, now, 200, 260);
      if (bars.length > 0) sectorEtfs[etf] = bars;
    }
    // Breadth from the latest features (close vs SMA50/200).
    const feats = await this.dataPlane.latestFeaturesFor(universeSymbols, FEATURE_VERSION);
    let n50 = 0, above50 = 0, n200 = 0, above200 = 0;
    for (const f of feats) {
      const close = f.values[FEATURE.close] ?? null;
      const s50 = f.values[FEATURE.sma50] ?? null;
      const s200 = f.values[FEATURE.sma200] ?? null;
      if (close !== null && s50 !== null) { n50++; if (close > s50) above50++; }
      if (close !== null && s200 !== null) { n200++; if (close > s200) above200++; }
    }
    const breadth = n50 >= 10 ? { pctAbove50: (above50 / n50) * 100, pctAbove200: n200 >= 10 ? (above200 / n200) * 100 : null } : null;
    // Universe return series for average pairwise correlation (last ~80 sessions).
    const universeReturns: Record<string, number[]> = {};
    for (const s of universeSymbols) {
      const bars = usableBars(await this.dailyBars(s, now, 130, 90), asOf);
      if (bars.length >= 30) universeReturns[s] = simpleReturns(closes(bars));
    }
    // Event-driven flag: scheduled high-importance economic events within 24 h (never invented).
    const events = await this.dataPlane.economicEventsBetween(new Date(now.getTime() - 6 * 3_600_000).toISOString(), new Date(now.getTime() + 24 * 3_600_000).toISOString());
    const eventDriven = events.some((e) => e.importance === "high");

    const assessment = assessRegime({ asOf, spy, qqq, vix, sectorEtfs, breadth, universeReturns: Object.keys(universeReturns).length >= 2 ? universeReturns : null, eventDriven });
    let id: string | null = null;
    if (spy.length > 0) {
      id = await this.market.recordRegime({ asOf, primary: assessment.primary, probabilities: assessment.probabilities as Record<string, number>, confidence: assessment.confidence, abnormality: assessment.abnormality, metrics: assessment.metrics, familyBias: assessment.familyBias, explanation: assessment.explanation, dataQuality: assessment.dataQuality, engineVersion: REGIME_ENGINE_VERSION });
    } else {
      errors.push("no SPY bars: regime not recorded");
    }
    const summary: RegimeRunSummary = {
      id, asOf, primary: id ? assessment.primary : null, confidence: id ? assessment.confidence : null, dataQuality: assessment.dataQuality,
      inputs: { spyBars: spy.length, qqqBars: qqq.length, vixBars: vix?.length ?? 0, sectorEtfs: Object.keys(sectorEtfs).length, breadthSymbols: n50, universeSymbols: Object.keys(universeReturns).length, eventDriven },
      errors,
    };
    if (errors.length > 0) this.log.warn({ errors }, "regime assessment had issues");
    this.lastRun = summary;
    return summary;
  }

  /** Fill forward 5-day SPY return / realised vol for assessments old enough to be scored. */
  async resolve(): Promise<{ resolved: number; pending: number }> {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const pending = await this.market.unresolvedRegimes(cutoff, 200);
    if (pending.length === 0) return { resolved: 0, pending: 0 };
    const spy = usableBars(await this.dailyBars("SPY", now, 500, 800), now.toISOString());
    let resolved = 0;
    for (const r of pending) {
      const asOfMs = Date.parse(r.asOf);
      const idx = spy.findIndex((b) => Date.parse(b.time) > asOfMs);
      if (idx <= 0 || idx + 5 > spy.length) continue; // need a base close and 5 later sessions; otherwise wait
      const base = spy[idx - 1]!.close;
      const window = spy.slice(idx, idx + 5);
      const last = window[window.length - 1]!.close;
      const rets = simpleReturns([base, ...window.map((b) => b.close)]);
      const sd = stddev(rets);
      const forwardReturn5d = base > 0 ? last / base - 1 : 0;
      const forwardVol5d = sd === null ? 0 : sd * Math.sqrt(252);
      await this.market.resolveRegime(r.id, forwardReturn5d, forwardVol5d);
      resolved++;
    }
    return { resolved, pending: pending.length - resolved };
  }

  async usefulness(): Promise<RegimeUsefulness> {
    const rows = await this.dataPlane.regimesResolved(500);
    return regimeUsefulnessScore(rows.map((r) => ({ assessment: rowToAssessment(r as RegimeRow), forwardReturn5d: r.forwardReturn5d, forwardVol5d: r.forwardVol5d })));
  }
}
