import type { KillSwitchReason, RiskSettings } from "../types/index.js";
import { isFiniteNumber } from "../portfolio/math.js";

export interface KillSwitchTriggerInput {
  settings: RiskSettings;
  /** Signed fractions; null = unknown (does not trigger loss switches by itself). */
  dailyPnlPct: number | null;
  weeklyPnlPct: number | null;
  /** Positive fraction below peak. */
  currentDrawdownPct: number | null;
  /** Age of the newest usable market data; null = no market data at all. */
  marketDataAgeSeconds: number | null;
  /** Default 300s. */
  marketDataStaleThresholdSeconds?: number;
  brokerConsecutiveFailures: number;
  reconciliationOk: boolean | null;
  positionMismatch: boolean;
  abnormalAiOutput: boolean;
  executionFailuresInWindow: number;
  databaseError: boolean;
  unexpectedPosition: boolean;
  vix: number | null;
  /** Default 40. */
  vixThreshold?: number;
  /** Annualised realised vol of the market proxy. */
  realizedVol: number | null;
  /** Default 0.6 (60% annualised). */
  realizedVolThreshold?: number;
  /** Consecutive failures at which the broker is considered unreliable (default 3). */
  brokerFailureThreshold?: number;
  /** Execution failures in the window that trigger (default 3). */
  executionFailureThreshold?: number;
}

export interface KillSwitchTriggerResult {
  shouldTrigger: boolean;
  reasons: KillSwitchReason[];
  details: string[];
}

/** Deterministic evaluation of every automatic kill-switch condition. */
export function checkKillSwitchTriggers(state: KillSwitchTriggerInput): KillSwitchTriggerResult {
  const reasons: KillSwitchReason[] = [];
  const details: string[] = [];
  const s = state.settings;
  const add = (r: KillSwitchReason, d: string) => { reasons.push(r); details.push(d); };

  if (isFiniteNumber(state.dailyPnlPct) && s.maxDailyLossPct > 0 && state.dailyPnlPct <= -s.maxDailyLossPct) {
    add("daily_loss_limit", `daily P&L ${(state.dailyPnlPct * 100).toFixed(2)}% breaches -${(s.maxDailyLossPct * 100).toFixed(2)}%`);
  }
  if (isFiniteNumber(state.weeklyPnlPct) && s.maxWeeklyLossPct > 0 && state.weeklyPnlPct <= -s.maxWeeklyLossPct) {
    add("weekly_loss_limit", `weekly P&L ${(state.weeklyPnlPct * 100).toFixed(2)}% breaches -${(s.maxWeeklyLossPct * 100).toFixed(2)}%`);
  }
  if (isFiniteNumber(state.currentDrawdownPct) && s.maxDrawdownPct > 0 && state.currentDrawdownPct >= s.maxDrawdownPct) {
    add("drawdown_limit", `drawdown ${(state.currentDrawdownPct * 100).toFixed(2)}% reaches ${(s.maxDrawdownPct * 100).toFixed(2)}%`);
  }
  const staleThreshold = state.marketDataStaleThresholdSeconds ?? 300;
  if (!isFiniteNumber(state.marketDataAgeSeconds)) {
    add("market_data_failure", "no market data available");
  } else if (state.marketDataAgeSeconds > staleThreshold) {
    add("market_data_failure", `market data ${state.marketDataAgeSeconds.toFixed(0)}s old exceeds ${staleThreshold}s`);
  }
  const brokerThreshold = state.brokerFailureThreshold ?? 3;
  if (state.brokerConsecutiveFailures >= brokerThreshold) {
    add("broker_unreliable", `${state.brokerConsecutiveFailures} consecutive broker failures (threshold ${brokerThreshold})`);
  }
  if (state.reconciliationOk === false) add("reconciliation_failed", "last reconciliation failed");
  if (state.positionMismatch) add("position_mismatch", "positions differ between broker and ledger");
  if (state.abnormalAiOutput) add("abnormal_ai_output", "abnormal AI output flagged");
  const execThreshold = state.executionFailureThreshold ?? 3;
  if (state.executionFailuresInWindow >= execThreshold) {
    add("repeated_execution_failures", `${state.executionFailuresInWindow} execution failures in window (threshold ${execThreshold})`);
  }
  if (state.databaseError) add("database_error", "database error flagged");
  if (state.unexpectedPosition) add("unexpected_position", "position not attributable to any trade");
  const vixThreshold = state.vixThreshold ?? 40;
  const rvThreshold = state.realizedVolThreshold ?? 0.6;
  if (isFiniteNumber(state.vix) && state.vix >= vixThreshold) {
    add("emergency_volatility", `VIX ${state.vix.toFixed(1)} at or above ${vixThreshold}`);
  } else if (isFiniteNumber(state.realizedVol) && state.realizedVol >= rvThreshold) {
    add("emergency_volatility", `realised vol ${(state.realizedVol * 100).toFixed(0)}% at or above ${(rvThreshold * 100).toFixed(0)}%`);
  }

  return { shouldTrigger: reasons.length > 0, reasons, details };
}
