import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_SETTINGS, type GlobalRiskState, type KillSwitchState } from "../types/index.js";
import { evaluate, RISK_ENGINE_VERSION } from "./engine.js";
import type { RiskInput, RiskPortfolioPosition } from "./types.js";

const scope = { userId: "user-a", brokerAccountId: "acct-a" };
// Monday 2026-09-28 10:30 America/New_York (EDT)
const NOW = "2026-09-28T14:30:00Z";

function ks(overrides: Partial<KillSwitchState> = {}): KillSwitchState {
  return { scope, active: false, reasons: [], allowRiskReducingExits: true, triggeredAt: null, triggeredBy: null, note: null, ...overrides };
}

function globalState(overrides: Partial<GlobalRiskState> = {}): GlobalRiskState {
  return {
    liveExecutionDisabled: false,
    forceShadowMode: false,
    pausedUsers: [],
    disabledStrategyIds: [],
    globalKillSwitch: ks({ scope: null }),
    updatedAt: NOW,
    updatedBy: null,
    ...overrides,
  };
}

function pos(symbol: string, sector: string, marketValue: number | null, extra: Partial<RiskPortfolioPosition> = {}): RiskPortfolioPosition {
  return { symbol, assetClass: "equity", sector, beta: 1, quantity: 10, marketValue, correlationToCandidate: 0.1, ...extra };
}

type Deep<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K] };

function merge<T extends object>(base: T, patch: Deep<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && cur !== null && typeof cur === "object" && !Array.isArray(cur)) out[k] = merge(cur as object, v as object);
    else out[k] = v;
  }
  return out as T;
}

function entry(patch: Deep<RiskInput> = {}): RiskInput {
  const base: RiskInput = {
    decisionId: "dec-1",
    candidateId: "cand-1",
    tradeId: null,
    scope,
    now: NOW,
    action: "enter",
    symbol: "NVDA",
    side: "buy",
    quantity: 20,
    price: 100,
    estimatedNotional: 2_000,
    assetClass: "equity",
    sector: "tech",
    mode: "live",
    fractionalAllowed: false,
    candidate: {
      expectedEdge: 0.3,
      confidence: 0.75,
      disagreement: 0.2,
      uncertainty: 0.2,
      expectedDownsidePct: 0.05,
      annualizedVol: 0.4,
      spreadBps: 5,
      adv: 50_000_000,
      liquidityScore: 0.9,
      beta: 1.5,
    },
    dataQuality: { quoteFreshness: "fresh", quoteAgeSeconds: 10, barsFreshness: "fresh", regimeFreshness: "fresh", contradictory: false },
    portfolio: {
      totalValue: 100_000,
      cash: 60_000,
      buyingPower: 60_000,
      positions: [pos("AAPL", "tech", 10_000), pos("XOM", "energy", 10_000), pos("JNJ", "health", 10_000)],
      openOrdersCount: 0,
      currentDrawdownPct: 0.02,
      dailyPnlPct: -0.005,
      weeklyPnlPct: 0.01,
      peakValue: 102_000,
    },
    settings: DEFAULT_RISK_SETTINGS,
    global: globalState(),
    account: {
      identityVerified: true,
      accountMappingVerified: true,
      paused: false,
      brokerStatus: "connected",
      reconciliationOk: true,
      reconciliationAgeSeconds: 60,
      autonomyLevel: "fully_autonomous",
      killSwitch: ks(),
    },
    market: { session: "regular" },
    strategy: { strategyId: "strat-1", enabledForUser: true, globallyDisabled: false, userStage: "live", globalStage: "live", optionsAllowed: false, isEventStrategy: false },
    eventRiskWithinHorizon: false,
  };
  return merge(base, patch);
}

function exit(patch: Deep<RiskInput> = {}): RiskInput {
  return entry(merge({ action: "exit", side: "sell", quantity: 100, tradeId: "trade-1", candidateId: null } as Deep<RiskInput>, patch));
}

function failed(d: ReturnType<typeof evaluate>): string[] {
  return d.checks.filter((c) => !c.passed).map((c) => c.code);
}

describe("RiskEngine: happy path", () => {
  it("approves a clean live entry with every check passing", () => {
    const d = evaluate(entry());
    expect(d.verdict).toBe("approve");
    expect(d.approvedQuantity).toBe(20);
    expect(d.approvedNotional).toBe(2_000);
    expect(d.requestedQuantity).toBe(20);
    expect(d.failedClosed).toBe(false);
    expect(d.requiresApproval).toBe(false);
    expect(d.riskEngineVersion).toBe(RISK_ENGINE_VERSION);
    expect(RISK_ENGINE_VERSION).toBe("risk-1.0.0");
    expect(d.decidedAt).toBe(NOW);
    expect(d.id).toBe("dec-1");
    expect(failed(d)).toEqual([]);
    expect(d.checks.length).toBeGreaterThan(30);
  });

  it("is deterministic", () => {
    expect(evaluate(entry())).toEqual(evaluate(entry()));
  });

  it("includes all documented check codes for an entry", () => {
    const codes = new Set(evaluate(entry()).checks.map((c) => c.code));
    for (const code of [
      "identity_verified", "account_mapping_verified", "kill_switch_global", "kill_switch_account", "live_execution_disabled", "account_paused",
      "user_paused_by_admin", "broker_connected", "reconciliation_ok", "data_freshness", "data_contradictory", "autonomy_level", "trading_hours",
      "market_session", "strategy_enabled", "strategy_globally_disabled", "strategy_stage", "symbol_restricted", "symbol_allowed", "min_confidence",
      "min_expected_edge", "max_spread", "max_volatility", "min_liquidity", "position_size", "capital_deployed", "sector_exposure", "correlated_exposure",
      "portfolio_beta", "max_positions", "max_loss_per_trade", "daily_loss", "weekly_loss", "drawdown", "options_exposure", "buying_power", "event_risk",
      "disagreement", "uncertainty",
    ]) expect(codes.has(code), code).toBe(true);
  });
});

describe("RiskEngine: fail closed", () => {
  it("rejects with failedClosed on a thrown error / garbage input", () => {
    const d = evaluate(null as unknown as RiskInput);
    expect(d.verdict).toBe("reject");
    expect(d.failedClosed).toBe(true);
    expect(d.approvedQuantity).toBe(0);
    expect(d.checks[0]?.code).toBe("engine_error");
  });

  it("fails closed on invalid scope, timestamp, action, quantity, price, mode", () => {
    for (const patch of [
      { scope: { userId: "", brokerAccountId: "" } },
      { now: "not-a-date" },
      { action: "yolo" as unknown as "enter" },
      { quantity: 0 },
      { quantity: null },
      { price: null },
      { price: -1 },
      { mode: "paper" as unknown as "live" },
      { decisionId: "" },
      { symbol: "" },
    ] as Deep<RiskInput>[]) {
      const d = evaluate(entry(patch));
      expect(d.verdict, JSON.stringify(patch)).toBe("reject");
      expect(d.failedClosed, JSON.stringify(patch)).toBe(true);
    }
  });

  it("fails closed when a required object is missing", () => {
    for (const key of ["settings", "global", "account", "portfolio", "candidate", "dataQuality", "strategy", "market"] as const) {
      const input = entry();
      (input as unknown as Record<string, unknown>)[key] = undefined;
      const d = evaluate(input);
      expect(d.verdict, key).toBe("reject");
      expect(d.failedClosed, key).toBe(true);
      expect(d.reasons[0]).toContain(key);
    }
  });

  it("rejects (not failedClosed) when a candidate metric is null: blocking check fails", () => {
    const cases: [Deep<RiskInput>, string][] = [
      [{ candidate: { confidence: null } }, "min_confidence"],
      [{ candidate: { expectedEdge: null } }, "min_expected_edge"],
      [{ candidate: { spreadBps: null } }, "max_spread"],
      [{ candidate: { annualizedVol: null } }, "max_volatility"],
      [{ candidate: { adv: null } }, "min_liquidity"],
      [{ candidate: { disagreement: null } }, "disagreement"],
      [{ candidate: { uncertainty: null } }, "uncertainty"],
      [{ candidate: { expectedDownsidePct: null } }, "max_loss_per_trade"],
      [{ portfolio: { totalValue: null } }, "portfolio_state"],
      [{ portfolio: { buyingPower: null } }, "buying_power"],
      [{ portfolio: { currentDrawdownPct: null } }, "drawdown"],
      [{ portfolio: { dailyPnlPct: null } }, "daily_loss"],
      [{ portfolio: { weeklyPnlPct: null } }, "weekly_loss"],
      [{ dataQuality: { quoteAgeSeconds: null } }, "data_freshness"],
      [{ account: { reconciliationOk: null } }, "reconciliation_ok"],
      [{ account: { reconciliationAgeSeconds: null } }, "reconciliation_ok"],
    ];
    for (const [patch, code] of cases) {
      const d = evaluate(entry(patch));
      expect(d.verdict, code).toBe("reject");
      expect(d.failedClosed, code).toBe(false);
      expect(failed(d), code).toContain(code);
      expect(d.approvedQuantity).toBe(0);
    }
  });

  it("rejects entries when any position has an unknown market value", () => {
    const d = evaluate(entry({ portfolio: { positions: [pos("AAPL", "tech", null)] } }));
    expect(d.verdict).toBe("reject");
    expect(failed(d)).toContain("portfolio_state");
    expect(d.reasons.some((r) => r.includes("AAPL"))).toBe(true);
  });
});

describe("RiskEngine: identity, account, broker, reconciliation", () => {
  it("blocks everything, including exits, when identity or mapping is unverified", () => {
    for (const patch of [{ account: { identityVerified: false } }, { account: { accountMappingVerified: false } }] as Deep<RiskInput>[]) {
      expect(evaluate(entry(patch)).verdict).toBe("reject");
      expect(evaluate(exit(patch)).verdict).toBe("reject");
    }
  });

  it("blocks all live actions when the broker is not connected; shadow does not need a broker", () => {
    for (const status of ["not_connected", "token_expired", "unreliable", "revoked", "error", "connecting"] as const) {
      expect(evaluate(entry({ account: { brokerStatus: status } })).verdict).toBe("reject");
      expect(evaluate(exit({ account: { brokerStatus: status } })).verdict).toBe("reject");
    }
    expect(evaluate(entry({ mode: "shadow", account: { brokerStatus: "not_connected" } })).verdict).toBe("approve");
  });

  it("requires a fresh, successful reconciliation for entries but not for exits", () => {
    expect(failed(evaluate(entry({ account: { reconciliationOk: false } })))).toContain("reconciliation_ok");
    expect(failed(evaluate(entry({ account: { reconciliationAgeSeconds: 16 * 60 } })))).toContain("reconciliation_ok");
    expect(evaluate(entry({ account: { reconciliationAgeSeconds: 14 * 60 } })).verdict).toBe("approve");
    expect(evaluate(entry({ account: { reconciliationAgeSeconds: 16 * 60 }, limits: { maxReconciliationAgeSeconds: 20 * 60 } })).verdict).toBe("approve");
    const ex = evaluate(exit({ account: { reconciliationOk: false } }));
    expect(ex.verdict).toBe("approve");
    expect(ex.reasons.some((r) => r.startsWith("warning reconciliation_ok"))).toBe(true);
  });

  it("paused account / admin-paused user block entries and reprices but allow risk-reducing actions", () => {
    for (const patch of [{ account: { paused: true } }, { global: { pausedUsers: ["user-a"] } }] as Deep<RiskInput>[]) {
      expect(evaluate(entry(patch)).verdict).toBe("reject");
      expect(evaluate(entry(merge({ action: "reprice" } as Deep<RiskInput>, patch))).verdict).toBe("reject");
      expect(evaluate(exit(patch)).verdict).toBe("approve");
      expect(evaluate(exit(merge({ action: "reduce", quantity: 5 } as Deep<RiskInput>, patch))).verdict).toBe("approve");
      expect(evaluate(exit(merge({ action: "cancel" } as Deep<RiskInput>, patch))).verdict).toBe("approve");
    }
    expect(evaluate(entry({ global: { pausedUsers: ["someone-else"] } })).verdict).toBe("approve");
  });
});

describe("RiskEngine: kill switch semantics", () => {
  const active = ks({ active: true, reasons: ["daily_loss_limit"], allowRiskReducingExits: true });

  it("account kill switch blocks entries and reprices", () => {
    expect(evaluate(entry({ account: { killSwitch: active } })).verdict).toBe("reject");
    expect(failed(evaluate(entry({ account: { killSwitch: active } })))).toContain("kill_switch_account");
    expect(evaluate(entry({ action: "add", account: { killSwitch: active } })).verdict).toBe("reject");
    expect(evaluate(entry({ action: "reprice", account: { killSwitch: active } })).verdict).toBe("reject");
  });

  it("global kill switch blocks entries in every mode", () => {
    const g = globalState({ globalKillSwitch: ks({ scope: null, active: true, reasons: ["admin_global"] }) });
    expect(evaluate(entry({ global: g })).verdict).toBe("reject");
    expect(evaluate(entry({ global: g, mode: "shadow" })).verdict).toBe("reject");
    expect(failed(evaluate(entry({ global: g })))).toContain("kill_switch_global");
  });

  it("risk-reducing actions pass an active kill switch when allowRiskReducingExits is set", () => {
    for (const action of ["exit", "reduce", "cancel"] as const) {
      const d = evaluate(exit({ action, quantity: 5, account: { killSwitch: active } }));
      expect(d.verdict, action).toBe("approve");
      expect(d.approvedQuantity, action).toBe(5);
      expect(d.checks.find((c) => c.code === "kill_switch_account")?.severity).toBe("warning");
    }
  });

  it("risk-reducing actions are blocked when allowRiskReducingExits is false", () => {
    const hard = ks({ active: true, reasons: ["manual"], allowRiskReducingExits: false });
    expect(evaluate(exit({ account: { killSwitch: hard } })).verdict).toBe("reject");
    expect(evaluate(exit({ action: "cancel", account: { killSwitch: hard } })).verdict).toBe("reject");
  });

  it("risk-reducing actions under a kill switch still require identity, mapping and broker", () => {
    expect(evaluate(exit({ account: { killSwitch: active, identityVerified: false } })).verdict).toBe("reject");
    expect(evaluate(exit({ account: { killSwitch: active, accountMappingVerified: false } })).verdict).toBe("reject");
    expect(evaluate(exit({ account: { killSwitch: active, brokerStatus: "error" } })).verdict).toBe("reject");
  });

  it("live execution disabled blocks live entries, allows exits, ignored in shadow", () => {
    const g = globalState({ liveExecutionDisabled: true });
    expect(evaluate(entry({ global: g })).verdict).toBe("reject");
    expect(evaluate(exit({ global: g })).verdict).toBe("approve");
    expect(evaluate(entry({ global: g, mode: "shadow", strategy: { userStage: "live_shadow", globalStage: "live" } })).verdict).toBe("approve");
  });

  it("force shadow mode blocks live entries only", () => {
    const g = globalState({ forceShadowMode: true });
    expect(evaluate(entry({ global: g })).verdict).toBe("reject");
    expect(evaluate(exit({ global: g })).verdict).toBe("approve");
    expect(evaluate(entry({ global: g, mode: "shadow" })).verdict).toBe("approve");
  });
});

describe("RiskEngine: autonomy semantics", () => {
  it("research_only and shadow levels block all live actions", () => {
    for (const level of ["research_only", "shadow"] as const) {
      expect(evaluate(entry({ account: { autonomyLevel: level } })).verdict).toBe("reject");
      expect(evaluate(exit({ account: { autonomyLevel: level } })).verdict).toBe("reject");
      expect(evaluate(entry({ mode: "shadow", account: { autonomyLevel: level } })).verdict).toBe("approve");
    }
  });

  it("manual_approval approves but flags requiresApproval", () => {
    const d = evaluate(entry({ account: { autonomyLevel: "manual_approval" } }));
    expect(d.verdict).toBe("approve");
    expect(d.requiresApproval).toBe(true);
    expect(d.reasons.some((r) => r.startsWith("requires_approval"))).toBe(true);
    const ex = evaluate(exit({ account: { autonomyLevel: "manual_approval" } }));
    expect(ex.verdict).toBe("approve");
    expect(ex.requiresApproval).toBe(true);
  });

  it("semi_autonomous requires approval only for entries above the notional threshold", () => {
    const small = evaluate(entry({ account: { autonomyLevel: "semi_autonomous" }, quantity: 10, estimatedNotional: 1_000 }));
    expect(small.verdict).toBe("approve");
    expect(small.requiresApproval).toBe(false);
    const big = evaluate(entry({ account: { autonomyLevel: "semi_autonomous" }, quantity: 30, estimatedNotional: 3_000 }));
    expect(big.verdict).toBe("approve");
    expect(big.requiresApproval).toBe(true);
    const ex = evaluate(exit({ account: { autonomyLevel: "semi_autonomous" }, quantity: 500 }));
    expect(ex.requiresApproval).toBe(false);
  });

  it("requiresApproval is never set on a rejection", () => {
    const d = evaluate(entry({ account: { autonomyLevel: "manual_approval", identityVerified: false } }));
    expect(d.verdict).toBe("reject");
    expect(d.requiresApproval).toBe(false);
  });
});

describe("RiskEngine: trading hours and market session (America/New_York)", () => {
  it("allows entries inside 09:35-15:50 ET on a weekday", () => {
    expect(evaluate(entry({ now: "2026-09-28T13:35:00Z" })).verdict).toBe("approve"); // 09:35 EDT
    expect(evaluate(entry({ now: "2026-09-28T19:50:00Z" })).verdict).toBe("approve"); // 15:50 EDT
  });

  it("blocks entries outside the window (EDT and EST)", () => {
    const early = evaluate(entry({ now: "2026-09-28T13:34:00Z" })); // 09:34 EDT
    expect(early.verdict).toBe("reject");
    expect(failed(early)).toContain("trading_hours");
    expect(evaluate(entry({ now: "2026-09-28T19:51:00Z" })).verdict).toBe("reject"); // 15:51 EDT
    expect(evaluate(entry({ now: "2026-01-15T14:30:00Z" })).verdict).toBe("reject"); // 09:30 EST
    expect(evaluate(entry({ now: "2026-01-15T15:00:00Z" })).verdict).toBe("approve"); // 10:00 EST
  });

  it("blocks entries on weekends even if the session says regular", () => {
    expect(failed(evaluate(entry({ now: "2026-09-26T14:30:00Z" })))).toContain("trading_hours");
  });

  it("respects a custom window and timezone", () => {
    const settings = { ...DEFAULT_RISK_SETTINGS, tradingHours: { start: "08:00", end: "16:00", timezone: "Europe/London", allowExtendedHours: false } };
    expect(evaluate(entry({ settings, now: "2026-09-28T07:30:00Z" })).verdict).toBe("approve"); // 08:30 BST
    expect(evaluate(entry({ settings, now: "2026-09-28T06:30:00Z" })).verdict).toBe("reject"); // 07:30 BST
  });

  it("exits are allowed at any time in a regular session, but nothing trades when the market is closed", () => {
    expect(evaluate(exit({ now: "2026-09-28T13:00:00Z" })).verdict).toBe("approve");
    expect(evaluate(exit({ market: { session: "closed" } })).verdict).toBe("reject");
    expect(evaluate(entry({ market: { session: "closed" } })).verdict).toBe("reject");
    expect(evaluate(exit({ action: "cancel", market: { session: "closed" } })).verdict).toBe("approve");
  });

  it("extended hours only when allowed", () => {
    expect(evaluate(exit({ market: { session: "post" } })).verdict).toBe("reject");
    const settings = { ...DEFAULT_RISK_SETTINGS, tradingHours: { ...DEFAULT_RISK_SETTINGS.tradingHours, allowExtendedHours: true } };
    expect(evaluate(exit({ settings, market: { session: "post" } })).verdict).toBe("approve");
    expect(evaluate(exit({ settings, market: { session: "overnight" } })).verdict).toBe("reject");
  });
});

describe("RiskEngine: strategy and symbol gates", () => {
  it("blocks entries for disabled strategies but allows exits", () => {
    expect(failed(evaluate(entry({ strategy: { enabledForUser: false } })))).toContain("strategy_enabled");
    expect(failed(evaluate(entry({ strategy: { globallyDisabled: true } })))).toContain("strategy_globally_disabled");
    expect(failed(evaluate(entry({ global: { disabledStrategyIds: ["strat-1"] } })))).toContain("strategy_globally_disabled");
    expect(evaluate(exit({ strategy: { enabledForUser: false, globallyDisabled: true } })).verdict).toBe("approve");
  });

  it("stage semantics: live entries need limited_live/live; shadow entries accept live_shadow", () => {
    expect(evaluate(entry({ strategy: { userStage: "limited_live" } })).verdict).toBe("approve");
    for (const stage of ["research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "paused", "retired"] as const) {
      expect(failed(evaluate(entry({ strategy: { userStage: stage } }))), stage).toContain("strategy_stage");
    }
    expect(evaluate(entry({ mode: "shadow", strategy: { userStage: "live_shadow" } })).verdict).toBe("approve");
    expect(failed(evaluate(entry({ mode: "shadow", strategy: { userStage: "walk_forward" } })))).toContain("strategy_stage");
    // user cannot be beyond the global stage
    expect(failed(evaluate(entry({ strategy: { userStage: "live", globalStage: "limited_live" } })))).toContain("strategy_stage");
    expect(failed(evaluate(entry({ strategy: { userStage: "live", globalStage: "live_shadow" } })))).toContain("strategy_stage");
  });

  it("restricted and allowed symbol lists", () => {
    expect(failed(evaluate(entry({ settings: { ...DEFAULT_RISK_SETTINGS, restrictedSymbols: ["nvda"] } })))).toContain("symbol_restricted");
    expect(failed(evaluate(entry({ settings: { ...DEFAULT_RISK_SETTINGS, allowedSymbols: ["AAPL"] } })))).toContain("symbol_allowed");
    expect(evaluate(entry({ settings: { ...DEFAULT_RISK_SETTINGS, allowedSymbols: ["AAPL", "NVDA"] } })).verdict).toBe("approve");
  });
});

describe("RiskEngine: confidence, positive edge and stop consistency", () => {
  it("gates the calibrated signal confidence as configured and vetoes a win probability at or below breakeven", () => {
    const two = { expectedUpsidePct: 0.10, expectedDownsidePct: 0.05 };
    expect(failed(evaluate(entry({ candidate: { ...two, confidence: 0.75, winProbability: 0.36 } })))).not.toContain("positive_edge");
    expect(failed(evaluate(entry({ candidate: { ...two, confidence: 0.75, winProbability: 0.33 } })))).toContain("positive_edge");
    expect(failed(evaluate(entry({ candidate: { ...two, confidence: 0.59, winProbability: 0.36 } })))).toContain("min_confidence");
  });

  it("vetoes a stated downside that does not match the distance to the stop (the MRK case)", () => {
    const stated = { expectedDownsidePct: 0.05, expectedUpsidePct: 0.10 };
    expect(failed(evaluate(entry({ price: 100, candidate: { ...stated, invalidationPrice: 82 } })))).toContain("stop_consistency");
    expect(failed(evaluate(entry({ price: 100, candidate: { ...stated, invalidationPrice: 95 } })))).not.toContain("stop_consistency");
    expect(failed(evaluate(entry({ price: 100, candidate: { ...stated, invalidationPrice: 101 } })))).toContain("stop_consistency");
    expect(failed(evaluate(entry({ price: 100, candidate: { ...stated, invalidationPrice: null } })))).not.toContain("stop_consistency");
  });
});

describe("RiskEngine: candidate quality thresholds", () => {
  it("rejects below minimum confidence / edge and above max spread / vol / below liquidity", () => {
    expect(failed(evaluate(entry({ candidate: { confidence: 0.59 } })))).toContain("min_confidence");
    expect(failed(evaluate(entry({ candidate: { expectedEdge: 0.1 } })))).toContain("min_expected_edge");
    expect(failed(evaluate(entry({ candidate: { spreadBps: 30 } })))).toContain("max_spread");
    expect(failed(evaluate(entry({ candidate: { annualizedVol: 1.0 } })))).toContain("max_volatility");
    expect(failed(evaluate(entry({ candidate: { adv: 500_000 } })))).toContain("min_liquidity");
  });

  it("disagreement: > 0.7 rejects, > 0.5 halves the size", () => {
    expect(failed(evaluate(entry({ candidate: { disagreement: 0.71 } })))).toContain("disagreement");
    const d = evaluate(entry({ candidate: { disagreement: 0.6 } }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(10);
  });

  it("uncertainty: > 0.75 rejects, > 0.5 halves the size", () => {
    expect(failed(evaluate(entry({ candidate: { uncertainty: 0.8 } })))).toContain("uncertainty");
    const d = evaluate(entry({ candidate: { uncertainty: 0.6 } }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(10);
  });

  it("event risk blocks non-event strategies only", () => {
    expect(failed(evaluate(entry({ eventRiskWithinHorizon: true })))).toContain("event_risk");
    const d = evaluate(entry({ eventRiskWithinHorizon: true, strategy: { isEventStrategy: true } }));
    expect(d.verdict).toBe("approve");
    expect(d.checks.find((c) => c.code === "event_risk")?.severity).toBe("warning");
  });
});

describe("RiskEngine: loss limits and drawdown", () => {
  it("drawdown at the limit blocks entries but allows exits", () => {
    const e = evaluate(entry({ portfolio: { currentDrawdownPct: 0.1 } }));
    expect(e.verdict).toBe("reject");
    expect(failed(e)).toContain("drawdown");
    const x = evaluate(exit({ portfolio: { currentDrawdownPct: 0.15 } }));
    expect(x.verdict).toBe("approve");
    expect(x.approvedQuantity).toBe(100);
    expect(x.reasons.some((r) => r.startsWith("warning drawdown"))).toBe(true);
  });

  it("daily / weekly loss limits block entries but allow reduce", () => {
    expect(failed(evaluate(entry({ portfolio: { dailyPnlPct: -0.02 } })))).toContain("daily_loss");
    expect(failed(evaluate(entry({ portfolio: { weeklyPnlPct: -0.06 } })))).toContain("weekly_loss");
    expect(evaluate(entry({ portfolio: { dailyPnlPct: -0.019 } })).verdict).toBe("approve");
    expect(evaluate(exit({ action: "reduce", quantity: 10, portfolio: { dailyPnlPct: -0.05, weeklyPnlPct: -0.1 } })).verdict).toBe("approve");
  });
});

describe("RiskEngine: quantity reduction to fit limits", () => {
  it("reduces to the position-size limit", () => {
    // maxPositionPct 10% of 100k = 10k => 100 shares at $100; request 150.
    const d = evaluate(entry({ quantity: 150, estimatedNotional: 15_000 }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(100);
    expect(d.approvedNotional).toBe(10_000);
    expect(d.maxAllowedQuantity).toBe(100);
    expect(d.reasons.some((r) => r.startsWith("reduced:") && r.includes("position_size"))).toBe(true);
    expect(d.checks.find((c) => c.code === "position_size")?.passed).toBe(false);
    expect(d.checks.find((c) => c.code === "position_size")?.severity).toBe("warning");
  });

  it("takes the tightest of several limits", () => {
    // sector tech already 25k of 100k, limit 30% => 5k room => 50 shares; position limit would allow 100.
    const d = evaluate(entry({ quantity: 90, estimatedNotional: 9_000, portfolio: { positions: [pos("AAPL", "tech", 25_000), pos("XOM", "energy", 5_000)] } }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(50);
    expect(d.reasons.some((r) => r.includes("sector_exposure"))).toBe(true);
  });

  it("reduces for correlated exposure, beta, loss-per-trade, deployed capital and buying power", () => {
    const corr = evaluate(entry({ quantity: 100, estimatedNotional: 10_000, portfolio: { positions: [pos("AMD", "semis", 36_000, { correlationToCandidate: 0.8 })] } }));
    expect(corr.verdict).toBe("reduce");
    expect(corr.approvedQuantity).toBe(40); // 40% - 36% = 4k => 40 shares
    expect(corr.reasons.some((r) => r.includes("correlated_exposure"))).toBe(true);

    const beta = evaluate(entry({ quantity: 100, estimatedNotional: 10_000, candidate: { beta: 3 }, portfolio: { positions: [pos("TSLA", "auto", 50_000, { beta: 2.4 })] } }));
    // beta now 1.2; room (1.3-1.2)*100k/3 = 3333 => 33 shares
    expect(beta.verdict).toBe("reduce");
    expect(beta.approvedQuantity).toBe(33);

    const loss = evaluate(entry({ quantity: 100, estimatedNotional: 10_000, candidate: { expectedDownsidePct: 0.2 } }));
    // budget 1% of 100k = 1000 / (100 * 0.2) = 50 shares
    expect(loss.verdict).toBe("reduce");
    expect(loss.approvedQuantity).toBe(50);

    const deployed = evaluate(entry({ quantity: 60, estimatedNotional: 6_000, portfolio: { positions: [pos("AAPL", "tech", 20_000), pos("XOM", "energy", 20_000), pos("JNJ", "health", 15_000)] } }));
    // 60% cap - 55% = 5k => 50 shares
    expect(deployed.verdict).toBe("reduce");
    expect(deployed.approvedQuantity).toBe(50);

    const bp = evaluate(entry({ quantity: 60, estimatedNotional: 6_000, portfolio: { buyingPower: 4_050 } }));
    expect(bp.verdict).toBe("reduce");
    expect(bp.approvedQuantity).toBe(40);
  });

  it("rejects when the fitted quantity is below 25% of the request or below one share", () => {
    const d = evaluate(entry({ quantity: 500, estimatedNotional: 50_000 }));
    expect(d.verdict).toBe("reject");
    expect(d.approvedQuantity).toBe(0);
    expect(d.reasons.some((r) => r.startsWith("reduced_below_minimum"))).toBe(true);
    const tiny = evaluate(entry({ quantity: 2, price: 12_000, estimatedNotional: 24_000 }));
    expect(tiny.verdict).toBe("reject");
    expect(tiny.reasons.some((r) => r.includes("below 1 share"))).toBe(true);
    const one = evaluate(entry({ quantity: 2, price: 9_000, estimatedNotional: 18_000 }));
    expect(one.verdict).toBe("reduce");
    expect(one.approvedQuantity).toBe(1);
  });

  it("keeps exactly 25% of the request as a reduce", () => {
    const d = evaluate(entry({ quantity: 400, estimatedNotional: 40_000 }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(100);
  });

  it("supports fractional quantities when allowed", () => {
    const d = evaluate(entry({ fractionalAllowed: true, quantity: 10, price: 1_500, estimatedNotional: 15_000 }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBeCloseTo(6.6666, 4);
  });

  it("uses quantity * price when estimatedNotional is missing", () => {
    const d = evaluate(entry({ estimatedNotional: null, quantity: 150 }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(100);
  });

  it("semi_autonomous approval threshold applies to the reduced notional", () => {
    const d = evaluate(entry({ account: { autonomyLevel: "semi_autonomous" }, quantity: 150, estimatedNotional: 15_000 }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedNotional).toBe(10_000);
    expect(d.requiresApproval).toBe(true);
  });
});

describe("RiskEngine: positions, options, adds", () => {
  it("blocks a new position at the max position count but allows adding to an existing one", () => {
    const settings = { ...DEFAULT_RISK_SETTINGS, maxSimultaneousPositions: 3 };
    expect(failed(evaluate(entry({ settings })))).toContain("max_positions");
    const add = evaluate(entry({ settings, action: "add", portfolio: { positions: [pos("NVDA", "tech", 5_000), pos("XOM", "energy", 10_000), pos("JNJ", "health", 10_000)] } }));
    expect(add.verdict).toBe("approve");
    expect(add.approvedQuantity).toBe(20);
  });

  it("add respects the existing position when computing the position cap", () => {
    const d = evaluate(entry({ action: "add", quantity: 80, estimatedNotional: 8_000, portfolio: { positions: [pos("NVDA", "tech", 5_000)] } }));
    expect(d.verdict).toBe("reduce");
    expect(d.approvedQuantity).toBe(50);
  });

  it("options require account and strategy permission and respect the options cap", () => {
    expect(failed(evaluate(entry({ assetClass: "option" })))).toContain("options_exposure");
    const settings = { ...DEFAULT_RISK_SETTINGS, optionsEnabled: true, maxOptionsExposurePct: 0.05 };
    expect(failed(evaluate(entry({ assetClass: "option", settings })))).toContain("options_exposure");
    const ok = evaluate(entry({ assetClass: "option", settings, strategy: { optionsAllowed: true } }));
    expect(ok.verdict).toBe("approve");
    const big = evaluate(entry({ assetClass: "option", settings, strategy: { optionsAllowed: true }, quantity: 80, estimatedNotional: 8_000 }));
    expect(big.verdict).toBe("reduce");
    expect(big.approvedQuantity).toBe(50);
  });

  it("stale, aging or contradictory data blocks entries and reprices; exits proceed with warnings", () => {
    expect(failed(evaluate(entry({ dataQuality: { quoteAgeSeconds: 91 } })))).toContain("data_freshness");
    expect(failed(evaluate(entry({ dataQuality: { quoteFreshness: "stale" } })))).toContain("data_freshness");
    expect(failed(evaluate(entry({ dataQuality: { barsFreshness: "aging" } })))).toContain("data_freshness");
    expect(failed(evaluate(entry({ dataQuality: { regimeFreshness: "unknown" } })))).toContain("data_freshness");
    expect(failed(evaluate(entry({ dataQuality: { contradictory: true } })))).toContain("data_contradictory");
    expect(failed(evaluate(entry({ action: "reprice", dataQuality: { quoteAgeSeconds: 120 } })))).toContain("data_freshness");
    expect(failed(evaluate(entry({ action: "reprice", dataQuality: { contradictory: true } })))).toContain("data_contradictory");
    const x = evaluate(exit({ dataQuality: { quoteAgeSeconds: 600, quoteFreshness: "stale", contradictory: true } }));
    expect(x.verdict).toBe("approve");
    expect(x.checks.filter((c) => c.severity === "warning").map((c) => c.code)).toEqual(expect.arrayContaining(["data_freshness", "data_contradictory"]));
  });

  it("cancel needs no quantity or price", () => {
    const d = evaluate(exit({ action: "cancel", quantity: null, price: null }));
    expect(d.verdict).toBe("approve");
    expect(d.approvedQuantity).toBe(0);
    expect(d.failedClosed).toBe(false);
  });
});
