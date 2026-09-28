import type { IsoTimestamp } from "./ids.js";

export type RegimeLabel =
  | "bull_trend"
  | "bear_trend"
  | "range_bound"
  | "high_volatility"
  | "low_volatility"
  | "risk_on"
  | "risk_off"
  | "liquidity_shock"
  | "event_driven"
  | "sector_rotation"
  | "momentum"
  | "mean_reversion";

export interface RegimeAssessment {
  asOf: IsoTimestamp;
  /** Primary label plus supporting labels with probabilities. */
  primary: RegimeLabel;
  probabilities: Partial<Record<RegimeLabel, number>>;
  /** 0..1 how confident the engine is in the primary label. */
  confidence: number;
  /** 0..1 how unusual current behaviour is relative to history. */
  abnormality: number;
  metrics: {
    spyTrend20: number | null;
    spyTrend100: number | null;
    realizedVol20: number | null;
    vix: number | null;
    breadthPctAbove50: number | null;
    avgPairwiseCorrelation: number | null;
    sectorDispersion: number | null;
    momentumPersistence: number | null;
    meanReversionScore: number | null;
    volumeRatio: number | null;
  };
  /** Which strategy families are favoured / disfavoured given this regime. */
  familyBias: Record<string, number>;
  explanation: string[];
  dataQuality: "fresh" | "aging" | "stale" | "unknown";
}
