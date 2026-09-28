import { isNum, round } from "./math.js";

/**
 * Reverse DCF: instead of asking "what is it worth?", ask "what must happen for the current
 * price to be fair?". The answer (implied growth or margin) is then compared with history,
 * guidance and our forecast. Missing inputs give nulls, never defaults.
 */

export interface ReverseDcfInput {
  price: number | null;
  sharesOutstanding: number | null;
  netDebt: number | null;
  baseRevenue: number | null;
  /** FCF margin in percent used for the explicit period. */
  fcfMarginPct: number | null;
  /** Discount rate in percent (e.g. 9). */
  discountRatePct: number | null;
  /** Terminal growth in percent (e.g. 2.5). Must be below the discount rate. */
  terminalGrowthPct: number | null;
  horizonYears: number | null;
}

interface CompleteDcf {
  price: number;
  sharesOutstanding: number;
  netDebt: number;
  baseRevenue: number;
  fcfMarginPct: number;
  discountRatePct: number;
  terminalGrowthPct: number;
  horizonYears: number;
}

function complete(input: ReverseDcfInput): { ok: true; v: CompleteDcf } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const req: (keyof ReverseDcfInput)[] = ["price", "sharesOutstanding", "netDebt", "baseRevenue", "fcfMarginPct", "discountRatePct", "terminalGrowthPct", "horizonYears"];
  for (const k of req) if (!isNum(input[k])) missing.push(k);
  if (missing.length > 0) return { ok: false, missing };
  const v = input as unknown as CompleteDcf;
  if (v.sharesOutstanding <= 0) return { ok: false, missing: ["sharesOutstanding (must be > 0)"] };
  if (v.horizonYears < 1 || v.horizonYears > 30) return { ok: false, missing: ["horizonYears (1..30)"] };
  if (v.terminalGrowthPct >= v.discountRatePct) return { ok: false, missing: ["terminalGrowthPct (must be below discountRatePct)"] };
  return { ok: true, v };
}

/** Equity value per share for a given revenue growth (percent) and FCF margin (percent). */
export function valuePerShare(input: ReverseDcfInput, growthPct: number, fcfMarginPct?: number): number | null {
  const c = complete({ ...input, fcfMarginPct: fcfMarginPct ?? input.fcfMarginPct });
  if (!c.ok) return null;
  const { v } = c;
  const g = growthPct / 100;
  const r = v.discountRatePct / 100;
  const gt = v.terminalGrowthPct / 100;
  const m = v.fcfMarginPct / 100;
  let pv = 0;
  let revenue = v.baseRevenue;
  let fcf = 0;
  for (let t = 1; t <= v.horizonYears; t++) {
    revenue *= 1 + g;
    fcf = revenue * m;
    pv += fcf / Math.pow(1 + r, t);
  }
  const terminal = (fcf * (1 + gt)) / (r - gt);
  pv += terminal / Math.pow(1 + r, v.horizonYears);
  return (pv - v.netDebt) / v.sharesOutstanding;
}

export interface SolveResult {
  value: number;
  iterations: number;
  residual: number;
}

function bisect(f: (x: number) => number | null, lo: number, hi: number, tolerance: number, maxIter = 200): SolveResult | null {
  let flo = f(lo);
  let fhi = f(hi);
  if (flo === null || fhi === null) return null;
  if (flo === 0) return { value: lo, iterations: 0, residual: 0 };
  if (fhi === 0) return { value: hi, iterations: 0, residual: 0 };
  if (Math.sign(flo) === Math.sign(fhi)) return null;
  let iterations = 0;
  while (iterations < maxIter) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm === null) return null;
    iterations++;
    if (Math.abs(fm) < tolerance || (hi - lo) / 2 < 1e-9) return { value: mid, iterations, residual: fm };
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
      fhi = fm;
    }
  }
  return null;
}

/** Annual revenue growth (percent) that justifies the current price at the given margin. Null when unsolvable. */
export function impliedGrowth(input: ReverseDcfInput): SolveResult | null {
  const c = complete(input);
  if (!c.ok) return null;
  const price = c.v.price;
  const res = bisect((g) => {
    const v = valuePerShare(input, g);
    return v === null ? null : v - price;
  }, -60, 200, Math.max(1e-6, price * 1e-6));
  return res ? { ...res, value: round(res.value, 3) } : null;
}

/** FCF margin (percent) that justifies the current price at the given growth. Null when unsolvable. */
export function impliedMargin(input: ReverseDcfInput, growthPct: number | null): SolveResult | null {
  const c = complete({ ...input, fcfMarginPct: input.fcfMarginPct ?? 0 });
  if (!c.ok || !isNum(growthPct)) return null;
  const price = c.v.price;
  const res = bisect((m) => {
    const v = valuePerShare(input, growthPct, m);
    return v === null ? null : v - price;
  }, -50, 100, Math.max(1e-6, price * 1e-6));
  return res ? { ...res, value: round(res.value, 3) } : null;
}

export interface ImpliedExpectationsInput extends ReverseDcfInput {
  historicalGrowthPct?: number | null;
  guidanceGrowthPct?: number | null;
  internalGrowthPct?: number | null;
  historicalMarginPct?: number | null;
  guidanceMarginPct?: number | null;
  internalMarginPct?: number | null;
  /** Invested capital for an implied return-on-capital estimate. */
  investedCapital?: number | null;
}

export interface ImpliedExpectationsResult {
  impliedGrowthPct: number | null;
  impliedMarginPct: number | null;
  impliedReturnOnCapital: number | null;
  comparedToHistory: string;
  comparedToGuidance: string;
  comparedToInternal: string;
  notes: string[];
}

function compare(label: string, implied: number | null, reference: number | null | undefined, what: string): string {
  if (!isNum(implied)) return `${label}: implied ${what} not computed`;
  if (!isNum(reference)) return `${label}: no ${label.toLowerCase()} ${what} available to compare`;
  const gap = implied - reference;
  const verdict = Math.abs(gap) < 1 ? "in line with" : gap > 0 ? "above" : "below";
  return `price implies ${round(implied, 1)}% ${what}, ${verdict} ${label.toLowerCase()} ${round(reference, 1)}% (${gap >= 0 ? "+" : ""}${round(gap, 1)} pts)`;
}

/**
 * Implied expectations bundle. Solves implied growth at the supplied margin and implied margin at
 * the reference growth (internal, else guidance, else history) and compares them in plain words.
 */
export function impliedExpectations(input: ImpliedExpectationsInput): ImpliedExpectationsResult {
  const notes: string[] = [];
  const c = complete(input);
  if (!c.ok) {
    notes.push(`reverse DCF not run: missing ${c.missing.join(", ")}`);
    return { impliedGrowthPct: null, impliedMarginPct: null, impliedReturnOnCapital: null, comparedToHistory: "not computed", comparedToGuidance: "not computed", comparedToInternal: "not computed", notes };
  }
  const g = impliedGrowth(input);
  const impliedGrowthPct = g ? g.value : null;
  if (!g) notes.push("implied growth: no solution inside -60%..200%");
  const refGrowth = [input.internalGrowthPct, input.guidanceGrowthPct, input.historicalGrowthPct].find(isNum) ?? null;
  const m = impliedMargin(input, refGrowth);
  const impliedMarginPct = m ? m.value : null;
  if (!m) notes.push(refGrowth === null ? "implied margin: no reference growth (internal/guidance/history) supplied" : "implied margin: no solution inside -50%..100%");

  let impliedReturnOnCapital: number | null = null;
  if (isNum(input.investedCapital) && input.investedCapital > 0 && impliedGrowthPct !== null) {
    const fcfNext = c.v.baseRevenue * (1 + impliedGrowthPct / 100) * (c.v.fcfMarginPct / 100);
    impliedReturnOnCapital = round((fcfNext / input.investedCapital) * 100, 2);
  } else notes.push("implied return on capital: invested capital not supplied");

  const growthLine = (label: string, ref: number | null | undefined) => compare(label, impliedGrowthPct, ref, "growth");
  const marginLine = (label: string, ref: number | null | undefined) => (isNum(ref) && impliedMarginPct !== null ? `; ${compare(label, impliedMarginPct, ref, "FCF margin")}` : "");
  return {
    impliedGrowthPct,
    impliedMarginPct,
    impliedReturnOnCapital,
    comparedToHistory: growthLine("History", input.historicalGrowthPct) + marginLine("History", input.historicalMarginPct),
    comparedToGuidance: growthLine("Guidance", input.guidanceGrowthPct) + marginLine("Guidance", input.guidanceMarginPct),
    comparedToInternal: growthLine("Internal", input.internalGrowthPct) + marginLine("Internal", input.internalMarginPct),
    notes,
  };
}
