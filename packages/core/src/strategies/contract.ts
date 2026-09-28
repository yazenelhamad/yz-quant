import type { Bar, Quote, RegimeAssessment, Signal, StrategyFamily, RegimeLabel, IsoTimestamp } from "../types/index.js";

/**
 * Strategy contract shared by live trading, shadow trading and the backtester.
 * A strategy is a pure function of its context: no I/O, no clock access, no randomness.
 * The same implementation runs everywhere so live behaviour and backtests cannot diverge.
 */
export interface StrategyContext {
  /** Decision time. Strategies must not use data after this time (look-ahead protection). */
  asOf: IsoTimestamp;
  symbol: string;
  /** Bars strictly at or before asOf, ascending, non-interpolated. */
  bars: Bar[];
  /** Optional finer bars (e.g. 5-minute) at or before asOf. */
  intradayBars?: Bar[];
  quote: Quote | null;
  /** Computed features for the symbol at asOf (see features/). Values may be null when unavailable. */
  features: Record<string, number | null>;
  regime: RegimeAssessment;
  /** Cross-sectional context: features of the universe at asOf (for ranking strategies). */
  universe?: { symbol: string; features: Record<string, number | null> }[];
  /** Sector benchmark features (e.g. sector ETF momentum). */
  sector?: { name: string; features: Record<string, number | null> } | null;
  /** Upcoming catalysts for the symbol within the strategy horizon. */
  upcomingEvents: { kind: string; at: IsoTimestamp; description: string }[];
  /** Current open position for the symbol in the evaluating account (null if none). */
  position: { quantity: number; averageCost: number; openedAt: IsoTimestamp; strategyKey: string | null } | null;
  parameters: Record<string, number | string | boolean>;
  featureVersion: string;
}

export interface StrategyOutput {
  signals: Signal[];
  /** Strategy-level view combining its signals. Null = no opinion. */
  view: {
    direction: "long" | "reduce" | "exit" | "flat";
    /** [-1, 1] */
    strength: number;
    /** [0, 1] raw confidence before calibration. */
    confidence: number;
    horizonDays: number;
    expectedUpsidePct: number;
    expectedDownsidePct: number;
    invalidationPrice: number | null;
    targetPrice: number | null;
    explanation: string;
    /** Reconciled geometry (long entries): target/stop distances in horizon-sigmas and the reward/risk they imply. */
    rewardRisk?: number;
    stopSigma?: number;
    targetSigma?: number;
    /** The structural thesis level (e.g. a moving average) when the risk stop had to sit closer to price than it. */
    structuralInvalidationPrice?: number | null;
    /** Adjustments the geometry reconciliation made (tightened stop, capped target). */
    geometryNotes?: string[];
  } | null;
}

export interface StrategyDescriptor {
  key: string;
  name: string;
  family: StrategyFamily;
  description: string;
  supportedRegimes: RegimeLabel[];
  /** Default parameters and their allowed ranges for sensitivity testing / bounded adaptation. */
  parameters: Record<string, { default: number | string | boolean; min?: number; max?: number; step?: number; description: string }>;
  /** Minimum bars required before the strategy can produce output. */
  warmupBars: number;
  /** Bar interval the strategy is designed for. */
  interval: "day" | "hour" | "30minute" | "5minute";
  /** Whether this strategy needs the cross-sectional universe context. */
  needsUniverse: boolean;
}

export interface Strategy {
  descriptor: StrategyDescriptor;
  evaluate(ctx: StrategyContext): StrategyOutput;
}
