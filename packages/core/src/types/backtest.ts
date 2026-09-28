import type { IsoTimestamp } from "./ids.js";

export interface CostModel {
  commissionPerShare: number;
  commissionMin: number;
  /** Half-spread charged on each side, in bps, when no quote-based spread is available. */
  defaultHalfSpreadBps: number;
  /** Market-impact coefficient: slippage_bps = k * sqrt(participation). */
  impactCoefficient: number;
  /** Fixed latency between signal and order in bars. */
  executionDelayBars: number;
  /** Maximum fraction of a bar's volume a fill may consume. */
  maxParticipation: number;
}

export interface BacktestConfig {
  strategyKey: string;
  strategyVersion: string;
  parameters: Record<string, number | string | boolean>;
  symbols: string[];
  start: IsoTimestamp;
  end: IsoTimestamp;
  interval: "day" | "hour" | "30minute" | "5minute";
  initialCapital: number;
  costModel: CostModel;
  /** Include securities delisted during the window (survivorship-bias protection). */
  includeDelisted: boolean;
  seed: number;
}

export interface BacktestTrade {
  symbol: string;
  entryTime: IsoTimestamp;
  exitTime: IsoTimestamp | null;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  side: "long";
  grossPnl: number;
  costs: number;
  netPnl: number;
  returnPct: number;
  holdingBars: number;
  regime: string;
  confidence: number;
  maePct: number;
  mfePct: number;
  exitReason: string;
}

export interface BacktestMetrics {
  cagr: number | null;
  totalReturnPct: number;
  annualizedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationBars: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  turnover: number;
  exposure: number;
  var95Pct: number | null;
  cvar95Pct: number | null;
  tradeCount: number;
  grossReturnPct: number;
  totalCosts: number;
  netReturnPct: number;
  byRegime: Record<string, { trades: number; returnPct: number; winRate: number | null }>;
}

export interface EquityPoint { time: IsoTimestamp; equity: number; drawdownPct: number; exposure: number }

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  kind: "in_sample" | "out_of_sample" | "walk_forward" | "monte_carlo" | "stress" | "sensitivity";
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  warnings: string[];
  /** Fingerprint of the data used, so results can be reproduced. */
  dataFingerprint: string;
  ranAt: IsoTimestamp;
  durationMs: number;
}

export interface WalkForwardResult {
  folds: { train: [IsoTimestamp, IsoTimestamp]; test: [IsoTimestamp, IsoTimestamp]; metrics: BacktestMetrics; parameters: Record<string, number | string | boolean> }[];
  aggregate: BacktestMetrics;
  parameterStability: number | null;
  overfittingScore: number | null;
}

export interface MonteCarloResult {
  runs: number;
  medianReturnPct: number;
  p05ReturnPct: number;
  p95ReturnPct: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  probabilityOfLoss: number;
}
