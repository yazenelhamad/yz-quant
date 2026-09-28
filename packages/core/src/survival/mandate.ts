import type { IsoTimestamp } from "../types/index.js";
import { assertScope } from "../types/index.js";
import { clamp, isFiniteNumber, mean } from "../learning/math.js";
import { SURVIVAL_DEFAULTS, SURVIVAL_MODES, type SurvivalInput, type SurvivalMode, type SurvivalOptions, type SurvivalState } from "./types.js";

export const SURVIVAL_ENGINE_VERSION = "survival-1.0.0";

interface ModeParams { riskMultiplier: number; minEdgeMultiplier: number; hurdleMultiplier: number; positionsFraction: number; allowLiveEntries: boolean }

/** Deterministic parameters per mode. Nothing ever multiplies risk above 1. */
export const MODE_PARAMS: Readonly<Record<SurvivalMode, ModeParams>> = Object.freeze({
  thriving: { riskMultiplier: 1, minEdgeMultiplier: 1, hurdleMultiplier: 1, positionsFraction: 1, allowLiveEntries: true },
  earning: { riskMultiplier: 1, minEdgeMultiplier: 1, hurdleMultiplier: 1, positionsFraction: 1, allowLiveEntries: true },
  probation: { riskMultiplier: 0.75, minEdgeMultiplier: 1.25, hurdleMultiplier: 1.5, positionsFraction: 0.5, allowLiveEntries: true },
  survival: { riskMultiplier: 0.4, minEdgeMultiplier: 1.75, hurdleMultiplier: 2.5, positionsFraction: 0, allowLiveEntries: true },
  hibernation: { riskMultiplier: 0, minEdgeMultiplier: 2, hurdleMultiplier: 3.5, positionsFraction: 0, allowLiveEntries: false },
});

/** Survival mode allows at most two new positions per cycle regardless of the account's limit. */
const SURVIVAL_MAX_NEW_POSITIONS = 2;

export function modeRank(mode: SurvivalMode): number {
  return SURVIVAL_MODES.indexOf(mode);
}

function piecewise(x: number | null, points: [number, number][], fallback: number): number {
  if (!isFiniteNumber(x)) return fallback;
  if (x <= (points[0] as [number, number])[0]) return (points[0] as [number, number])[1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1] as [number, number];
    const [x1, y1] = points[i] as [number, number];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return (points[points.length - 1] as [number, number])[1];
}

/**
 * 0..100 P&L fitness. Expectancy (recent live, else overall live, else shadow at a discount),
 * profit factor, drawdown headroom and alpha versus the benchmark. Without enough live trades the
 * score is capped below the "earning" threshold: an account cannot be judged to be earning on hope.
 */
export function fitnessScore(input: SurvivalInput, ddRatio: number | null, alphaPct: number | null, sufficient: boolean): number {
  const o = { ...SURVIVAL_DEFAULTS, ...(input.options ?? {}) };
  const live = input.live;
  const shadow = input.shadow;
  let exp: number | null = null;
  let pf: number | null = null;
  let discount = 1;
  if (live.recent.trades >= Math.min(o.minTrades, 10) && isFiniteNumber(live.recent.expectancyPct)) { exp = live.recent.expectancyPct; pf = live.recent.profitFactor ?? live.overall.profitFactor; }
  else if (live.overall.trades >= o.minTrades && isFiniteNumber(live.overall.expectancyPct)) { exp = live.overall.expectancyPct; pf = live.overall.profitFactor; }
  else if (shadow.recent.trades >= o.minTrades && isFiniteNumber(shadow.recent.expectancyPct)) { exp = shadow.recent.expectancyPct; pf = shadow.recent.profitFactor ?? shadow.overall.profitFactor; discount = 0.7; }
  const expScore = piecewise(exp, [[-1, 0], [0, 40], [1.5, 100]], 35) * discount;
  const pfScore = piecewise(pf, [[0.6, 0], [1, 40], [1.5, 80], [2, 100]], 35) * discount;
  const ddScore = piecewise(ddRatio, [[0, 100], [1, 0]], 60);
  const alphaScore = piecewise(alphaPct, [[-0.05, 0], [0, 50], [0.05, 100]], 50);
  const raw = 0.35 * expScore + 0.25 * pfScore + 0.25 * ddScore + 0.15 * alphaScore;
  return Math.round(clamp(sufficient ? raw : Math.min(raw, 59), 0, 100));
}

function daysBetweenIso(a: string | null, b: string): number | null {
  if (!a) return null;
  const t0 = Date.parse(a); const t1 = Date.parse(b);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.max(0, (t1 - t0) / 86_400_000);
}

/**
 * Compute the survival state for one account. Pure and deterministic: the clock is `input.now`,
 * the only history is `input.previous`. Demotions apply immediately; promotions climb one rung
 * per computation and only after the dwell time, and leaving hibernation requires a positive
 * shadow record of at least `hibernationExitShadowTrades` trades.
 */
export function computeSurvival(input: SurvivalInput): SurvivalState {
  assertScope(input.scope, "computeSurvival");
  const o: SurvivalOptions = { ...SURVIVAL_DEFAULTS, ...(input.options ?? {}) };
  const reasons: string[] = [];
  const { live, shadow, settings } = input;
  const maxDd = settings.maxDrawdownPct > 0 ? settings.maxDrawdownPct : null;
  const dd = isFiniteNumber(input.drawdownPct) ? Math.max(0, input.drawdownPct) : null;
  const ddRatio = maxDd !== null && dd !== null ? dd / maxDd : null;

  // Runway: days until the drawdown limit at the current burn (mean of the last 10 daily returns when negative).
  const tail = input.recentDailyReturns.filter(isFiniteNumber).slice(-10);
  const burn = tail.length >= 3 ? mean(tail) : null;
  const headroom = maxDd !== null && dd !== null ? Math.max(0, maxDd - dd) : null;
  const runwayDays = burn !== null && burn < 0 && headroom !== null ? headroom / Math.abs(burn) : null;

  // Alpha: account return since inception versus the benchmark over the same period.
  const alphaPct = isFiniteNumber(input.liveReturnPct) && input.benchmark && isFiniteNumber(input.benchmark.returnPct) ? input.liveReturnPct - input.benchmark.returnPct : null;

  const sufficient = live.overall.trades >= o.minTrades;
  const recentEnough = live.recent.trades >= Math.min(o.minTrades, Math.ceil(o.recentN / 2));
  const recentNeg = recentEnough && isFiniteNumber(live.recent.expectancyPct) && live.recent.expectancyPct <= 0;
  const recentPos = recentEnough && isFiniteNumber(live.recent.expectancyPct) && live.recent.expectancyPct > 0;
  const overallPos = sufficient && isFiniteNumber(live.overall.expectancyPct) && live.overall.expectancyPct > 0 && (live.overall.profitFactor ?? 0) >= 1;
  const overallNeg = sufficient && (!isFiniteNumber(live.overall.expectancyPct) || live.overall.expectancyPct <= 0 || (live.overall.profitFactor ?? 0) < 1);
  const weeklyRatio = isFiniteNumber(input.weeklyPnlPct) && settings.maxWeeklyLossPct > 0 ? -input.weeklyPnlPct / settings.maxWeeklyLossPct : null;
  const shadowProof = shadow.recent.trades >= o.hibernationExitShadowTrades && isFiniteNumber(shadow.recent.expectancyPct) && shadow.recent.expectancyPct > o.hurdleBps / 100 && (shadow.recent.profitFactor ?? 0) >= 1.2;

  const score = fitnessScore(input, ddRatio, alphaPct, sufficient);

  // ---- floor: the worst condition that holds decides the lowest mode the account may be in ----
  let floor: SurvivalMode;
  // In hibernation no live trades happen, so the live record cannot improve by itself: the shadow
  // record is the only evidence that can lift a losing live record off the floor.
  const inHibernation = input.previous?.mode === "hibernation";
  const liveLosing = overallNeg && recentNeg && !(inHibernation && shadowProof);
  if ((ddRatio !== null && ddRatio >= 0.8) || liveLosing || (weeklyRatio !== null && weeklyRatio >= 1)) {
    floor = "hibernation";
    if (ddRatio !== null && ddRatio >= 0.8) reasons.push(`drawdown ${(dd! * 100).toFixed(1)}% is ${(ddRatio * 100).toFixed(0)}% of the ${(maxDd! * 100).toFixed(0)}% limit`);
    if (liveLosing) reasons.push(`the live record is losing money overall (expectancy ${fmtPct(live.overall.expectancyPct)}/trade, profit factor ${fmtNum(live.overall.profitFactor)}) and recently (${fmtPct(live.recent.expectancyPct)}/trade over ${live.recent.trades})`);
    if (liveLosing && inHibernation) reasons.push(`the shadow record has not yet proven an edge: ${shadow.recent.trades}/${o.hibernationExitShadowTrades} recent shadow trades, expectancy ${fmtPct(shadow.recent.expectancyPct)}, profit factor ${fmtNum(shadow.recent.profitFactor)}`);
    if (weeklyRatio !== null && weeklyRatio >= 1) reasons.push(`weekly loss ${(input.weeklyPnlPct! * 100).toFixed(2)}% has reached the weekly limit`);
  } else if ((ddRatio !== null && ddRatio >= 0.5) || recentNeg || (weeklyRatio !== null && weeklyRatio >= 0.6) || (runwayDays !== null && runwayDays < o.runwayCriticalDays)) {
    floor = "survival";
    if (ddRatio !== null && ddRatio >= 0.5) reasons.push(`drawdown ${(dd! * 100).toFixed(1)}% is over half of the ${(maxDd! * 100).toFixed(0)}% limit`);
    if (recentNeg) reasons.push(`recent live expectancy ${fmtPct(live.recent.expectancyPct)}/trade over the last ${live.recent.trades} trades is not positive`);
    if (weeklyRatio !== null && weeklyRatio >= 0.6) reasons.push(`weekly loss ${(input.weeklyPnlPct! * 100).toFixed(2)}% has used ${(weeklyRatio * 100).toFixed(0)}% of the weekly limit`);
    if (runwayDays !== null && runwayDays < o.runwayCriticalDays) reasons.push(`runway ${runwayDays.toFixed(0)} days to the drawdown limit at the current burn`);
  } else if (!sufficient || (ddRatio !== null && ddRatio >= 0.25) || (runwayDays !== null && runwayDays < o.runwayWarningDays) || (alphaPct !== null && alphaPct < 0 && sufficient) || score < 55) {
    floor = "probation";
    if (!sufficient) reasons.push(`only ${live.overall.trades} live trade(s): the account has not yet proven it can earn (${o.minTrades} needed)`);
    if (ddRatio !== null && ddRatio >= 0.25) reasons.push(`drawdown ${(dd! * 100).toFixed(1)}% uses ${(ddRatio * 100).toFixed(0)}% of the limit`);
    if (runwayDays !== null && runwayDays < o.runwayWarningDays) reasons.push(`runway ${runwayDays.toFixed(0)} days at the current burn`);
    if (alphaPct !== null && alphaPct < 0 && sufficient) reasons.push(`trailing the ${input.benchmark?.label ?? "benchmark"} by ${(Math.abs(alphaPct) * 100).toFixed(1)} points since inception`);
    if (score < 55 && sufficient) reasons.push(`P&L fitness ${score}/100 is below the earning threshold`);
  } else if (overallPos && recentPos && (live.overall.profitFactor ?? 0) >= 1.5 && (live.recent.profitFactor ?? live.overall.profitFactor ?? 0) >= 1.3 && (alphaPct === null || alphaPct > 0) && (ddRatio === null || ddRatio < 0.1) && score >= 75) {
    floor = "thriving";
    reasons.push(`earning on every window: expectancy ${fmtPct(live.overall.expectancyPct)}/trade, profit factor ${fmtNum(live.overall.profitFactor)}, fitness ${score}/100`);
  } else if (overallPos && recentPos && (live.overall.profitFactor ?? 0) >= 1.1) {
    floor = "earning";
    reasons.push(`positive realised expectancy ${fmtPct(live.overall.expectancyPct)}/trade (recent ${fmtPct(live.recent.expectancyPct)}), profit factor ${fmtNum(live.overall.profitFactor)}`);
  } else {
    floor = "probation";
    reasons.push("the live record is mixed: positive overall but not yet convincing on the recent window");
  }

  // ---- hysteresis: demote at once; promote one rung after the dwell, hibernation only with shadow proof ----
  const prev = input.previous;
  let mode: SurvivalMode = floor;
  let modeSince: IsoTimestamp = input.now;
  if (prev) {
    const prevRank = modeRank(prev.mode);
    const floorRank = modeRank(floor);
    if (floorRank >= prevRank) {
      // same or worse: adopt the floor
      mode = floor;
      modeSince = floor === prev.mode ? prev.modeSince : input.now;
    } else {
      // better than before: climb at most one rung, after dwelling, with proof for leaving hibernation
      const dwell = daysBetweenIso(prev.modeSince, input.now);
      const dwelled = dwell !== null && dwell >= o.promotionDwellDays;
      let canClimb = dwelled;
      if (prev.mode === "hibernation") {
        canClimb = dwelled && shadowProof && (ddRatio === null || ddRatio < 0.5);
        if (!canClimb) reasons.push(shadowProof ? `hibernation: dwell ${dwell?.toFixed(1) ?? "?"}d of ${o.promotionDwellDays}d` : `hibernation holds until the shadow record proves an edge: ${shadow.recent.trades}/${o.hibernationExitShadowTrades} recent shadow trades, expectancy ${fmtPct(shadow.recent.expectancyPct)}, profit factor ${fmtNum(shadow.recent.profitFactor)}`);
      } else if (!dwelled) {
        reasons.push(`promotion deferred: ${dwell?.toFixed(1) ?? "?"} of ${o.promotionDwellDays} days in ${prev.mode}`);
      }
      if (canClimb) {
        mode = SURVIVAL_MODES[Math.max(floorRank, prevRank - 1)] as SurvivalMode;
        modeSince = input.now;
        if (mode !== floor) reasons.push(`climbing one rung at a time: ${prev.mode} -> ${mode} (record supports ${floor})`);
      } else {
        mode = prev.mode;
        modeSince = prev.modeSince;
      }
    }
  }

  const p = MODE_PARAMS[mode];
  const maxPositions = Math.max(0, settings.maxSimultaneousPositions);
  const maxNewPositions = mode === "hibernation" ? 0 : mode === "survival" ? Math.min(SURVIVAL_MAX_NEW_POSITIONS, maxPositions) : Math.max(1, Math.ceil(maxPositions * p.positionsFraction));
  const hurdleBps = Math.round(o.hurdleBps * p.hurdleMultiplier);
  const hurdles = nextHurdles(mode, input, o, { ddRatio, runwayDays, alphaPct, sufficient, score, shadowProof });
  const mandate = buildMandate(mode, { riskMultiplier: p.riskMultiplier, minEdgeMultiplier: p.minEdgeMultiplier, hurdleBps, maxNewPositions, reasons, hurdles, runwayDays });

  return {
    scope: input.scope, version: SURVIVAL_ENGINE_VERSION, computedAt: input.now, mode, modeSince, previousMode: prev?.mode ?? null,
    fitnessScore: score, riskMultiplier: p.riskMultiplier, minEdgeMultiplier: p.minEdgeMultiplier, hurdleBps, maxNewPositions, allowLiveEntries: p.allowLiveEntries,
    runway: { days: runwayDays !== null ? Math.round(runwayDays * 10) / 10 : null, burnRatePctPerDay: burn, drawdownHeadroomPct: headroom },
    alpha: { livePct: isFiniteNumber(input.liveReturnPct) ? input.liveReturnPct : null, benchmarkPct: input.benchmark?.returnPct ?? null, alphaPct, label: input.benchmark?.label ?? null },
    evidence: {
      liveTrades: live.overall.trades, liveExpectancyPct: live.overall.expectancyPct, liveRecentTrades: live.recent.trades, liveRecentExpectancyPct: live.recent.expectancyPct, liveProfitFactor: live.overall.profitFactor,
      shadowTrades: shadow.overall.trades, shadowRecentTrades: shadow.recent.trades, shadowRecentExpectancyPct: shadow.recent.expectancyPct, shadowRecentProfitFactor: shadow.recent.profitFactor, sufficient,
    },
    reasons, hurdles, mandate,
  };
}

function nextHurdles(mode: SurvivalMode, input: SurvivalInput, o: SurvivalOptions, c: { ddRatio: number | null; runwayDays: number | null; alphaPct: number | null; sufficient: boolean; score: number; shadowProof: boolean }): string[] {
  const h: string[] = [];
  const maxDd = input.settings.maxDrawdownPct;
  switch (mode) {
    case "hibernation":
      if (!c.shadowProof) h.push(`${o.hibernationExitShadowTrades} recent shadow trades with expectancy above ${(o.hurdleBps / 100).toFixed(2)}%/trade and profit factor >= 1.2`);
      if (c.ddRatio !== null && c.ddRatio >= 0.5) h.push(`drawdown back under ${(maxDd * 50).toFixed(1)}%`);
      h.push(`${o.promotionDwellDays} days in hibernation`);
      break;
    case "survival":
      h.push(`recent live expectancy positive over ${Math.ceil(o.recentN / 2)}+ trades`);
      if (c.ddRatio !== null && c.ddRatio >= 0.5) h.push(`drawdown under ${(maxDd * 50).toFixed(1)}%`);
      if (c.runwayDays !== null && c.runwayDays < o.runwayCriticalDays) h.push("stop the daily burn (runway above 10 days)");
      break;
    case "probation":
      if (!c.sufficient) h.push(`${o.minTrades - input.live.overall.trades} more closed live trade(s) with positive expectancy`);
      if (c.ddRatio !== null && c.ddRatio >= 0.25) h.push(`drawdown under ${(maxDd * 25).toFixed(1)}%`);
      if (c.alphaPct !== null && c.alphaPct < 0) h.push(`outperform ${input.benchmark?.label ?? "the benchmark"} since inception`);
      if (c.score < 55) h.push(`P&L fitness >= 55 (now ${c.score})`);
      if (h.length === 0) h.push("keep recent expectancy positive with profit factor >= 1.1");
      break;
    case "earning":
      h.push("profit factor >= 1.5 overall and >= 1.3 recently, positive alpha, drawdown under 10% of the limit, fitness >= 75");
      break;
    case "thriving":
      h.push("stay above the hurdle on every trade: the mandate never relaxes further");
      break;
    default:
      break;
  }
  return h;
}

function buildMandate(mode: SurvivalMode, x: { riskMultiplier: number; minEdgeMultiplier: number; hurdleBps: number; maxNewPositions: number; reasons: string[]; hurdles: string[]; runwayDays: number | null }): string {
  const head: Record<SurvivalMode, string> = {
    thriving: "THRIVING: the account is compounding. Full risk budget; every entry must still clear its cost hurdle.",
    earning: "EARNING: the realised record is positive. Full risk budget with the standard hurdle.",
    probation: "PROBATION: the account has not proven it earns. Live size at 75%, edge hurdle x1.25, half the position slots.",
    survival: "SURVIVAL: capital is being lost. Live size at 40%, edge hurdle x1.75, at most two new positions; only the highest-conviction trades.",
    hibernation: "HIBERNATION: live entries are suspended. Every decision runs in shadow until the shadow record proves an edge; open positions are managed, not added to.",
  };
  const why = x.reasons.length ? ` Why: ${x.reasons.slice(0, 3).join("; ")}.` : "";
  const climb = x.hurdles.length ? ` To climb: ${x.hurdles.slice(0, 3).join("; ")}.` : "";
  const runway = x.runwayDays !== null ? ` Runway ${x.runwayDays.toFixed(0)} days at the current burn.` : "";
  return `${head[mode]}${why}${climb}${runway} Hurdle ${x.hurdleBps} bps net of costs.`;
}

function fmtPct(x: number | null): string {
  return isFiniteNumber(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}%` : "n/a";
}
function fmtNum(x: number | null): string {
  return isFiniteNumber(x) ? x.toFixed(2) : "n/a";
}
