import type { IsoTimestamp, PerformanceStats, RiskSettings, StrategyIntelligenceProfile, StrategyStage, TenantScope } from "../types/index.js";

/**
 * SURVIVAL MANDATE — "earn or die".
 *
 * The desk exists to compound capital. This module turns that into a deterministic, auditable
 * state machine per account: the account's realised record (fills, not forecasts) decides how much
 * live risk it may take, how high the edge hurdle is, and whether it may take live risk at all.
 * Losing the right to trade live is the "death"; earning it back requires proof in shadow.
 *
 * Units: P&L and drawdown are signed FRACTIONS (0.02 = 2%) like the risk engine; per-trade
 * statistics come from the learning engine in PERCENT POINTS (PerformanceStats.expectancyPct 0.4 =
 * +0.4% per trade). Costs and hurdles are in basis points.
 */
export type SurvivalMode = "thriving" | "earning" | "probation" | "survival" | "hibernation";

/** Best to worst. */
export const SURVIVAL_MODES: readonly SurvivalMode[] = ["thriving", "earning", "probation", "survival", "hibernation"];

export interface SurvivalWindow {
  overall: PerformanceStats;
  recent: PerformanceStats;
}

export interface SurvivalOptions {
  /** Live trades needed before the record counts as evidence (default 15). */
  minTrades: number;
  /** Recent-window size the caller used for `recent` (default 20). */
  recentN: number;
  /** Base hurdle (bps of notional, round trip) a trade must clear after costs (default 10). */
  hurdleBps: number;
  /** Days an account must dwell in a mode before it can be promoted one rung (default 2). */
  promotionDwellDays: number;
  /** Shadow trades with positive expectancy required to leave hibernation (default 20). */
  hibernationExitShadowTrades: number;
  /** Runway (days to the drawdown limit at the current burn) below which probation applies (default 20). */
  runwayWarningDays: number;
  /** Runway below which survival mode applies (default 10). */
  runwayCriticalDays: number;
}

export const SURVIVAL_DEFAULTS: Readonly<SurvivalOptions> = Object.freeze({
  minTrades: 15,
  recentN: 20,
  hurdleBps: 10,
  promotionDwellDays: 2,
  hibernationExitShadowTrades: 20,
  runwayWarningDays: 20,
  runwayCriticalDays: 10,
});

export interface SurvivalInput {
  scope: TenantScope;
  now: IsoTimestamp;
  settings: Pick<RiskSettings, "maxDrawdownPct" | "maxWeeklyLossPct" | "maxDailyLossPct" | "maxSimultaneousPositions">;
  equity: {
    current: number | null;
    peak: number | null;
    inception: number | null;
    inceptionAt: IsoTimestamp | null;
    lastHighAt: IsoTimestamp | null;
  };
  /** Positive fraction below peak. */
  drawdownPct: number | null;
  dailyPnlPct: number | null;
  weeklyPnlPct: number | null;
  /** Daily account returns (signed fractions), oldest first, most recent last; up to ~30 points. */
  recentDailyReturns: number[];
  live: SurvivalWindow;
  shadow: SurvivalWindow;
  /** Benchmark total return (signed fraction) over the same period as `liveReturnPct`; null when unknown. */
  benchmark: { label: string; returnPct: number | null } | null;
  /** Account total return since inception (signed fraction); null when unknown. */
  liveReturnPct: number | null;
  previous: SurvivalState | null;
  options?: Partial<SurvivalOptions>;
}

export interface SurvivalState {
  scope: TenantScope;
  version: string;
  computedAt: IsoTimestamp;
  mode: SurvivalMode;
  /** When the current mode was entered. */
  modeSince: IsoTimestamp;
  previousMode: SurvivalMode | null;
  /** 0..100 composite of realised expectancy, profit factor, drawdown headroom and alpha. */
  fitnessScore: number;
  /** Multiplier on live position size and on the fast brain's risk capacity (0..1). */
  riskMultiplier: number;
  /** Multiplier on the minimum expected edge (>= 1). */
  minEdgeMultiplier: number;
  /** Net-of-cost hurdle every new entry must clear (bps of notional, round trip). */
  hurdleBps: number;
  /** New positions the account may open per cycle. */
  maxNewPositions: number;
  /** False in hibernation: every entry evaluates in shadow, live capital is untouched. */
  allowLiveEntries: boolean;
  runway: { days: number | null; burnRatePctPerDay: number | null; drawdownHeadroomPct: number | null };
  alpha: { livePct: number | null; benchmarkPct: number | null; alphaPct: number | null; label: string | null };
  evidence: {
    liveTrades: number;
    liveExpectancyPct: number | null;
    liveRecentTrades: number;
    liveRecentExpectancyPct: number | null;
    liveProfitFactor: number | null;
    shadowTrades: number;
    shadowRecentTrades: number;
    shadowRecentExpectancyPct: number | null;
    shadowRecentProfitFactor: number | null;
    sufficient: boolean;
  };
  reasons: string[];
  /** What must be true to move up one rung. */
  hurdles: string[];
  /** One-paragraph mandate for journals, prompts and the dashboard. */
  mandate: string;
}

// ---------------------------------------------------------------------------------------------
// Strategy Darwinism
// ---------------------------------------------------------------------------------------------

export type FitnessVerdict = "scale" | "keep" | "probation" | "cull" | "revive" | "incubating";

export interface StrategyFitnessOptions {
  minTrades: number;
  /** Profit factor below which a strategy with enough evidence is culled (default 0.9). */
  cullProfitFactor: number;
  /** Max drawdown (percent points) above which a strategy is culled (default 15). */
  cullDrawdownPct: number;
  /** Profit factor a shadow record needs to earn revival (default 1.2). */
  reviveProfitFactor: number;
  /** Profit factor above which a working strategy is scaled up (default 1.3). */
  scaleProfitFactor: number;
  /** Max allocation change per assessment (default 0.05). */
  maxStep: number;
  /** Floor for any surviving strategy's allocation (default 0.02). */
  minAllocation: number;
}

export const STRATEGY_FITNESS_DEFAULTS: Readonly<StrategyFitnessOptions> = Object.freeze({
  minTrades: 15,
  cullProfitFactor: 0.9,
  cullDrawdownPct: 15,
  reviveProfitFactor: 1.2,
  scaleProfitFactor: 1.3,
  maxStep: 0.05,
  minAllocation: 0.02,
});

export interface StrategyFitnessInput {
  strategyId: string;
  strategyKey: string;
  /** The user's stage for the strategy. */
  stage: StrategyStage;
  /** Current fraction of deployable capital allocated (0..1). */
  capitalAllocation: number;
  /** Scoped profile over live trades (null when none). */
  live: StrategyIntelligenceProfile | null;
  /** Scoped profile over shadow trades (null when none). */
  shadow: StrategyIntelligenceProfile | null;
  now: IsoTimestamp;
  options?: Partial<StrategyFitnessOptions>;
}

export interface StrategyFitness {
  strategyId: string;
  strategyKey: string;
  stage: StrategyStage;
  /** 0..100. */
  score: number;
  verdict: FitnessVerdict;
  /** Which record the verdict rests on. */
  evidence: "live" | "shadow" | "none";
  trades: number;
  expectancyPct: number | null;
  recentExpectancyPct: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  currentAllocation: number;
  /** Allocation the verdict argues for before Darwinian rebalancing. */
  targetAllocation: number;
  /** Stage the verdict argues for; null = unchanged. Cull => live_shadow (never disabled outright). */
  recommendedStage: StrategyStage | null;
  reasons: string[];
  assessedAt: IsoTimestamp;
}

export interface DarwinianAllocation {
  strategyId: string;
  strategyKey: string;
  verdict: FitnessVerdict;
  current: number;
  /** Fitness-proportional share of the budget among survivors. */
  target: number;
  /** Next value after the per-assessment step cap and the floor. */
  next: number;
  delta: number;
}
