import type { IsoTimestamp, OrderType, RiskSettings, TenantScope } from "../types/index.js";
import { assertScope } from "../types/index.js";
import { clamp, isFiniteNumber } from "../portfolio/math.js";
import { isValidIso } from "../portfolio/time.js";
import { blendedWinProbability, cappedKelly, payoffFromExpectations, type KellyEstimate } from "./kelly.js";

export const SIZING_ENGINE_VERSION = "sizing-1.0.0";

export interface SizingCandidateInput {
  /** Calibrated probability of a positive outcome, 0..1. Required. */
  confidence: number | null;
  expectedEdge: number | null;
  expectedUpsidePct: number | null;
  /** Expected adverse move (positive fraction, e.g. 0.05). Required. */
  expectedDownsidePct: number | null;
  regimeFit: number | null;
  liquidityScore: number | null;
  annualizedVol: number | null;
  /** ATR as a fraction of price (e.g. 0.03). */
  atrPct: number | null;
  /** Average daily dollar volume. Required (liquidity cap). */
  adv: number | null;
  correlationToPortfolio: number | null;
  uncertainty: number | null;
}

export interface SizingPortfolioInput {
  currentDrawdownPct: number | null;
  /** Notional already held in this symbol. */
  existingPositionNotional: number;
  /** Fraction of equity currently deployed (0..1). */
  deployedPct: number;
  /** Multiplier from the portfolio engine (0..1). */
  sizeMultiplier: number;
}

export interface SizingPerformanceInput {
  winRate: number | null;
  /** Average win / average loss. */
  payoffRatio: number | null;
  trades: number;
}

export interface SizingInput {
  scope: TenantScope;
  now: IsoTimestamp;
  symbol: string;
  price: number | null;
  totalValue: number | null;
  buyingPower: number | null;
  settings: RiskSettings;
  /** Per-strategy override of the position cap (fraction of equity); null = none. */
  strategyMaxPositionPct: number | null;
  /** Per-strategy override of the loss-per-trade cap; null = none. */
  strategyMaxLossPerTradePct: number | null;
  /** Fraction of deployable capital allocated to the strategy; null = unrestricted. */
  capitalAllocation: number | null;
  candidate: SizingCandidateInput;
  portfolio: SizingPortfolioInput;
  strategyPerformance: SizingPerformanceInput | null;
  regimePerformance: SizingPerformanceInput | null;
  fractionalAllowed: boolean;
  orderType: OrderType;
  /** Max fraction of ADV per order (default 0.01). */
  maxAdvParticipation?: number;
}

export interface SizingConstraint {
  name: string;
  maxNotional: number;
  detail: string;
}

export interface SizingResult {
  scope: TenantScope;
  symbol: string;
  engineVersion: string;
  quantity: number;
  notional: number;
  /** Notional as a fraction of total equity. */
  fractionOfEquity: number;
  /** Which constraint bound the final size. */
  bindingConstraint: string;
  constraints: SizingConstraint[];
  kelly: KellyEstimate | null;
  /** Product of all scaling multipliers applied to the Kelly target. */
  scalingMultiplier: number;
  rationale: string[];
  decidedAt: IsoTimestamp;
}

const DAILY_VOL_SCALE = Math.sqrt(252);

function zero(input: SizingInput, reason: string, constraints: SizingConstraint[] = [], kelly: KellyEstimate | null = null): SizingResult {
  return {
    scope: input.scope,
    symbol: input.symbol,
    engineVersion: SIZING_ENGINE_VERSION,
    quantity: 0,
    notional: 0,
    fractionOfEquity: 0,
    bindingConstraint: reason,
    constraints,
    kelly,
    scalingMultiplier: 0,
    rationale: [reason],
    decidedAt: input.now,
  };
}

/**
 * Risk-adjusted position sizing. Deterministic. Missing required inputs produce a zero size
 * with a reason rather than a guess.
 */
export function computeSize(input: SizingInput): SizingResult {
  assertScope(input.scope, "SizingEngine.computeSize");
  if (!isValidIso(input.now)) throw new Error("SizingEngine.computeSize: `now` must be a valid ISO timestamp");
  const { settings, candidate: c, portfolio: p } = input;
  const rationale: string[] = [];

  if (!isFiniteNumber(input.price) || input.price <= 0) return zero(input, "invalid_price: price missing or non-positive");
  if (!isFiniteNumber(input.totalValue) || input.totalValue <= 0) return zero(input, "invalid_equity: total portfolio value missing or non-positive");
  if (!isFiniteNumber(c.confidence) || c.confidence <= 0 || c.confidence > 1) return zero(input, "missing_confidence: calibrated confidence unavailable");
  if (!isFiniteNumber(c.expectedDownsidePct) || c.expectedDownsidePct <= 0) return zero(input, "missing_downside: expected downside unavailable or non-positive");
  if (!isFiniteNumber(c.adv) || c.adv <= 0) return zero(input, "liquidity_unknown: average dollar volume unavailable");
  if (!isFiniteNumber(input.buyingPower) || input.buyingPower <= 0) return zero(input, "no_buying_power: buying power missing or zero");
  if (!isFiniteNumber(p.deployedPct) || p.deployedPct < 0) return zero(input, "missing_deployed_pct: deployed capital unknown");
  if (!isFiniteNumber(p.existingPositionNotional) || p.existingPositionNotional < 0) return zero(input, "missing_existing_position: existing position notional unknown");

  const price = input.price;
  const equity = input.totalValue;

  // --- Kelly target -------------------------------------------------------------------------
  const perf = input.strategyPerformance;
  const regime = input.regimePerformance;
  const blended = blendedWinProbability({
    calibratedConfidence: c.confidence,
    strategyWinRate: perf?.winRate ?? null,
    strategyTrades: perf?.trades ?? 0,
    regimeWinRate: regime?.winRate ?? null,
    regimeTrades: regime?.trades ?? 0,
  });
  rationale.push(...blended.notes);

  let payoff = payoffFromExpectations(c.expectedUpsidePct, c.expectedDownsidePct);
  if (payoff === null && perf && isFiniteNumber(perf.payoffRatio) && perf.payoffRatio > 0 && perf.trades > 0) {
    payoff = perf.payoffRatio;
    rationale.push(`payoff ratio ${payoff.toFixed(2)} taken from strategy history (${perf.trades} trades)`);
  } else if (payoff !== null && perf && isFiniteNumber(perf.payoffRatio) && perf.payoffRatio > 0 && perf.trades >= 10) {
    const w = clamp(perf.trades / 30, 0, 1) * 0.5;
    payoff = (1 - w) * payoff + w * perf.payoffRatio;
    rationale.push(`payoff ratio blended with strategy history: ${payoff.toFixed(2)}`);
  }
  if (payoff === null) return zero(input, "missing_payoff: neither expected upside nor historical payoff available");

  const kelly = cappedKelly(blended.probability, payoff, settings.kellyFraction);
  if (kelly === null) return zero(input, "kelly_undefined: probability or payoff degenerate");
  if (kelly.fullKelly <= 0) return zero(input, `negative_edge: full Kelly <= 0 (p=${kelly.probability.toFixed(2)}, b=${kelly.payoffRatio.toFixed(2)})`, [], kelly);
  rationale.push(`full Kelly ${(kelly.fullKelly * 100).toFixed(1)}% of equity, capped at ${(kelly.fractionApplied * 100).toFixed(0)}% Kelly => ${(kelly.cappedKelly * 100).toFixed(2)}%`);

  // --- Scaling multipliers on the Kelly target ---------------------------------------------
  let scale = 1;
  const applyScale = (m: number, why: string) => {
    const mm = clamp(m, 0, 1);
    if (mm < 1) { scale *= mm; rationale.push(`${why} (x${mm.toFixed(2)})`); }
  };

  // Confidence relative to the minimum: at the minimum size 50%, at 1.0 size 100%.
  const confSpan = Math.max(1e-6, 1 - settings.minConfidence);
  applyScale(0.5 + 0.5 * clamp((c.confidence - settings.minConfidence) / confSpan, 0, 1), `confidence ${c.confidence.toFixed(2)} vs minimum ${settings.minConfidence.toFixed(2)}`);

  if (isFiniteNumber(c.correlationToPortfolio)) {
    applyScale(1 - 0.5 * Math.max(0, c.correlationToPortfolio), `correlation to portfolio ${c.correlationToPortfolio.toFixed(2)}`);
  } else {
    applyScale(0.75, "correlation to portfolio unknown");
  }

  if (isFiniteNumber(p.currentDrawdownPct)) {
    const use = settings.maxDrawdownPct > 0 ? p.currentDrawdownPct / settings.maxDrawdownPct : 1;
    if (use >= 1) return zero(input, `drawdown_limit: drawdown ${(p.currentDrawdownPct * 100).toFixed(1)}% at or beyond the ${(settings.maxDrawdownPct * 100).toFixed(1)}% limit`, [], kelly);
    applyScale(1 - use, `drawdown ${(p.currentDrawdownPct * 100).toFixed(1)}% of ${(settings.maxDrawdownPct * 100).toFixed(1)}% limit`);
  } else {
    applyScale(0.5, "current drawdown unknown");
  }

  if (isFiniteNumber(c.regimeFit)) applyScale(0.5 + 0.5 * clamp(c.regimeFit, 0, 1), `regime fit ${c.regimeFit.toFixed(2)}`);
  else applyScale(0.5, "regime fit unknown");

  if (isFiniteNumber(c.uncertainty)) applyScale(1 - 0.5 * clamp(c.uncertainty, 0, 1), `uncertainty ${c.uncertainty.toFixed(2)}`);

  if (isFiniteNumber(c.liquidityScore)) applyScale(0.5 + 0.5 * clamp(c.liquidityScore, 0, 1), `liquidity score ${c.liquidityScore.toFixed(2)}`);

  if (regime && regime.trades >= 10 && isFiniteNumber(regime.winRate) && regime.winRate < 0.4) {
    applyScale(0.5, `strategy has a weak record in this regime (win rate ${(regime.winRate * 100).toFixed(0)}% over ${regime.trades} trades)`);
  }

  applyScale(clamp(p.sizeMultiplier, 0, 1), `portfolio fit multiplier ${clamp(p.sizeMultiplier, 0, 1).toFixed(2)}`);
  if (scale <= 0) return zero(input, "scaled_to_zero: a scaling factor is zero", [], kelly);

  const kellyNotional = kelly.cappedKelly * equity * scale;

  // --- Hard caps (max notional per constraint) ---------------------------------------------
  const constraints: SizingConstraint[] = [];
  constraints.push({ name: "kelly_target", maxNotional: kellyNotional, detail: `capped Kelly x scaling ${scale.toFixed(3)}` });

  const positionCapPct = Math.min(settings.maxPositionPct, isFiniteNumber(input.strategyMaxPositionPct) ? input.strategyMaxPositionPct : Infinity);
  constraints.push({ name: "max_position_pct", maxNotional: positionCapPct * equity - p.existingPositionNotional, detail: `${(positionCapPct * 100).toFixed(1)}% of equity minus existing ${p.existingPositionNotional.toFixed(0)}` });

  const lossCapPct = Math.min(settings.maxLossPerTradePct, isFiniteNumber(input.strategyMaxLossPerTradePct) ? input.strategyMaxLossPerTradePct : Infinity);
  constraints.push({ name: "max_loss_per_trade", maxNotional: (lossCapPct * equity) / c.expectedDownsidePct, detail: `loss budget ${(lossCapPct * 100).toFixed(2)}% of equity at ${(c.expectedDownsidePct * 100).toFixed(1)}% expected downside` });

  const dailyVol = isFiniteNumber(c.annualizedVol) && c.annualizedVol > 0 ? c.annualizedVol / DAILY_VOL_SCALE : null;
  const atr = isFiniteNumber(c.atrPct) && c.atrPct > 0 ? c.atrPct : null;
  const riskUnit = Math.max(dailyVol !== null ? 2 * dailyVol : 0, atr ?? 0);
  if (riskUnit > 0) {
    constraints.push({ name: "volatility_target", maxNotional: (lossCapPct * equity) / riskUnit, detail: `loss budget over a 2-sigma daily move / ATR of ${(riskUnit * 100).toFixed(2)}%` });
  } else {
    constraints.push({ name: "volatility_unknown", maxNotional: kellyNotional * 0.5, detail: "volatility and ATR unknown; Kelly target halved" });
  }

  const participation = input.maxAdvParticipation ?? 0.01;
  constraints.push({ name: "liquidity_adv", maxNotional: c.adv * participation, detail: `${(participation * 100).toFixed(2)}% of ADV ${c.adv.toFixed(0)}` });

  constraints.push({ name: "capital_deployed", maxNotional: (settings.maxCapitalDeployedPct - p.deployedPct) * equity, detail: `${(settings.maxCapitalDeployedPct * 100).toFixed(0)}% cap, ${(p.deployedPct * 100).toFixed(1)}% deployed` });

  if (isFiniteNumber(input.capitalAllocation)) {
    constraints.push({ name: "strategy_allocation", maxNotional: clamp(input.capitalAllocation, 0, 1) * settings.maxCapitalDeployedPct * equity - p.existingPositionNotional, detail: `strategy allocation ${(clamp(input.capitalAllocation, 0, 1) * 100).toFixed(0)}% of deployable capital` });
  }

  constraints.push({ name: "buying_power", maxNotional: input.buyingPower, detail: `buying power ${input.buyingPower.toFixed(0)}` });

  let binding = constraints[0] as SizingConstraint;
  for (const k of constraints) if (k.maxNotional < binding.maxNotional) binding = k;
  const maxNotional = Math.max(0, binding.maxNotional);
  if (maxNotional <= 0) return zero(input, `${binding.name}: no room (${binding.detail})`, constraints, kelly);

  // --- Quantity ---------------------------------------------------------------------------------
  const fractionalOk = input.fractionalAllowed && input.orderType === "market";
  let quantity = fractionalOk ? Math.floor((maxNotional / price) * 1e4) / 1e4 : Math.floor(maxNotional / price);
  if (quantity <= 0) return zero(input, `below_one_share: ${maxNotional.toFixed(2)} buys less than one share at ${price.toFixed(2)} (${binding.name} binding)`, constraints, kelly);
  quantity = Number(quantity.toFixed(4));
  const notional = Number((quantity * price).toFixed(2));
  rationale.push(`binding constraint: ${binding.name} (${binding.detail}) => ${notional.toFixed(2)} notional, ${quantity} ${fractionalOk ? "fractional " : ""}shares`);

  return {
    scope: input.scope,
    symbol: input.symbol,
    engineVersion: SIZING_ENGINE_VERSION,
    quantity,
    notional,
    fractionOfEquity: notional / equity,
    bindingConstraint: binding.name,
    constraints,
    kelly,
    scalingMultiplier: scale,
    rationale,
    decidedAt: input.now,
  };
}
