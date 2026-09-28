import type { IsoTimestamp, RiskSettings, TenantScope } from "../types/index.js";
import { assertScope } from "../types/index.js";
import {
  averagePairwiseCorrelation,
  clamp,
  herfindahl,
  isFiniteNumber,
  lookupCorrelation,
  type CorrelationMatrix,
} from "./math.js";
import { isValidIso } from "./time.js";

export const PORTFOLIO_ENGINE_VERSION = "portfolio-1.0.0";

export interface PortfolioPositionInput {
  symbol: string;
  assetClass: "equity" | "option" | "crypto";
  sector: string | null;
  beta: number | null;
  quantity: number;
  /** Null when the mark is stale/missing. The engine never fabricates a value. */
  marketValue: number | null;
  /** Correlation of this position's returns to the candidate's returns; null = unknown. */
  correlationToCandidate: number | null;
  /** Calendar days until the next earnings release; null = unknown / none scheduled. */
  earningsInDays: number | null;
  strategyKey?: string | null;
}

export interface PortfolioCandidateInput {
  symbol: string;
  assetClass: "equity" | "option" | "crypto";
  sector: string | null;
  beta: number | null;
  /** Proposed notional before portfolio adjustment (> 0). */
  proposedNotional: number;
  /** Optional pre-computed correlation to the portfolio; else derived from positions. */
  correlationToPortfolio?: number | null;
  /** The single most correlated holding (pairwise, last 60 sessions): a value-weighted average across a diversified book hides a shared factor. */
  maxCorrelation?: { symbol: string; r: number } | null;
  strategyKey?: string | null;
  earningsInDays?: number | null;
}

export interface PortfolioAssessInput {
  scope: TenantScope;
  now: IsoTimestamp;
  totalValue: number | null;
  cash: number | null;
  positions: PortfolioPositionInput[];
  /** Highest historical total value; null when unknown. */
  peakValue: number | null;
  /** Signed fractions; null when unknown. */
  dailyPnlPct: number | null;
  weeklyPnlPct: number | null;
  settings: RiskSettings;
  /** Optional pairwise correlations between held symbols (and the candidate). */
  correlationMatrix?: CorrelationMatrix | null;
  /** Positions with earnings within this many days count as event exposure (default 5). */
  eventHorizonDays?: number;
  candidate: PortfolioCandidateInput | null;
}

export interface CandidateFit {
  symbol: string;
  /** -1..1; negative = poor fit. */
  fitScore: number;
  /** 0..1 multiplier to apply to the proposed notional. */
  sizeMultiplier: number;
  /** Notional after applying the multiplier. */
  adjustedNotional: number;
  notes: string[];
  positionPctAfter: number;
  sectorPctAfter: number;
  betaAfter: number | null;
  correlationToPortfolio: number | null;
  duplicateExposure: boolean;
}

export interface PortfolioAssessment {
  scope: TenantScope;
  asOf: IsoTimestamp;
  engineVersion: string;
  /** False when the inputs were incomplete; the candidate fit is then zero-sized. */
  complete: boolean;
  totalValue: number;
  exposurePct: number;
  cashPct: number;
  positionCount: number;
  sectorExposure: Record<string, number>;
  /** sum(beta_i * weight_i); null when any position lacks beta or value. */
  betaWeightedExposure: number | null;
  averagePairwiseCorrelation: number | null;
  /** Herfindahl index over position weights (0..1). */
  concentrationHHI: number;
  currentDrawdownPct: number | null;
  /** 0..1 remaining capacity to take risk given drawdown and loss limits. */
  riskCapacity: number;
  eventExposure: { symbols: string[]; pct: number };
  candidate: CandidateFit | null;
  warnings: string[];
}

interface Valued { symbol: string; sector: string | null; beta: number | null; marketValue: number; assetClass: string; earningsInDays: number | null; correlationToCandidate: number | null }

const CORRELATED_THRESHOLD = 0.5;

/**
 * Per-user portfolio engine. Pure and deterministic. The same candidate produces different
 * fit results for different portfolios; this is by design.
 */
export function assess(input: PortfolioAssessInput): PortfolioAssessment {
  assertScope(input.scope, "PortfolioEngine.assess");
  if (!isValidIso(input.now)) throw new Error("PortfolioEngine.assess: `now` must be a valid ISO timestamp");
  const warnings: string[] = [];
  const settings = input.settings;
  let complete = true;

  const totalValue = isFiniteNumber(input.totalValue) && input.totalValue > 0 ? input.totalValue : null;
  if (totalValue === null) { warnings.push("total portfolio value unknown or non-positive"); complete = false; }

  const valued: Valued[] = [];
  for (const p of input.positions) {
    if (!isFiniteNumber(p.marketValue)) {
      warnings.push(`position ${p.symbol} has no market value (stale or missing mark)`);
      complete = false;
      continue;
    }
    valued.push({ ...p, marketValue: p.marketValue });
  }

  const tv = totalValue ?? 0;
  const grossExposure = valued.reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const exposurePct = tv > 0 ? grossExposure / tv : 0;
  const cash = isFiniteNumber(input.cash) ? input.cash : null;
  if (cash === null) warnings.push("cash balance unknown");
  const cashPct = tv > 0 && cash !== null ? cash / tv : 0;

  const sectorExposure: Record<string, number> = {};
  for (const p of valued) {
    const key = p.sector ?? "unknown";
    sectorExposure[key] = (sectorExposure[key] ?? 0) + (tv > 0 ? Math.abs(p.marketValue) / tv : 0);
  }

  let betaWeightedExposure: number | null = 0;
  for (const p of valued) {
    if (!isFiniteNumber(p.beta)) { betaWeightedExposure = null; warnings.push(`position ${p.symbol} has no beta`); break; }
    betaWeightedExposure += tv > 0 ? (p.beta * p.marketValue) / tv : 0;
  }
  if (tv <= 0) betaWeightedExposure = null;

  const avgCorr = averagePairwiseCorrelation(valued.map((p) => p.symbol), input.correlationMatrix);
  const concentrationHHI = herfindahl(valued.map((p) => p.marketValue));

  let currentDrawdownPct: number | null = null;
  if (totalValue !== null && isFiniteNumber(input.peakValue) && input.peakValue > 0) {
    currentDrawdownPct = clamp((input.peakValue - totalValue) / input.peakValue, 0, 1);
  } else {
    warnings.push("peak value unknown; drawdown cannot be computed");
  }

  const riskCapacity = computeRiskCapacity({
    currentDrawdownPct,
    dailyPnlPct: input.dailyPnlPct,
    weeklyPnlPct: input.weeklyPnlPct,
    settings,
    warnings,
  });

  const horizon = input.eventHorizonDays ?? 5;
  const eventSymbols = valued.filter((p) => isFiniteNumber(p.earningsInDays) && p.earningsInDays >= 0 && p.earningsInDays <= horizon).map((p) => p.symbol);
  const eventValue = valued.filter((p) => eventSymbols.includes(p.symbol)).reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const eventExposure = { symbols: eventSymbols, pct: tv > 0 ? eventValue / tv : 0 };

  const candidate = input.candidate
    ? assessCandidate(input.candidate, { valued, tv, complete, sectorExposure, betaWeightedExposure, riskCapacity, settings, matrix: input.correlationMatrix ?? null, horizon })
    : null;

  return {
    scope: input.scope,
    asOf: input.now,
    engineVersion: PORTFOLIO_ENGINE_VERSION,
    complete,
    totalValue: tv,
    exposurePct,
    cashPct,
    positionCount: valued.length,
    sectorExposure,
    betaWeightedExposure,
    averagePairwiseCorrelation: avgCorr,
    concentrationHHI,
    currentDrawdownPct,
    riskCapacity,
    eventExposure,
    candidate,
    warnings,
  };
}

interface CapacityInput {
  currentDrawdownPct: number | null;
  dailyPnlPct: number | null;
  weeklyPnlPct: number | null;
  settings: RiskSettings;
  warnings: string[];
}

/**
 * Remaining risk capacity in [0,1]: the smallest remaining fraction of the drawdown, daily
 * and weekly loss budgets. Unknown budgets are haircut (0.5) rather than assumed healthy.
 */
export function computeRiskCapacity(input: CapacityInput): number {
  const { settings } = input;
  const factors: number[] = [];
  const unknownHaircut = 0.5;

  if (input.currentDrawdownPct === null) {
    factors.push(unknownHaircut);
  } else if (settings.maxDrawdownPct <= 0) {
    factors.push(0);
  } else {
    factors.push(clamp(1 - input.currentDrawdownPct / settings.maxDrawdownPct, 0, 1));
  }

  for (const [pnl, limit, label] of [
    [input.dailyPnlPct, settings.maxDailyLossPct, "daily"],
    [input.weeklyPnlPct, settings.maxWeeklyLossPct, "weekly"],
  ] as const) {
    if (!isFiniteNumber(pnl)) {
      input.warnings.push(`${label} P&L unknown; risk capacity haircut applied`);
      factors.push(unknownHaircut);
    } else if (pnl >= 0) {
      factors.push(1);
    } else if (limit <= 0) {
      factors.push(0);
    } else {
      factors.push(clamp(1 - (-pnl) / limit, 0, 1));
    }
  }
  return factors.length === 0 ? 0 : Math.min(...factors);
}

interface CandidateContext {
  valued: Valued[];
  tv: number;
  complete: boolean;
  sectorExposure: Record<string, number>;
  betaWeightedExposure: number | null;
  riskCapacity: number;
  settings: RiskSettings;
  matrix: CorrelationMatrix | null;
  horizon: number;
}

function assessCandidate(c: PortfolioCandidateInput, ctx: CandidateContext): CandidateFit {
  const notes: string[] = [];
  const { tv, settings } = ctx;
  const notional = isFiniteNumber(c.proposedNotional) && c.proposedNotional > 0 ? c.proposedNotional : 0;

  const existing = ctx.valued.filter((p) => p.symbol === c.symbol);
  const existingValue = existing.reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const duplicateExposure = existing.length > 0;

  const positionPctAfter = tv > 0 ? (existingValue + notional) / tv : 1;
  const sectorKey = c.sector ?? "unknown";
  const sectorNow = ctx.sectorExposure[sectorKey] ?? 0;
  const sectorPctAfter = tv > 0 ? sectorNow + notional / tv : 1;

  let betaAfter: number | null = null;
  if (ctx.betaWeightedExposure !== null && isFiniteNumber(c.beta) && tv > 0) {
    betaAfter = ctx.betaWeightedExposure + (c.beta * notional) / tv;
  }

  const correlationToPortfolio = resolveCorrelation(c, ctx);

  if (!ctx.complete || tv <= 0 || notional <= 0) {
    notes.push(notional <= 0 ? "proposed notional must be positive" : "portfolio state incomplete; candidate cannot be sized (fail closed)");
    return { symbol: c.symbol, fitScore: -1, sizeMultiplier: 0, adjustedNotional: 0, notes, positionPctAfter, sectorPctAfter, betaAfter, correlationToPortfolio, duplicateExposure };
  }

  let score = 0;

  // Sector concentration: quadratic penalty as the sector fills; hard breach => -1.
  const sectorUse = settings.maxSectorPct > 0 ? sectorPctAfter / settings.maxSectorPct : Infinity;
  if (sectorUse > 1) {
    score -= 1;
    notes.push(`sector ${sectorKey} would reach ${pct(sectorPctAfter)} of equity, above the ${pct(settings.maxSectorPct)} limit`);
  } else {
    score -= 0.6 * sectorUse * sectorUse;
    if (sectorUse > 0.6) notes.push(`sector ${sectorKey} is already ${pct(sectorNow)} of equity; adding concentration`);
    if (sectorNow === 0) { score += 0.25; notes.push(`opens a new sector (${sectorKey}); improves diversification`); }
  }

  // Position size vs limit.
  const posUse = settings.maxPositionPct > 0 ? positionPctAfter / settings.maxPositionPct : Infinity;
  if (posUse > 1) {
    score -= 0.5;
    notes.push(`position would be ${pct(positionPctAfter)} of equity, above the ${pct(settings.maxPositionPct)} single-position limit`);
  }

  // Correlation to what is already held.
  if (correlationToPortfolio === null) {
    score -= 0.15;
    notes.push("correlation to portfolio unknown; small penalty applied");
  } else if (correlationToPortfolio > 0.35) {
    const pen = 0.5 * ((correlationToPortfolio - 0.35) / 0.65);
    score -= pen;
    notes.push(`correlation to existing holdings ${correlationToPortfolio.toFixed(2)}; limited diversification benefit`);
  } else if (correlationToPortfolio < 0) {
    score += 0.2;
    notes.push(`negatively correlated with holdings (${correlationToPortfolio.toFixed(2)}); diversifying`);
  } else if (ctx.valued.length > 0) {
    score += 0.1;
    notes.push(`low correlation to holdings (${correlationToPortfolio.toFixed(2)}); diversifying`);
  }
  // A shared factor with one holding is a risk the book-wide average hides (NVDA against AMAT
  // reads 0.2 against a diversified book while the pair moves together).
  const twin = c.maxCorrelation ?? null;
  if (twin && isFiniteNumber(twin.r) && twin.r >= 0.6 && twin.symbol !== c.symbol) {
    const pen = 0.25 * ((twin.r - 0.6) / 0.4) + 0.05;
    score -= pen;
    notes.push(`shares a factor with ${twin.symbol} (pairwise correlation ${twin.r.toFixed(2)}); the pair moves together`);
  }

  // Correlated exposure cluster (|corr| >= 0.5) vs limit.
  const correlatedValue = ctx.valued
    .filter((p) => p.symbol !== c.symbol && Math.abs(corrToCandidate(p, c, ctx.matrix) ?? 0) >= CORRELATED_THRESHOLD)
    .reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const correlatedPctAfter = (correlatedValue + existingValue + notional) / tv;
  if (correlatedValue > 0 && correlatedPctAfter > settings.maxCorrelatedExposurePct) {
    score -= 0.5;
    notes.push(`correlated exposure would reach ${pct(correlatedPctAfter)}, above the ${pct(settings.maxCorrelatedExposurePct)} limit`);
  }

  // Duplicate exposure to the same symbol.
  if (duplicateExposure) {
    score -= 0.5;
    notes.push(`already holding ${c.symbol} (${pct(existingValue / tv)} of equity); adding duplicates exposure`);
  }

  // Beta budget.
  if (betaAfter !== null && betaAfter > settings.maxPortfolioBeta) {
    score -= 0.4;
    notes.push(`portfolio beta would be ${betaAfter.toFixed(2)}, above the ${settings.maxPortfolioBeta.toFixed(2)} limit`);
  } else if (betaAfter === null) {
    notes.push("portfolio beta after trade unknown (missing beta on a holding or the candidate)");
  }

  // Risk capacity: reward healthy budgets, penalise depleted ones.
  score += (ctx.riskCapacity - 0.5) * 0.6;
  if (ctx.riskCapacity < 0.25) notes.push(`risk capacity low (${ctx.riskCapacity.toFixed(2)}); drawdown or loss budgets nearly exhausted`);
  else if (ctx.riskCapacity > 0.75) notes.push("risk budgets healthy");

  // Event risk on the candidate.
  if (isFiniteNumber(c.earningsInDays) && c.earningsInDays >= 0 && c.earningsInDays <= ctx.horizon) {
    score -= 0.2;
    notes.push(`earnings in ${c.earningsInDays} day(s); event risk`);
  }

  // Concentration reward for small books.
  if (ctx.valued.length < 4) { score += 0.1; notes.push("portfolio is lightly invested; new position adds diversification"); }

  const fitScore = clamp(Number(score.toFixed(4)), -1, 1);

  // Size multiplier: fit-driven, then bounded by remaining sector/position/correlation headroom and capacity.
  let multiplier = clamp((fitScore + 0.5) / 1.0, 0, 1);
  const headroomSector = settings.maxSectorPct * tv - sectorNow * tv;
  const headroomPosition = settings.maxPositionPct * tv - existingValue;
  const headroomCorrelated = correlatedValue > 0 ? settings.maxCorrelatedExposurePct * tv - correlatedValue - existingValue : Infinity;
  const headroom = Math.max(0, Math.min(headroomSector, headroomPosition, headroomCorrelated));
  const headroomMult = clamp(headroom / notional, 0, 1);
  if (headroomMult < multiplier) {
    multiplier = headroomMult;
    notes.push(`size capped to remaining headroom (${pct(headroom / tv)} of equity)`);
  }
  if (ctx.riskCapacity <= 0) { multiplier = 0; notes.push("no remaining risk capacity; size zero"); }
  else if (ctx.riskCapacity < 0.5) multiplier = Math.min(multiplier, clamp(ctx.riskCapacity * 2, 0, 1));
  multiplier = clamp(Number(multiplier.toFixed(4)), 0, 1);

  return {
    symbol: c.symbol,
    fitScore,
    sizeMultiplier: multiplier,
    adjustedNotional: Number((notional * multiplier).toFixed(2)),
    notes,
    positionPctAfter,
    sectorPctAfter,
    betaAfter,
    correlationToPortfolio,
    duplicateExposure,
  };
}

function corrToCandidate(p: Valued, c: PortfolioCandidateInput, matrix: CorrelationMatrix | null): number | null {
  if (isFiniteNumber(p.correlationToCandidate)) return p.correlationToCandidate;
  return lookupCorrelation(matrix, p.symbol, c.symbol);
}

/** Value-weighted correlation of the candidate to the held positions; null when nothing is known. */
function resolveCorrelation(c: PortfolioCandidateInput, ctx: CandidateContext): number | null {
  if (isFiniteNumber(c.correlationToPortfolio)) return clamp(c.correlationToPortfolio, -1, 1);
  let weighted = 0; let weight = 0;
  for (const p of ctx.valued) {
    if (p.symbol === c.symbol) continue;
    const r = corrToCandidate(p, c, ctx.matrix);
    if (r === null) continue;
    weighted += r * Math.abs(p.marketValue);
    weight += Math.abs(p.marketValue);
  }
  return weight > 0 ? clamp(weighted / weight, -1, 1) : null;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
