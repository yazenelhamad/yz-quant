import type { StrategyDescriptor } from "../contract.js";
import { EXT_FEATURE, FEATURE, clamp, defineStrategy, eventWithin, fmtSigned, hasPosition, makeSignal, makeView, noSetup, pct, prepare, regimeAllows } from "./helpers.js";

/**
 * Event strategies depend on features supplied by the events / news / fundamentals engines.
 * When those features are absent the strategy abstains: it never infers an event from price.
 */
const EVENT_REGIMES: StrategyDescriptor["supportedRegimes"] = ["event_driven", "bull_trend", "risk_on", "range_bound", "low_volatility", "sector_rotation", "momentum"];

/* ------------------------------------------------------------------------------------------ */
/* earnings_reaction                                                                          */
/* ------------------------------------------------------------------------------------------ */
export const earningsReaction = defineStrategy(
  {
    key: "earnings_reaction",
    name: "Post-Earnings Reaction",
    family: "event",
    description: "Buys within a few days after a strong, volume-confirmed positive earnings reaction; a strong negative reaction reduces a held position.",
    supportedRegimes: EVENT_REGIMES,
    parameters: {
      minReactionPct: { default: 0.05, min: 0.02, max: 0.2, step: 0.01, description: "Minimum earnings-day move (fraction)" },
      minRelativeVolume: { default: 2, min: 1.2, max: 5, step: 0.1, description: "Minimum volume multiple on the reaction day" },
      maxDaysSince: { default: 3, min: 1, max: 10, step: 1, description: "Latest day after earnings on which to act" },
      horizonDays: { default: 15, min: 5, max: 40, step: 1, description: "Holding horizon" },
    },
    warmupBars: 25,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = earningsReaction.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const reaction = prep.f(EXT_FEATURE.earningsReactionPct);
    const daysSince = prep.f(EXT_FEATURE.earningsDaysSince);
    if (reaction === null || daysSince === null) return noSetup(`event features (${EXT_FEATURE.earningsReactionPct}, ${EXT_FEATURE.earningsDaysSince}) not supplied`, horizon);
    if (daysSince < 0 || daysSince > prep.p("maxDaysSince")) return noSetup(`earnings were ${daysSince} days ago; outside the ${prep.p("maxDaysSince")}-day reaction window`, horizon);
    const rv = prep.f(FEATURE.relativeVolume20);
    const gate = regimeAllows(ctx, d, prep, "soft");
    const minReact = prep.p("minReactionPct");
    if (reaction >= minReact) {
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      if (rv !== null && rv < prep.p("minRelativeVolume") && daysSince <= 1) return noSetup(`reaction lacks volume confirmation (${rv.toFixed(1)}x)`, horizon);
      const strength = clamp(reaction / (3 * minReact), 0.4, 1);
      const confidence = clamp(0.45 + 0.15 * clamp((reaction - minReact) / minReact, 0, 1) + 0.1 * (rv !== null && rv >= prep.p("minRelativeVolume") ? 1 : 0) + 0.1 * prep.regimeFit, 0, 1);
      const explanation = `Earnings reaction ${fmtSigned(reaction * 100, 1)}% ${daysSince} day(s) ago${rv === null ? "" : ` on ${rv.toFixed(1)}x volume`}; positioning for post-earnings drift.`;
      return { signals: [makeSignal(ctx, prep, "earnings_reaction", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (reaction <= -minReact) {
      const strength = -clamp(-reaction / (3 * minReact), 0.4, 1);
      const explanation = `Earnings reaction ${fmtSigned(reaction * 100, 1)}% ${daysSince} day(s) ago${hasPosition(ctx) ? "; negative drift risk for the held position" : ""}.`;
      return { signals: [makeSignal(ctx, prep, "earnings_reaction", strength, 0.55, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.55, horizonDays: horizon, explanation }) };
    }
    return noSetup(`earnings reaction ${fmtSigned(reaction * 100, 1)}% is not strong enough`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* earnings_drift                                                                             */
/* ------------------------------------------------------------------------------------------ */
export const earningsDrift = defineStrategy(
  {
    key: "earnings_drift",
    name: "Post-Earnings Announcement Drift",
    family: "event",
    description: "Rides the multi-week drift after a large positive earnings surprise while the post-earnings return remains positive.",
    supportedRegimes: EVENT_REGIMES,
    parameters: {
      minSurprisePct: { default: 0.05, min: 0.01, max: 0.5, step: 0.01, description: "Minimum EPS surprise (fraction)" },
      minDaysSince: { default: 2, min: 1, max: 10, step: 1, description: "Earliest day to enter" },
      maxDaysSince: { default: 40, min: 10, max: 60, step: 1, description: "Latest day to enter" },
      horizonDays: { default: 20, min: 5, max: 60, step: 5, description: "Holding horizon" },
    },
    warmupBars: 25,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = earningsDrift.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const surprise = prep.f(EXT_FEATURE.earningsSurprisePct);
    const daysSince = prep.f(EXT_FEATURE.earningsDaysSince);
    if (surprise === null || daysSince === null) return noSetup(`event features (${EXT_FEATURE.earningsSurprisePct}, ${EXT_FEATURE.earningsDaysSince}) not supplied`, horizon);
    if (daysSince < prep.p("minDaysSince") || daysSince > prep.p("maxDaysSince")) return noSetup(`earnings were ${daysSince} days ago; outside the drift window`, horizon);
    const postRet = prep.f(EXT_FEATURE.postEarningsReturn) ?? prep.f(FEATURE.ret20);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (surprise >= prep.p("minSurprisePct") && (postRet === null || postRet >= 0)) {
      if (!gate.allowed) return noSetup(gate.reason, horizon);
      const strength = clamp(surprise / (3 * prep.p("minSurprisePct")), 0.4, 1) * clamp(1 - daysSince / 60, 0.5, 1);
      const confidence = clamp(0.45 + 0.15 * clamp(surprise / 0.2, 0, 1) + 0.1 * prep.regimeFit, 0, 1);
      const explanation = `EPS surprise ${fmtSigned(surprise * 100, 1)}% ${daysSince} days ago with post-earnings return ${postRet === null ? "unknown" : fmtSigned(postRet * 100, 1) + "%"}; drift typically persists for weeks.`;
      return { signals: [makeSignal(ctx, prep, "earnings_surprise_drift", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
    }
    if (surprise <= -prep.p("minSurprisePct") && (postRet === null || postRet <= 0)) {
      const strength = -clamp(-surprise / (3 * prep.p("minSurprisePct")), 0.4, 1);
      const explanation = `EPS miss ${fmtSigned(surprise * 100, 1)}% ${daysSince} days ago with negative drift.`;
      return { signals: [makeSignal(ctx, prep, "earnings_surprise_drift", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    return noSetup(`surprise ${fmtSigned(surprise * 100, 1)}% / post-earnings return ${postRet === null ? "n/a" : fmtSigned(postRet * 100, 1) + "%"} do not support a drift`, horizon);
  },
);

/* ------------------------------------------------------------------------------------------ */
/* analyst_change                                                                             */
/* ------------------------------------------------------------------------------------------ */
export const analystChange = defineStrategy(
  {
    key: "analyst_change",
    name: "Analyst Revision",
    family: "event",
    description: "Acts on a supplied analyst revision score in [-1, 1]; abstains when the score is not provided.",
    supportedRegimes: EVENT_REGIMES,
    parameters: {
      minScore: { default: 0.5, min: 0.2, max: 0.9, step: 0.05, description: "Minimum absolute revision score" },
      horizonDays: { default: 15, min: 5, max: 40, step: 1, description: "Holding horizon" },
    },
    warmupBars: 20,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = analystChange.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const score = prep.f(EXT_FEATURE.analystRevisionScore);
    if (score === null) return noSetup(`${EXT_FEATURE.analystRevisionScore} not supplied`, horizon);
    const s = clamp(score, -1, 1);
    const min = prep.p("minScore");
    if (Math.abs(s) < min) return noSetup(`revision score ${fmtSigned(s)} below ${min}`, horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (s > 0 && !gate.allowed) return noSetup(gate.reason, horizon);
    const confidence = clamp(0.4 + 0.2 * Math.abs(s) + 0.1 * prep.regimeFit, 0, 1);
    const explanation = `Analyst revision score ${fmtSigned(s)} (${s > 0 ? "upgrades / estimate increases" : "downgrades / estimate cuts"}).`;
    return { signals: [makeSignal(ctx, prep, "analyst_revision", s, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength: s, confidence, horizonDays: horizon, explanation }) };
  },
);

/* ------------------------------------------------------------------------------------------ */
/* corporate_announcement                                                                     */
/* ------------------------------------------------------------------------------------------ */
export const corporateAnnouncement = defineStrategy(
  {
    key: "corporate_announcement",
    name: "Corporate Announcement Catalyst",
    family: "event",
    description: "Acts on a supplied catalyst score (0..1) and direction (+1/-1) from the news / filings engine; abstains otherwise.",
    supportedRegimes: EVENT_REGIMES,
    parameters: {
      minCatalyst: { default: 0.6, min: 0.3, max: 0.9, step: 0.05, description: "Minimum catalyst score" },
      horizonDays: { default: 10, min: 2, max: 30, step: 1, description: "Holding horizon" },
    },
    warmupBars: 20,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = corporateAnnouncement.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const score = prep.f(EXT_FEATURE.catalystScore);
    if (score === null) return noSetup(`${EXT_FEATURE.catalystScore} not supplied`, horizon);
    const direction = prep.f(EXT_FEATURE.catalystDirection) ?? 1;
    const c = clamp(score, 0, 1);
    if (c < prep.p("minCatalyst")) return noSetup(`catalyst score ${c.toFixed(2)} below ${prep.p("minCatalyst")}`, horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (direction > 0 && !gate.allowed) return noSetup(gate.reason, horizon);
    const strength = clamp(c, 0, 1) * (direction >= 0 ? 1 : -1);
    const confidence = clamp(0.4 + 0.25 * c + 0.1 * prep.regimeFit, 0, 1);
    const explanation = `Corporate catalyst score ${c.toFixed(2)} (${direction >= 0 ? "positive" : "negative"}) supplied by the announcement engine.`;
    return { signals: [makeSignal(ctx, prep, "catalyst_score", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
  },
);

/* ------------------------------------------------------------------------------------------ */
/* macro_release                                                                              */
/* ------------------------------------------------------------------------------------------ */
export const macroRelease = defineStrategy(
  {
    key: "macro_release",
    name: "Macro Release Awareness",
    family: "event",
    description: "Regime- and calendar-aware overlay: ahead of a scheduled macro release it produces a WAIT (flat) view, and in a risk-off or high-vol regime reduces a held position into the release. It never initiates entries.",
    supportedRegimes: [],
    parameters: {
      lookaheadDays: { default: 2, min: 1, max: 5, step: 1, description: "Days ahead in which a macro event triggers the overlay" },
      horizonDays: { default: 2, min: 1, max: 5, step: 1, description: "Horizon" },
    },
    warmupBars: 5,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = macroRelease.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const ev = eventWithin(ctx, prep.p("lookaheadDays"), ["macro", "fomc", "cpi", "fed", "payroll", "nfp", "gdp", "pce", "economic"]);
    const eventRegime = ctx.regime.primary === "event_driven" || (ctx.regime.probabilities.event_driven ?? 0) > 0.25;
    if (!ev && !eventRegime) return noSetup("no scheduled macro release within the look-ahead window", horizon);
    const hostile = ctx.regime.primary === "risk_off" || ctx.regime.primary === "high_volatility" || ctx.regime.primary === "liquidity_shock";
    const what = ev ? `${ev.kind} (${ev.description}) at ${ev.at}` : "an event-driven regime";
    if (hostile && hasPosition(ctx)) {
      const strength = -0.4;
      const explanation = `Into ${what} in a ${ctx.regime.primary} regime: trimming exposure ahead of the release.`;
      return { signals: [makeSignal(ctx, prep, "macro_event_risk", strength, 0.5, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence: 0.5, horizonDays: horizon, explanation }) };
    }
    const explanation = `Waiting: ${what} is inside the horizon; no new entries until the release has been absorbed.`;
    return {
      signals: [makeSignal(ctx, prep, "macro_event_risk", 0, 0.6, horizon, explanation)],
      view: { direction: "flat", strength: 0, confidence: 0.6, horizonDays: horizon, expectedUpsidePct: 0, expectedDownsidePct: 0, invalidationPrice: null, targetPrice: null, explanation },
    };
  },
);

/* ------------------------------------------------------------------------------------------ */
/* sector_news                                                                                */
/* ------------------------------------------------------------------------------------------ */
export const sectorNews = defineStrategy(
  {
    key: "sector_news",
    name: "Sector News Flow",
    family: "event",
    description: "Acts on a supplied sector news score in [-1, 1] combined with the name's relative strength; abstains when the score is absent.",
    supportedRegimes: EVENT_REGIMES,
    parameters: {
      minScore: { default: 0.5, min: 0.2, max: 0.9, step: 0.05, description: "Minimum absolute sector news score" },
      horizonDays: { default: 5, min: 2, max: 20, step: 1, description: "Holding horizon" },
    },
    warmupBars: 25,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = sectorNews.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const score = prep.f(EXT_FEATURE.sectorNewsScore) ?? ctx.sector?.features[EXT_FEATURE.sectorNewsScore] ?? null;
    if (score === null || !Number.isFinite(score)) return noSetup(`${EXT_FEATURE.sectorNewsScore} not supplied`, horizon);
    const s = clamp(score, -1, 1);
    if (Math.abs(s) < prep.p("minScore")) return noSetup(`sector news score ${fmtSigned(s)} below ${prep.p("minScore")}`, horizon);
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (s > 0 && !gate.allowed) return noSetup(gate.reason, horizon);
    const own = prep.f(FEATURE.ret20) ?? 0;
    const strength = clamp(s * (0.7 + 0.3 * clamp(own / 0.1, -1, 1) * Math.sign(s)), -1, 1);
    const confidence = clamp(0.4 + 0.2 * Math.abs(s) + 0.1 * prep.regimeFit, 0, 1);
    const explanation = `Sector news score ${fmtSigned(s)}${ctx.sector ? ` for ${ctx.sector.name}` : ""} with ${ctx.symbol} 20d return ${fmtSigned(own * 100, 1)}% (${pct(prep.regimeFit, 0)} regime fit).`;
    return { signals: [makeSignal(ctx, prep, "sector_news", strength, confidence, horizon, explanation)], view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation }) };
  },
);

export const EVENT_STRATEGIES = [earningsReaction, earningsDrift, analystChange, corporateAnnouncement, macroRelease, sectorNews];
