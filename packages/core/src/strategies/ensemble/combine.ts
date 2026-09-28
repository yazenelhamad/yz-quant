import type { EnsembleComponent, EnsembleResult, Freshness, IsoTimestamp, RegimeAssessment, Signal, StrategyFamily } from "../../types/index.js";
import { clamp, fmtSigned, mean } from "../../features/math.js";
import { FRESHNESS_RANK, freshnessFactor } from "../../features/freshness.js";

export const ENSEMBLE_VERSION = "ensemble-1.0.0";

/** Hard bounds on how far adaptation may move a weight from its base, as multipliers. */
export const WEIGHT_MULTIPLIER_BOUNDS = { min: 0.25, max: 2.0 } as const;

export interface CombineSignalsInput {
  symbol: string;
  strategyKey: string;
  /** Strategy family, used to read the regime family bias. Omit for no regime adaptation. */
  family?: StrategyFamily;
  /** Combination time; signals older than this decay, signals after it are ignored (look-ahead). */
  asOf: IsoTimestamp;
  signals: Signal[];
  regime: RegimeAssessment;
  /** Base weight per signal key; default 1. */
  weights?: Record<string, number>;
  /** Multiplicative calibration adjustment per signal key from the learning engine; default 1. */
  calibrationAdjustments?: Record<string, number>;
  /** Signal key -> cluster id. Signals in one cluster are averaged, not summed. Default: own key. */
  signalClusters?: Record<string, string>;
  /** Signal key -> half-life in days (null = no decay). */
  signalDecay?: Record<string, number | null>;
  dataQuality: Freshness;
  /** Signed adjustment from the portfolio engine in [-1, 1]; added to the raw edge. */
  portfolioAdjustment?: number;
}

function titleCase(id: string): string {
  return id.split(/[_\s-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function ageDays(signalAsOf: IsoTimestamp, asOf: IsoTimestamp): number | null {
  const a = Date.parse(signalAsOf);
  const b = Date.parse(asOf);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 86_400_000;
}

/** Adaptive weight: base × (1 + 0.5·familyBias) × calibration, clamped to [0.25, 2] × base. */
export function adaptWeight(base: number, familyBias: number, calibration: number): number {
  if (!(base > 0)) return 0;
  const raw = base * (1 + 0.5 * clamp(familyBias, -1, 1)) * (Number.isFinite(calibration) && calibration > 0 ? calibration : 1);
  return clamp(raw, base * WEIGHT_MULTIPLIER_BOUNDS.min, base * WEIGHT_MULTIPLIER_BOUNDS.max);
}

/**
 * Combine a strategy's signals into one expected edge.
 *
 * 1. Each signal gets an adaptive weight (base × regime family bias × calibration, bounded) and a
 *    decay factor 0.5^(age / halfLife).
 * 2. Signals sharing a cluster are merged by weighted mean (correlated evidence is not counted twice).
 * 3. Cluster contributions are weight-averaged into a raw edge in [-1, 1]; the portfolio adjustment
 *    is added and the result clamped.
 * 4. Confidence blends the signals' own confidence, agreement between clusters and data quality.
 *    Disagreement is the weighted dispersion of signed cluster values. Uncertainty comes from data
 *    freshness and decay.
 */
export function combineSignals(input: CombineSignalsInput): EnsembleResult {
  const explanation: string[] = [];
  const weights = input.weights ?? {};
  const calib = input.calibrationAdjustments ?? {};
  const clusters = input.signalClusters ?? {};
  const decayMap = input.signalDecay ?? {};
  const familyBias = input.family ? (input.regime.familyBias[input.family] ?? 0) : 0;
  const asOfMs = Date.parse(input.asOf);

  interface Weighted { signal: Signal; weight: number; decay: number; cluster: string; freshness: Freshness }
  const usable: Weighted[] = [];
  let ignored = 0;
  for (const s of input.signals) {
    const sMs = Date.parse(s.asOf);
    if (Number.isFinite(asOfMs) && Number.isFinite(sMs) && sMs > asOfMs) { ignored += 1; continue; }
    if (s.direction === "flat" && s.value === 0 && s.confidence === 0) continue;
    if (s.inputFreshness === "stale" || s.inputFreshness === "unknown") { ignored += 1; continue; }
    const base = weights[s.key] ?? 1;
    const weight = adaptWeight(base, familyBias, calib[s.key] ?? 1);
    if (weight <= 0) continue;
    const hl = decayMap[s.key] ?? null;
    const age = ageDays(s.asOf, input.asOf);
    const decay = hl !== null && hl > 0 && age !== null && age > 0 ? Math.pow(0.5, age / hl) : 1;
    usable.push({ signal: s, weight, decay, cluster: clusters[s.key] ?? s.key, freshness: s.inputFreshness });
  }
  if (ignored > 0) explanation.push(`${ignored} signal(s) ignored (stale, unknown freshness or after asOf)`);

  const dqFactor = freshnessFactor(input.dataQuality);
  const worstSignalFreshness: Freshness = usable.reduce<Freshness>((acc, u) => (FRESHNESS_RANK[u.freshness] < FRESHNESS_RANK[acc] ? u.freshness : acc), "fresh");
  const effectiveDq = Math.min(dqFactor, freshnessFactor(worstSignalFreshness));

  if (usable.length === 0 || effectiveDq === 0) {
    explanation.push(usable.length === 0 ? "No usable signals" : `Data quality ${input.dataQuality}: no edge is asserted`);
    explanation.push("Final Expected Edge +0.00");
    return {
      symbol: input.symbol, strategyKey: input.strategyKey, components: [], expectedEdge: 0, confidence: 0, disagreement: 0,
      uncertainty: 1, regime: input.regime.primary, asOf: input.asOf, explanation,
    };
  }

  // Cluster merge: weighted mean of values within a cluster; cluster weight = max member weight × mean decay.
  const byCluster = new Map<string, Weighted[]>();
  for (const u of usable) {
    const arr = byCluster.get(u.cluster) ?? [];
    arr.push(u);
    byCluster.set(u.cluster, arr);
  }
  interface ClusterAgg { id: string; value: number; weight: number; confidence: number; decay: number; members: Weighted[] }
  const clusterAggs: ClusterAgg[] = [];
  for (const [id, members] of byCluster) {
    let wsum = 0;
    let vsum = 0;
    let csum = 0;
    let dsum = 0;
    let maxW = 0;
    for (const m of members) {
      const w = m.weight * m.decay;
      wsum += w;
      vsum += w * m.signal.value;
      csum += w * m.signal.confidence;
      dsum += m.decay;
      maxW = Math.max(maxW, m.weight);
    }
    const value = wsum > 0 ? vsum / wsum : 0;
    const confidence = wsum > 0 ? csum / wsum : 0;
    const decay = dsum / members.length;
    clusterAggs.push({ id, value, weight: maxW * decay, confidence, decay, members });
    if (members.length > 1) explanation.push(`Cluster ${titleCase(id)}: ${members.length} correlated signals averaged to ${fmtSigned(value)}`);
  }

  const totalW = clusterAggs.reduce((s, c) => s + c.weight, 0);
  const rawEdge = totalW > 0 ? clusterAggs.reduce((s, c) => s + c.weight * c.value, 0) / totalW : 0;
  const portfolioAdj = clamp(input.portfolioAdjustment ?? 0, -1, 1);
  const expectedEdge = clamp(rawEdge + portfolioAdj, -1, 1);

  // Disagreement: weighted std of cluster values (max 1 when half at +1, half at -1).
  let disp = 0;
  if (clusterAggs.length > 1 && totalW > 0) {
    for (const c of clusterAggs) disp += c.weight * (c.value - rawEdge) * (c.value - rawEdge);
    disp = Math.sqrt(disp / totalW);
  }
  const disagreement = clamp(disp, 0, 1);

  const avgDecay = mean(clusterAggs.map((c) => c.decay)) ?? 1;
  const uncertainty = clamp(1 - effectiveDq * avgDecay, 0, 1);
  const weightedConf = totalW > 0 ? clusterAggs.reduce((s, c) => s + c.weight * c.confidence, 0) / totalW : 0;
  const avgCalib = mean(usable.map((u) => calib[u.signal.key] ?? 1)) ?? 1;
  const confidence = clamp(weightedConf * clamp(avgCalib, 0.25, 2) * (1 - 0.5 * disagreement) * (0.5 + 0.5 * effectiveDq) * (0.7 + 0.3 * avgDecay), 0, 1);

  // Components: each signal's share of its cluster contribution.
  const components: EnsembleComponent[] = [];
  for (const c of clusterAggs) {
    const clusterContribution = totalW > 0 ? (c.weight * c.value) / totalW : 0;
    const memberW = c.members.reduce((s, m) => s + m.weight * m.decay, 0);
    for (const m of c.members) {
      const share = memberW > 0 ? (m.weight * m.decay) / memberW : 0;
      components.push({ key: m.signal.key, weight: round4(m.weight), value: round4(m.signal.value), contribution: round4(clusterContribution * share), cluster: c.id });
    }
    explanation.push(`${titleCase(c.id)} ${fmtSigned(clusterContribution)}`);
  }
  if (portfolioAdj !== 0) explanation.push(`Portfolio Adjustment ${fmtSigned(portfolioAdj)}`);
  if (Math.abs(familyBias) > 0.05 && input.family) explanation.push(`Regime bias for ${titleCase(input.family)} ${fmtSigned(familyBias)} applied to weights`);
  if (input.dataQuality !== "fresh") explanation.push(`Data quality ${input.dataQuality}: confidence scaled by ${(0.5 + 0.5 * effectiveDq).toFixed(2)}`);
  explanation.push(`Final Expected Edge ${fmtSigned(expectedEdge)}`);

  return {
    symbol: input.symbol, strategyKey: input.strategyKey, components,
    expectedEdge: round4(expectedEdge), confidence: round4(confidence), disagreement: round4(disagreement), uncertainty: round4(uncertainty),
    regime: input.regime.primary, asOf: input.asOf, explanation,
  };
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
