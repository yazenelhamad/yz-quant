import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_SETTINGS } from "../types/index.js";
import { checkKillSwitchTriggers, type KillSwitchTriggerInput } from "./killSwitch.js";

function healthy(overrides: Partial<KillSwitchTriggerInput> = {}): KillSwitchTriggerInput {
  return {
    settings: DEFAULT_RISK_SETTINGS,
    dailyPnlPct: 0.001,
    weeklyPnlPct: 0.01,
    currentDrawdownPct: 0.02,
    marketDataAgeSeconds: 15,
    brokerConsecutiveFailures: 0,
    reconciliationOk: true,
    positionMismatch: false,
    abnormalAiOutput: false,
    executionFailuresInWindow: 0,
    databaseError: false,
    unexpectedPosition: false,
    vix: 18,
    realizedVol: 0.15,
    ...overrides,
  };
}

describe("checkKillSwitchTriggers", () => {
  it("does not trigger on a healthy state", () => {
    const r = checkKillSwitchTriggers(healthy());
    expect(r.shouldTrigger).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("triggers on each loss limit", () => {
    expect(checkKillSwitchTriggers(healthy({ dailyPnlPct: -0.02 })).reasons).toEqual(["daily_loss_limit"]);
    expect(checkKillSwitchTriggers(healthy({ weeklyPnlPct: -0.05 })).reasons).toEqual(["weekly_loss_limit"]);
    expect(checkKillSwitchTriggers(healthy({ currentDrawdownPct: 0.1 })).reasons).toEqual(["drawdown_limit"]);
    expect(checkKillSwitchTriggers(healthy({ dailyPnlPct: -0.019 })).shouldTrigger).toBe(false);
  });

  it("does not trigger loss switches on unknown P&L (the risk engine fails closed instead)", () => {
    expect(checkKillSwitchTriggers(healthy({ dailyPnlPct: null, weeklyPnlPct: null, currentDrawdownPct: null })).shouldTrigger).toBe(false);
  });

  it("triggers on market data failure (stale or absent)", () => {
    expect(checkKillSwitchTriggers(healthy({ marketDataAgeSeconds: 301 })).reasons).toEqual(["market_data_failure"]);
    expect(checkKillSwitchTriggers(healthy({ marketDataAgeSeconds: null })).reasons).toEqual(["market_data_failure"]);
    expect(checkKillSwitchTriggers(healthy({ marketDataAgeSeconds: 301, marketDataStaleThresholdSeconds: 600 })).shouldTrigger).toBe(false);
  });

  it("triggers on broker unreliability and repeated execution failures at 3", () => {
    expect(checkKillSwitchTriggers(healthy({ brokerConsecutiveFailures: 2 })).shouldTrigger).toBe(false);
    expect(checkKillSwitchTriggers(healthy({ brokerConsecutiveFailures: 3 })).reasons).toEqual(["broker_unreliable"]);
    expect(checkKillSwitchTriggers(healthy({ executionFailuresInWindow: 2 })).shouldTrigger).toBe(false);
    expect(checkKillSwitchTriggers(healthy({ executionFailuresInWindow: 3 })).reasons).toEqual(["repeated_execution_failures"]);
  });

  it("triggers on integrity flags", () => {
    expect(checkKillSwitchTriggers(healthy({ reconciliationOk: false })).reasons).toEqual(["reconciliation_failed"]);
    expect(checkKillSwitchTriggers(healthy({ reconciliationOk: null })).shouldTrigger).toBe(false);
    expect(checkKillSwitchTriggers(healthy({ positionMismatch: true })).reasons).toEqual(["position_mismatch"]);
    expect(checkKillSwitchTriggers(healthy({ abnormalAiOutput: true })).reasons).toEqual(["abnormal_ai_output"]);
    expect(checkKillSwitchTriggers(healthy({ databaseError: true })).reasons).toEqual(["database_error"]);
    expect(checkKillSwitchTriggers(healthy({ unexpectedPosition: true })).reasons).toEqual(["unexpected_position"]);
  });

  it("triggers on emergency volatility via VIX or realised vol", () => {
    expect(checkKillSwitchTriggers(healthy({ vix: 40 })).reasons).toEqual(["emergency_volatility"]);
    expect(checkKillSwitchTriggers(healthy({ vix: null, realizedVol: 0.65 })).reasons).toEqual(["emergency_volatility"]);
    expect(checkKillSwitchTriggers(healthy({ vix: 30, realizedVol: 0.3, vixThreshold: 25 })).reasons).toEqual(["emergency_volatility"]);
    expect(checkKillSwitchTriggers(healthy({ vix: null, realizedVol: null })).shouldTrigger).toBe(false);
  });

  it("collects multiple reasons with details", () => {
    const r = checkKillSwitchTriggers(healthy({ dailyPnlPct: -0.03, databaseError: true, brokerConsecutiveFailures: 5 }));
    expect(r.shouldTrigger).toBe(true);
    expect(r.reasons).toEqual(["daily_loss_limit", "broker_unreliable", "database_error"]);
    expect(r.details.length).toBe(3);
  });
});
