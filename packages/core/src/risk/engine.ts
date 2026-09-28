import type { RiskCheck, RiskSettings, StrategyStage, TenantScope } from "../types/index.js";
import { requiredWinProbability } from "../strategies/geometry.js";
import { assertScope } from "../types/index.js";
import { clamp, isFiniteNumber } from "../portfolio/math.js";
import { isValidIso } from "../portfolio/time.js";
import { isWithinEntryWindow } from "./tradingHours.js";
import {
  ENTRY_ACTIONS,
  RISK_ACTIONS,
  RISK_REDUCING_ACTIONS,
  type RiskAction,
  type RiskEvaluation,
  type RiskInput,
  type RiskLimits,
} from "./types.js";

export const RISK_ENGINE_VERSION = "risk-1.0.0";

const LIVE_STAGES: ReadonlySet<StrategyStage> = new Set<StrategyStage>(["limited_live", "live"]);
const SHADOW_STAGES: ReadonlySet<StrategyStage> = new Set<StrategyStage>(["live_shadow", "limited_live", "live"]);

const DEFAULT_LIMITS: Required<RiskLimits> = {
  maxQuoteAgeSeconds: 90,
  maxReconciliationAgeSeconds: 15 * 60,
  disagreementReduce: 0.5,
  disagreementReject: 0.7,
  uncertaintyReduce: 0.5,
  uncertaintyReject: 0.75,
  correlatedThreshold: 0.5,
  minReduceFraction: 0.25,
};

class RiskInputError extends Error {
  override readonly name = "RiskInputError";
}

/**
 * Deterministic risk engine with absolute veto. Any thrown error or missing required input
 * produces a rejected decision with `failedClosed = true`; the engine never throws.
 */
export function evaluate(input: RiskInput): RiskEvaluation {
  try {
    return evaluateUnsafe(input);
  } catch (err) {
    return failClosed(input, err);
  }
}

function failClosed(input: RiskInput | null | undefined, err: unknown): RiskEvaluation {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const scope: TenantScope = input && input.scope && typeof input.scope.userId === "string" && typeof input.scope.brokerAccountId === "string"
    ? { userId: input.scope.userId, brokerAccountId: input.scope.brokerAccountId }
    : { userId: "", brokerAccountId: "" };
  const requested = input && isFiniteNumber(input.quantity) ? input.quantity : 0;
  return {
    id: typeof input?.decisionId === "string" ? input.decisionId : "",
    scope,
    candidateId: input?.candidateId ?? null,
    tradeId: input?.tradeId ?? null,
    symbol: typeof input?.symbol === "string" ? input.symbol : "",
    action: typeof input?.action === "string" ? input.action : "",
    verdict: "reject",
    approvedQuantity: 0,
    approvedNotional: 0,
    requestedQuantity: requested,
    checks: [{ code: "engine_error", passed: false, severity: "blocking", detail: message }],
    reasons: [`engine_error: ${message}`],
    riskEngineVersion: RISK_ENGINE_VERSION,
    decidedAt: typeof input?.now === "string" ? input.now : "",
    failedClosed: true,
    requiresApproval: false,
    maxAllowedQuantity: null,
  };
}

function require<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new RiskInputError(`missing required input: ${name}`);
  return value;
}

interface Cap { code: string; maxQuantity: number }

function evaluateUnsafe(input: RiskInput): RiskEvaluation {
  require(input, "input");
  assertScope(input.scope, "RiskEngine.evaluate");
  if (!isValidIso(input.now)) throw new RiskInputError("`now` must be a valid ISO timestamp");
  if (!RISK_ACTIONS.includes(input.action)) throw new RiskInputError(`unknown action ${String(input.action)}`);
  if (typeof input.symbol !== "string" || input.symbol.length === 0) throw new RiskInputError("symbol");
  if (typeof input.decisionId !== "string" || input.decisionId.length === 0) throw new RiskInputError("decisionId");
  if (input.mode !== "live" && input.mode !== "shadow") throw new RiskInputError("mode must be live or shadow");
  const settings = require(input.settings, "settings");
  const global = require(input.global, "global");
  const account = require(input.account, "account");
  const killSwitchAccount = require(account.killSwitch, "account.killSwitch");
  const killSwitchGlobal = require(global.globalKillSwitch, "global.globalKillSwitch");
  const portfolio = require(input.portfolio, "portfolio");
  require(portfolio.positions, "portfolio.positions");
  const candidate = require(input.candidate, "candidate");
  const dq = require(input.dataQuality, "dataQuality");
  const strategy = require(input.strategy, "strategy");
  const market = require(input.market, "market");
  const limits: Required<RiskLimits> = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };

  const action: RiskAction = input.action;
  const isEntry = ENTRY_ACTIONS.has(action);
  const isRiskReducing = RISK_REDUCING_ACTIONS.has(action);
  const isCancel = action === "cancel";
  const isLive = input.mode === "live";

  const requested = isCancel ? (isFiniteNumber(input.quantity) ? input.quantity : 0) : input.quantity;
  if (!isCancel && (!isFiniteNumber(requested) || requested <= 0)) throw new RiskInputError("quantity must be a positive number");
  const quantity = requested as number;
  const price = input.price;
  if (!isCancel && (!isFiniteNumber(price) || price <= 0)) throw new RiskInputError("price must be a positive number");
  const px = isFiniteNumber(price) && price > 0 ? price : 0;
  const notional = isFiniteNumber(input.estimatedNotional) && input.estimatedNotional > 0 ? input.estimatedNotional : quantity * px;

  const checks: RiskCheck[] = [];
  const caps: Cap[] = [];
  let scaleFactor = 1;
  let requiresApproval = false;
  const add = (code: string, passed: boolean, severity: RiskCheck["severity"], detail: string, observed?: number | string | null, limit?: number | string | null): void => {
    const c: RiskCheck = { code, passed, severity, detail };
    if (observed !== undefined) c.observed = observed;
    if (limit !== undefined) c.limit = limit;
    checks.push(c);
  };
  const block = (code: string, detail: string, observed?: number | string | null, limit?: number | string | null) => add(code, false, "blocking", detail, observed, limit);
  const pass = (code: string, detail: string, observed?: number | string | null, limit?: number | string | null) => add(code, true, "info", detail, observed, limit);
  const warn = (code: string, detail: string, observed?: number | string | null, limit?: number | string | null) => add(code, true, "warning", detail, observed, limit);
  const cap = (code: string, maxQuantity: number, detail: string, observed?: number | string | null, limit?: number | string | null) => {
    const mq = Math.max(0, Number.isFinite(maxQuantity) ? maxQuantity : 0);
    caps.push({ code, maxQuantity: mq });
    if (mq >= quantity) pass(code, detail, observed, limit);
    else add(code, false, "warning", `${detail}; max ${fmtQty(mq)} of ${fmtQty(quantity)} requested`, observed, limit);
  };

  // ---- Gate checks (every action) --------------------------------------------------------------
  if (account.identityVerified === true) pass("identity_verified", "user identity verified");
  else block("identity_verified", "user identity not verified");
  if (account.accountMappingVerified === true) pass("account_mapping_verified", "broker account mapping verified for this user");
  else block("account_mapping_verified", "broker account mapping not verified");

  if (!isLive) pass("broker_connected", "shadow mode: broker connection not required", account.brokerStatus);
  else if (account.brokerStatus === "connected") pass("broker_connected", "broker connected", account.brokerStatus);
  else block("broker_connected", `broker status ${account.brokerStatus}`, account.brokerStatus, "connected");

  // ---- Kill switches -------------------------------------------------------------------------
  for (const [code, ks] of [["kill_switch_global", killSwitchGlobal], ["kill_switch_account", killSwitchAccount]] as const) {
    if (!ks.active) { pass(code, "inactive"); continue; }
    const reasons = ks.reasons.join(",") || "unspecified";
    if (isRiskReducing && ks.allowRiskReducingExits) warn(code, `active (${reasons}); risk-reducing ${action} allowed`, reasons);
    else block(code, `active (${reasons}); ${action} blocked`, reasons);
  }

  if (!isLive) pass("live_execution_disabled", "shadow mode");
  else if (!global.liveExecutionDisabled) pass("live_execution_disabled", "live execution enabled");
  else if (isRiskReducing) warn("live_execution_disabled", `live execution disabled globally; risk-reducing ${action} allowed`);
  else block("live_execution_disabled", "live execution disabled globally");

  if (isLive && global.forceShadowMode && isEntry) block("force_shadow_mode", "global force-shadow mode: no live entries");
  else pass("force_shadow_mode", global.forceShadowMode ? "force-shadow active; non-entry action" : "inactive");

  const pausedByAdmin = Array.isArray(global.pausedUsers) && global.pausedUsers.includes(input.scope.userId);
  for (const [code, paused, label] of [["account_paused", account.paused, "account paused"], ["user_paused_by_admin", pausedByAdmin, "user paused by admin"]] as const) {
    if (!paused) pass(code, "not paused");
    else if (isRiskReducing) warn(code, `${label}; risk-reducing ${action} allowed`);
    else block(code, `${label}; ${action} blocked`);
  }

  // ---- Reconciliation ------------------------------------------------------------------------
  {
    const ok = account.reconciliationOk === true;
    const age = account.reconciliationAgeSeconds;
    const fresh = isFiniteNumber(age) && age >= 0 && age <= limits.maxReconciliationAgeSeconds;
    if (!isLive) pass("reconciliation_ok", "shadow mode: reconciliation not required");
    else if (ok && fresh) pass("reconciliation_ok", `reconciled ${age.toFixed(0)}s ago`, age, limits.maxReconciliationAgeSeconds);
    else if (isRiskReducing) warn("reconciliation_ok", `reconciliation ${ok ? "stale or age unknown" : "not ok"}; risk-reducing ${action} allowed`, age, limits.maxReconciliationAgeSeconds);
    else block("reconciliation_ok", ok ? `reconciliation age ${age === null ? "unknown" : `${age.toFixed(0)}s`} exceeds ${limits.maxReconciliationAgeSeconds}s` : `reconciliation ${account.reconciliationOk === null ? "never run" : "failed"}`, age, limits.maxReconciliationAgeSeconds);
  }

  // ---- Data quality --------------------------------------------------------------------------
  {
    const age = dq.quoteAgeSeconds;
    const quoteOk = isFiniteNumber(age) && age >= 0 && age <= limits.maxQuoteAgeSeconds && (dq.quoteFreshness === "fresh" || dq.quoteFreshness === "aging");
    const barsOk = dq.barsFreshness === "fresh";
    const regimeOk = dq.regimeFreshness === "fresh";
    const detail = `quote ${dq.quoteFreshness}${age === null ? " (age unknown)" : ` ${age.toFixed(0)}s`}, bars ${dq.barsFreshness}, regime ${dq.regimeFreshness}`;
    if (isEntry) {
      if (quoteOk && barsOk && regimeOk) pass("data_freshness", detail, age, limits.maxQuoteAgeSeconds);
      else block("data_freshness", `${detail}; entries require quote <= ${limits.maxQuoteAgeSeconds}s and fresh bars/regime`, age, limits.maxQuoteAgeSeconds);
    } else if (action === "reprice") {
      if (quoteOk) pass("data_freshness", detail, age, limits.maxQuoteAgeSeconds);
      else block("data_freshness", `${detail}; repricing requires a quote <= ${limits.maxQuoteAgeSeconds}s`, age, limits.maxQuoteAgeSeconds);
    } else if (isCancel) {
      pass("data_freshness", "cancel does not depend on market data");
    } else if (quoteOk) pass("data_freshness", detail, age);
    else warn("data_freshness", `${detail}; risk-reducing ${action} allowed on stale data`, age);

    if (!dq.contradictory) pass("data_contradictory", "sources agree");
    else if (isRiskReducing) warn("data_contradictory", `sources contradict; risk-reducing ${action} allowed`);
    else block("data_contradictory", "independent data sources contradict each other");
  }

  // ---- Autonomy ------------------------------------------------------------------------------
  {
    const level = account.autonomyLevel;
    if (!isLive) pass("autonomy_level", `shadow mode (${level})`, level);
    else if (level === "research_only" || level === "shadow") block("autonomy_level", `${level}: no live orders`, level);
    else if (level === "manual_approval") { requiresApproval = true; warn("autonomy_level", "manual_approval: human confirmation required", level); }
    else if (level === "semi_autonomous") pass("autonomy_level", `semi_autonomous: entries above ${settings.semiAutoApprovalNotional} require approval`, level, settings.semiAutoApprovalNotional);
    else pass("autonomy_level", "fully_autonomous", level);
  }

  // ---- Session and trading hours -------------------------------------------------------------
  {
    const s = market.session;
    const extendedOk = settings.tradingHours.allowExtendedHours && (s === "pre" || s === "post");
    if (isCancel) pass("market_session", `cancel allowed in any session (${s})`, s);
    else if (s === "regular" || extendedOk) pass("market_session", `session ${s}`, s);
    else block("market_session", `session ${s}: orders not accepted${s === "pre" || s === "post" ? " (extended hours disabled)" : ""}`, s, "regular");

    if (isEntry) {
      const w = isWithinEntryWindow(input.now, settings.tradingHours);
      if (w.inside) pass("trading_hours", w.reason, w.localTime, `${settings.tradingHours.start}-${settings.tradingHours.end}`);
      else block("trading_hours", `entries only inside the configured window: ${w.reason}`, w.localTime, `${settings.tradingHours.start}-${settings.tradingHours.end}`);
    } else {
      pass("trading_hours", `${action} allowed outside the entry window`);
    }
  }

  // ---- Strategy status (entries only; exits of existing positions never depend on it) -------
  if (isEntry) {
    if (strategy.enabledForUser) pass("strategy_enabled", "enabled for user"); else block("strategy_enabled", "strategy not enabled for this user");
    const globallyDisabled = strategy.globallyDisabled || (Array.isArray(global.disabledStrategyIds) && global.disabledStrategyIds.includes(strategy.strategyId));
    if (!globallyDisabled) pass("strategy_globally_disabled", "strategy globally enabled"); else block("strategy_globally_disabled", "strategy disabled globally");
    const allowed = isLive ? LIVE_STAGES : SHADOW_STAGES;
    const stageOk = allowed.has(strategy.userStage) && allowed.has(strategy.globalStage) && stageRank(strategy.userStage) <= stageRank(strategy.globalStage);
    if (stageOk) pass("strategy_stage", `user stage ${strategy.userStage}, global ${strategy.globalStage}`, strategy.userStage);
    else block("strategy_stage", `${input.mode} entries require ${[...allowed].join("/")}; user stage ${strategy.userStage}, global ${strategy.globalStage}`, strategy.userStage, [...allowed].join("/"));

    const sym = input.symbol.toUpperCase();
    if (settings.restrictedSymbols.some((x) => x.toUpperCase() === sym)) block("symbol_restricted", `${sym} is on the restricted list`, sym);
    else pass("symbol_restricted", "not restricted");
    if (settings.allowedSymbols === null) pass("symbol_allowed", "no allow-list configured");
    else if (settings.allowedSymbols.some((x) => x.toUpperCase() === sym)) pass("symbol_allowed", `${sym} on allow-list`);
    else block("symbol_allowed", `${sym} not on the allow-list`, sym);
  } else {
    for (const code of ["strategy_enabled", "strategy_globally_disabled", "strategy_stage", "symbol_restricted", "symbol_allowed"]) pass(code, `not applicable to ${action}`);
  }

  // ---- Candidate quality (entries only) ------------------------------------------------------
  if (isEntry) {
    // The confidence floor is payoff-aware: a 2:1 target/stop breaks even at a 33% win rate, a 1:1
    // one at 50%. The setting is read at even payoff (0.6 = 20% above breakeven) and scaled with
    // the breakeven of the actual geometry, so the same setting means the same edge at any payoff.
    const req = requiredWinProbability(settings.minConfidence, candidate.expectedUpsidePct, candidate.expectedDownsidePct);
    if (req.breakeven === null) threshold("min_confidence", candidate.confidence, req.required, ">=", "calibrated win probability (payoff unknown: even-payoff floor)");
    else threshold("min_confidence", candidate.confidence, req.required, ">=", `calibrated win probability (breakeven ${req.breakeven.toFixed(2)} at ${((candidate.expectedUpsidePct as number) / (candidate.expectedDownsidePct as number)).toFixed(2)}:1 × ${(settings.minConfidence / 0.5).toFixed(2)})`);
    // The stated downside must be the distance to the actual stop from the entry price: a thesis
    // that claims -5% while its stop sits 18% away would be sized at a third of its real risk.
    const entryPx = isFiniteNumber(input.price) && input.price > 0 ? input.price : null;
    if (isFiniteNumber(candidate.invalidationPrice) && entryPx !== null) {
      const actual = (entryPx - candidate.invalidationPrice) / entryPx;
      const stated = candidate.expectedDownsidePct;
      if (actual <= 0) block("stop_consistency", `stop ${candidate.invalidationPrice.toFixed(2)} is at or above the entry price ${entryPx.toFixed(2)}`, actual, 0);
      else if (!isFiniteNumber(stated) || stated <= 0) block("stop_consistency", "stated downside unavailable while a stop level exists (fail closed)", actual, null);
      else if (Math.abs(actual - stated) > Math.max(0.25 * stated, 0.005)) block("stop_consistency", `stated downside ${pct(stated)} but the stop at ${candidate.invalidationPrice.toFixed(2)} is ${pct(actual)} from entry ${entryPx.toFixed(2)}`, actual, stated);
      else pass("stop_consistency", `stop ${candidate.invalidationPrice.toFixed(2)} is ${pct(actual)} from entry, stated ${pct(stated)}`, actual, stated);
    } else pass("stop_consistency", "no stop level supplied; stated downside used as is");
    threshold("min_expected_edge", candidate.expectedEdge, settings.minExpectedEdge, ">=", "expected edge");
    threshold("max_spread", candidate.spreadBps, settings.maxSpreadBps, "<=", "spread (bps)");
    threshold("max_volatility", candidate.annualizedVol, settings.maxAnnualizedVolatility, "<=", "annualised volatility");
    threshold("min_liquidity", candidate.adv, settings.minLiquidityAdv, ">=", "average dollar volume");

    if (!isFiniteNumber(candidate.disagreement)) block("disagreement", "model disagreement unavailable (fail closed)", null, limits.disagreementReject);
    else if (candidate.disagreement > limits.disagreementReject) block("disagreement", `disagreement ${candidate.disagreement.toFixed(2)} above ${limits.disagreementReject}`, candidate.disagreement, limits.disagreementReject);
    else if (candidate.disagreement > limits.disagreementReduce) { scaleFactor *= 0.5; warn("disagreement", `disagreement ${candidate.disagreement.toFixed(2)} above ${limits.disagreementReduce}; size halved`, candidate.disagreement, limits.disagreementReduce); }
    else pass("disagreement", `disagreement ${candidate.disagreement.toFixed(2)}`, candidate.disagreement, limits.disagreementReduce);

    if (!isFiniteNumber(candidate.uncertainty)) block("uncertainty", "uncertainty unavailable (fail closed)", null, limits.uncertaintyReject);
    else if (candidate.uncertainty > limits.uncertaintyReject) block("uncertainty", `uncertainty ${candidate.uncertainty.toFixed(2)} above ${limits.uncertaintyReject}`, candidate.uncertainty, limits.uncertaintyReject);
    else if (candidate.uncertainty > limits.uncertaintyReduce) { scaleFactor *= 0.5; warn("uncertainty", `uncertainty ${candidate.uncertainty.toFixed(2)} above ${limits.uncertaintyReduce}; size halved`, candidate.uncertainty, limits.uncertaintyReduce); }
    else pass("uncertainty", `uncertainty ${candidate.uncertainty.toFixed(2)}`, candidate.uncertainty, limits.uncertaintyReduce);

    if (!input.eventRiskWithinHorizon) pass("event_risk", "no scheduled event inside the horizon");
    else if (strategy.isEventStrategy) warn("event_risk", "scheduled event inside horizon; allowed for event strategy");
    else block("event_risk", "scheduled event (earnings) inside the holding horizon");
  }

  // ---- Loss limits (entries blocked; exits allowed) ------------------------------------------
  {
    const dd = portfolio.currentDrawdownPct;
    const daily = portfolio.dailyPnlPct;
    const weekly = portfolio.weeklyPnlPct;
    const lossChecks: [string, number | null, number, boolean, string][] = [
      ["daily_loss", daily, settings.maxDailyLossPct, isFiniteNumber(daily) && daily <= -settings.maxDailyLossPct, "daily P&L"],
      ["weekly_loss", weekly, settings.maxWeeklyLossPct, isFiniteNumber(weekly) && weekly <= -settings.maxWeeklyLossPct, "weekly P&L"],
      ["drawdown", dd, settings.maxDrawdownPct, isFiniteNumber(dd) && dd >= settings.maxDrawdownPct, "drawdown"],
    ];
    for (const [code, value, limit, breached, label] of lossChecks) {
      const observed = isFiniteNumber(value) ? value : null;
      if (!isEntry) {
        if (breached) warn(code, `${label} limit breached; ${action} allowed`, observed, limit);
        else pass(code, `${label} ${observed === null ? "unknown" : pct(observed)}; not an entry`, observed, limit);
      } else if (observed === null) block(code, `${label} unknown (fail closed)`, null, limit);
      else if (breached) block(code, `${label} ${pct(observed)} breaches limit ${pct(limit)}`, observed, limit);
      else pass(code, `${label} ${pct(observed)} within ${pct(limit)}`, observed, limit);
    }
  }

  // ---- Portfolio limits (entries only) -------------------------------------------------------
  if (isEntry) {
    const tv = portfolio.totalValue;
    const unknownPositions = portfolio.positions.filter((p) => !isFiniteNumber(p.marketValue)).map((p) => p.symbol);
    if (!isFiniteNumber(tv) || tv <= 0) block("portfolio_state", "total portfolio value unknown or non-positive (fail closed)", tv ?? null);
    else if (unknownPositions.length > 0) block("portfolio_state", `market value unknown for ${unknownPositions.join(", ")} (fail closed)`, unknownPositions.join(","));
    else {
      pass("portfolio_state", `portfolio value ${tv.toFixed(0)}, ${portfolio.positions.length} positions`, tv);
      const positions = portfolio.positions.map((p) => ({ ...p, marketValue: p.marketValue as number }));
      const sym = input.symbol.toUpperCase();
      const existing = positions.filter((p) => p.symbol.toUpperCase() === sym);
      const existingValue = existing.reduce((s, p) => s + Math.abs(p.marketValue), 0);
      const deployed = positions.reduce((s, p) => s + Math.abs(p.marketValue), 0);
      const sector = input.sector ?? "unknown";
      const sectorValue = positions.filter((p) => (p.sector ?? "unknown") === sector && p.symbol.toUpperCase() !== sym).reduce((s, p) => s + Math.abs(p.marketValue), 0);
      const correlatedValue = positions
        .filter((p) => p.symbol.toUpperCase() !== sym && isFiniteNumber(p.correlationToCandidate) && Math.abs(p.correlationToCandidate) >= limits.correlatedThreshold)
        .reduce((s, p) => s + Math.abs(p.marketValue), 0);
      const optionsValue = positions.filter((p) => p.assetClass === "option").reduce((s, p) => s + Math.abs(p.marketValue), 0);

      const qtyFor = (room: number) => (px > 0 ? room / px : 0);
      cap("position_size", qtyFor(settings.maxPositionPct * tv - existingValue), `position after ${pct((existingValue + notional) / tv)} vs limit ${pct(settings.maxPositionPct)}`, (existingValue + notional) / tv, settings.maxPositionPct);
      cap("capital_deployed", qtyFor(settings.maxCapitalDeployedPct * tv - deployed), `deployed after ${pct((deployed + notional) / tv)} vs limit ${pct(settings.maxCapitalDeployedPct)}`, (deployed + notional) / tv, settings.maxCapitalDeployedPct);
      cap("sector_exposure", qtyFor(settings.maxSectorPct * tv - sectorValue - existingValue), `sector ${sector} after ${pct((sectorValue + existingValue + notional) / tv)} vs limit ${pct(settings.maxSectorPct)}`, (sectorValue + existingValue + notional) / tv, settings.maxSectorPct);
      cap("correlated_exposure", qtyFor(settings.maxCorrelatedExposurePct * tv - correlatedValue - existingValue), `correlated exposure (|corr| >= ${limits.correlatedThreshold}) after ${pct((correlatedValue + existingValue + notional) / tv)} vs limit ${pct(settings.maxCorrelatedExposurePct)}`, (correlatedValue + existingValue + notional) / tv, settings.maxCorrelatedExposurePct);

      {
        const missingBeta = positions.filter((p) => !isFiniteNumber(p.beta)).map((p) => p.symbol);
        const candBeta = isFiniteNumber(candidate.beta) ? candidate.beta : 1;
        const betaNow = positions.reduce((s, p) => s + (isFiniteNumber(p.beta) ? p.beta : 1) * p.marketValue, 0) / tv;
        const betaAfter = betaNow + (candBeta * notional) / tv;
        const room = candBeta > 0 ? ((settings.maxPortfolioBeta - betaNow) * tv) / candBeta : Infinity;
        const note = `${missingBeta.length > 0 ? `beta assumed 1.0 for ${missingBeta.join(", ")}; ` : ""}${!isFiniteNumber(candidate.beta) ? "candidate beta assumed 1.0; " : ""}`;
        cap("portfolio_beta", qtyFor(room), `${note}beta after ${betaAfter.toFixed(2)} vs limit ${settings.maxPortfolioBeta.toFixed(2)}`, betaAfter, settings.maxPortfolioBeta);
      }

      const distinct = new Set(positions.map((p) => p.symbol.toUpperCase())).size;
      if (existing.length > 0) pass("max_positions", `adding to existing ${sym}; ${distinct} positions`, distinct, settings.maxSimultaneousPositions);
      else if (distinct < settings.maxSimultaneousPositions) pass("max_positions", `${distinct} of ${settings.maxSimultaneousPositions} positions used`, distinct, settings.maxSimultaneousPositions);
      else block("max_positions", `${distinct} positions already held; limit ${settings.maxSimultaneousPositions}`, distinct, settings.maxSimultaneousPositions);

      if (!isFiniteNumber(candidate.expectedDownsidePct) || candidate.expectedDownsidePct <= 0) block("max_loss_per_trade", "expected downside unavailable (fail closed)", null, settings.maxLossPerTradePct);
      else {
        const maxLoss = settings.maxLossPerTradePct * tv;
        const expectedLoss = notional * candidate.expectedDownsidePct;
        cap("max_loss_per_trade", px > 0 ? maxLoss / (px * candidate.expectedDownsidePct) : 0, `expected loss ${expectedLoss.toFixed(0)} (${pct(candidate.expectedDownsidePct)} of ${notional.toFixed(0)}) vs budget ${maxLoss.toFixed(0)}`, expectedLoss / tv, settings.maxLossPerTradePct);
      }

      if (input.side === "buy") {
        if (!isFiniteNumber(portfolio.buyingPower)) block("buying_power", "buying power unknown (fail closed)", null, notional);
        else cap("buying_power", qtyFor(portfolio.buyingPower), `buying power ${portfolio.buyingPower.toFixed(0)} vs notional ${notional.toFixed(0)}`, portfolio.buyingPower, notional);
      } else pass("buying_power", "sell side");

      if (input.assetClass === "option") {
        if (!settings.optionsEnabled) block("options_exposure", "options disabled in account risk settings");
        else if (!strategy.optionsAllowed) block("options_exposure", "options not allowed for this strategy");
        else cap("options_exposure", qtyFor(settings.maxOptionsExposurePct * tv - optionsValue), `options exposure after ${pct((optionsValue + notional) / tv)} vs limit ${pct(settings.maxOptionsExposurePct)}`, (optionsValue + notional) / tv, settings.maxOptionsExposurePct);
      } else pass("options_exposure", "not an option");
    }
  }

  // ---- Verdict ------------------------------------------------------------------------------
  const blocking = checks.filter((c) => !c.passed && c.severity === "blocking");
  const reasons: string[] = blocking.map((c) => `${c.code}: ${c.detail}`);
  let verdict: RiskEvaluation["verdict"];
  let approvedQuantity = 0;
  let maxAllowedQuantity: number | null = null;

  if (blocking.length > 0) {
    verdict = "reject";
  } else if (isEntry) {
    const capMin = caps.reduce((m, c) => Math.min(m, c.maxQuantity), Infinity);
    const allowedRaw = Math.min(quantity * scaleFactor, capMin);
    const allowed = roundQuantity(allowedRaw, input.fractionalAllowed === true);
    maxAllowedQuantity = allowed;
    const minQty = input.fractionalAllowed === true ? 0.0001 : 1;
    if (allowed >= quantity) {
      verdict = "approve";
      approvedQuantity = quantity;
    } else if (allowed < minQty || allowed < quantity * limits.minReduceFraction) {
      verdict = "reject";
      const binding = caps.filter((c) => c.maxQuantity <= allowedRaw + 1e-9).map((c) => c.code);
      reasons.push(`reduced_below_minimum: limits allow ${fmtQty(allowed)} of ${fmtQty(quantity)} requested (${binding.length > 0 ? binding.join(", ") : "candidate quality scaling"}); below ${input.fractionalAllowed ? "0.0001" : "1 share"} or ${pct(limits.minReduceFraction)} of the request`);
    } else {
      verdict = "reduce";
      approvedQuantity = allowed;
      const binding = caps.filter((c) => c.maxQuantity <= allowedRaw + 1e-9).map((c) => c.code);
      reasons.push(`reduced: quantity cut from ${fmtQty(quantity)} to ${fmtQty(allowed)} to fit ${binding.length > 0 ? binding.join(", ") : "candidate quality scaling"}${scaleFactor < 1 ? ` (quality scale x${scaleFactor})` : ""}`);
    }
  } else {
    verdict = "approve";
    approvedQuantity = quantity;
  }

  const approvedNotional = Number((approvedQuantity * px).toFixed(2));
  if (verdict !== "reject" && isLive && isEntry && account.autonomyLevel === "semi_autonomous" && approvedNotional > settings.semiAutoApprovalNotional) {
    requiresApproval = true;
    reasons.push(`requires_approval: semi_autonomous entry notional ${approvedNotional.toFixed(0)} exceeds ${settings.semiAutoApprovalNotional}`);
  } else if (verdict !== "reject" && requiresApproval) {
    reasons.push("requires_approval: manual_approval autonomy level");
  }
  if (verdict === "reject") requiresApproval = false;
  for (const c of checks) if (c.passed && c.severity === "warning") reasons.push(`warning ${c.code}: ${c.detail}`);

  return {
    id: input.decisionId,
    scope: input.scope,
    candidateId: input.candidateId ?? null,
    tradeId: input.tradeId ?? null,
    symbol: input.symbol,
    action,
    verdict,
    approvedQuantity,
    approvedNotional,
    requestedQuantity: quantity,
    checks,
    reasons,
    riskEngineVersion: RISK_ENGINE_VERSION,
    decidedAt: input.now,
    failedClosed: false,
    requiresApproval,
    maxAllowedQuantity,
  };

  function threshold(code: string, value: number | null, limit: number, op: ">=" | "<=", label: string): void {
    if (!isFiniteNumber(value)) { block(code, `${label} unavailable (fail closed)`, null, limit); return; }
    const ok = op === ">=" ? value >= limit : value <= limit;
    if (ok) pass(code, `${label} ${fmt(value)} ${op} ${fmt(limit)}`, value, limit);
    else block(code, `${label} ${fmt(value)} fails ${op} ${fmt(limit)}`, value, limit);
  }
}

function stageRank(stage: StrategyStage): number {
  const order: StrategyStage[] = ["research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live", "live"];
  const i = order.indexOf(stage);
  return i < 0 ? -1 : i;
}

function roundQuantity(q: number, fractional: boolean): number {
  if (!Number.isFinite(q) || q <= 0) return 0;
  return fractional ? Math.floor(q * 1e4) / 1e4 : Math.floor(q + 1e-9);
}

function pct(v: number): string {
  return `${(clamp(v, -1e6, 1e6) * 100).toFixed(2)}%`;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtQty(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(4);
}

