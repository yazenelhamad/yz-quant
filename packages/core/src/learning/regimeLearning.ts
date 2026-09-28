import type { StrategyIntelligenceProfile } from "../types/index.js";
import { clamp, pct } from "./math.js";

export interface RegimeFitCell {
  score: number; // [-1, 1], shrunk toward 0 for small samples
  trades: number;
  expectancyPct: number | null;
  winRate: number | null;
}

export type StrategyRegimeFit = Record<string, Record<string, RegimeFitCell>>;

/**
 * Per-strategy, per-regime fit. Raw score blends expectancy (tanh of percent) with the win-rate
 * margin over 50%, then shrinks toward zero by n / (n + priorTrades) so a couple of trades in a
 * rare regime cannot dominate.
 */
export function strategyRegimeFit(profilesByStrategy: Record<string, StrategyIntelligenceProfile>, priorTrades = 20): StrategyRegimeFit {
  const out: StrategyRegimeFit = {};
  for (const [strategyKey, profile] of Object.entries(profilesByStrategy)) {
    const perRegime: Record<string, RegimeFitCell> = {};
    for (const [regime, stats] of Object.entries(profile.byRegime)) {
      if (regime === "unknown") continue;
      const exp = stats.expectancyPct;
      const wr = stats.winRate;
      const raw = exp === null || wr === null ? 0 : 0.6 * Math.tanh(exp) + 0.4 * clamp((wr - 0.5) * 2, -1, 1);
      const shrink = stats.trades / (stats.trades + priorTrades);
      perRegime[regime] = { score: clamp(raw * shrink, -1, 1), trades: stats.trades, expectancyPct: exp, winRate: wr };
    }
    out[strategyKey] = perRegime;
  }
  return out;
}

export interface RegimeWeightBounds {
  min: number;
  max: number;
  maxStep: number;
}

export interface RegimeWeightAdjustment {
  strategyKey: string;
  regime: string;
  score: number;
  trades: number;
  currentWeight: number;
  proposedWeight: number;
  delta: number;
  note: string;
}

/**
 * Bounded weight adjustments for the current regime. The multiplier is 1 + score/2 (so a perfect
 * fit doubles at most before clamping); the change is clamped to +/- maxStep and to [min, max].
 * Strategies with no data in the regime are left untouched. These are numbers for the safe
 * adaptation layer, not applied settings.
 */
export function regimeWeightAdjustments(fit: StrategyRegimeFit, currentRegime: string, bounds: RegimeWeightBounds, currentWeights: Record<string, number> = {}): RegimeWeightAdjustment[] {
  const out: RegimeWeightAdjustment[] = [];
  for (const strategyKey of Object.keys(fit).sort()) {
    const cell = fit[strategyKey]?.[currentRegime];
    if (!cell || cell.trades === 0) continue;
    const current = currentWeights[strategyKey] ?? 1;
    const target = clamp(current * (1 + cell.score / 2), bounds.min, bounds.max);
    const delta = clamp(target - current, -bounds.maxStep, bounds.maxStep);
    const proposed = clamp(current + delta, bounds.min, bounds.max);
    out.push({
      strategyKey,
      regime: currentRegime,
      score: cell.score,
      trades: cell.trades,
      currentWeight: current,
      proposedWeight: proposed,
      delta: proposed - current,
      note: `${strategyKey} in ${currentRegime}: fit ${cell.score.toFixed(2)} from ${cell.trades} trades (expectancy ${pct(cell.expectancyPct)}); weight ${current.toFixed(2)} -> ${proposed.toFixed(2)}.`,
    });
  }
  return out;
}

/** Plain-English regime insights for the digest. */
export function describeRegimeFit(fit: StrategyRegimeFit, minTrades = 10): string[] {
  const lines: string[] = [];
  for (const strategyKey of Object.keys(fit).sort()) {
    const cells = Object.entries(fit[strategyKey] ?? {}).filter(([, c]) => c.trades >= minTrades);
    if (cells.length === 0) continue;
    const best = [...cells].sort((a, b) => b[1].score - a[1].score)[0] as [string, RegimeFitCell];
    const worst = [...cells].sort((a, b) => a[1].score - b[1].score)[0] as [string, RegimeFitCell];
    if (best[0] === worst[0]) {
      lines.push(`${strategyKey} has only been observed in ${best[0]} (${best[1].trades} trades, fit ${best[1].score.toFixed(2)}).`);
    } else {
      lines.push(`${strategyKey} fits ${best[0]} best (fit ${best[1].score.toFixed(2)}, ${best[1].trades} trades) and ${worst[0]} worst (fit ${worst[1].score.toFixed(2)}, ${worst[1].trades} trades).`);
    }
  }
  return lines;
}
