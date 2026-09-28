import { EXT_FEATURE, FEATURE, clamp, defineStrategy, fmtSigned, makeSignal, makeView, noSetup, pct, prepare, regimeAllows } from "./helpers.js";

/**
 * Options / volatility view. The strategy consumes implied-volatility features supplied by the
 * options engine (iv_percentile, expected_move, term_structure_slope, skew). It never derives
 * implied volatility from price: when any input is missing it abstains.
 *
 * Interpretation for a long-only equity account: cheap, calm volatility (low IV percentile,
 * contango term structure, flat skew, implied move <= realised) is a supportive backdrop; rich,
 * stressed volatility (high IV percentile, backwardation, steep put skew) argues for waiting or
 * reducing a held position. The signals are also the inputs for any future defined-risk option
 * overlay.
 */
export const optionsVolatility = defineStrategy(
  {
    key: "options_volatility",
    name: "Options-Implied Volatility View",
    family: "options_volatility",
    description: "Forms a volatility view from supplied IV percentile, expected move, term-structure slope and skew. Abstains without all four inputs; never invents implied volatility.",
    supportedRegimes: [],
    parameters: {
      richPercentile: { default: 80, min: 60, max: 95, step: 1, description: "IV percentile above which volatility is rich" },
      cheapPercentile: { default: 25, min: 5, max: 40, step: 1, description: "IV percentile below which volatility is cheap" },
      horizonDays: { default: 10, min: 2, max: 30, step: 1, description: "Horizon" },
    },
    warmupBars: 25,
    interval: "day",
    needsUniverse: false,
  },
  (ctx) => {
    const d = optionsVolatility.descriptor;
    const r = prepare(ctx, d);
    if (!r.ok) return r.output;
    const { prep } = r;
    const horizon = prep.p("horizonDays");
    const ivPct = prep.f(EXT_FEATURE.ivPercentile);
    const expMove = prep.f(EXT_FEATURE.expectedMove);
    const term = prep.f(EXT_FEATURE.termStructureSlope);
    const skew = prep.f(EXT_FEATURE.skew);
    const missing: string[] = [];
    if (ivPct === null) missing.push(EXT_FEATURE.ivPercentile);
    if (expMove === null) missing.push(EXT_FEATURE.expectedMove);
    if (term === null) missing.push(EXT_FEATURE.termStructureSlope);
    if (skew === null) missing.push(EXT_FEATURE.skew);
    if (missing.length > 0 || ivPct === null || expMove === null || term === null || skew === null) {
      return noSetup(`options features missing (${missing.join(", ")}); implied volatility is never inferred from price`, horizon);
    }
    const gate = regimeAllows(ctx, d, prep, "soft");
    if (!gate.allowed) return noSetup(gate.reason, horizon);
    const rich = prep.p("richPercentile");
    const cheap = prep.p("cheapPercentile");
    // Each component in [-1, 1]; positive = supportive for holding / adding equity exposure.
    const ivComponent = ivPct >= rich ? -clamp((ivPct - rich) / (100 - rich) + 0.4, 0, 1) : ivPct <= cheap ? clamp((cheap - ivPct) / cheap + 0.4, 0, 1) : 0;
    const termComponent = clamp(term / 0.1, -1, 1); // >0 contango (calm), <0 backwardation (stress)
    const skewComponent = -clamp(skew / 0.15, -1, 1); // steep put skew => negative
    const realised = prep.f(FEATURE.realizedVol20);
    const impliedVsRealised = realised === null || realised <= 0 ? 0 : clamp((realised - expMove) / Math.max(realised, 1e-9), -1, 1); // implied move above realised => negative
    const strength = clamp(0.4 * ivComponent + 0.25 * termComponent + 0.2 * skewComponent + 0.15 * impliedVsRealised, -1, 1);
    const confidence = clamp(0.4 + 0.2 * Math.abs(strength) + 0.1 * prep.regimeFit, 0, 1);
    const explanation = `IV percentile ${ivPct.toFixed(0)} (${ivPct >= rich ? "rich" : ivPct <= cheap ? "cheap" : "mid"}), term-structure slope ${fmtSigned(term, 3)} (${term >= 0 ? "contango" : "backwardation"}), skew ${fmtSigned(skew, 3)}, implied move ${pct(expMove, 1)} vs realised ${realised === null ? "n/a" : pct(realised, 1)}.`;
    const signals = [
      makeSignal(ctx, prep, "iv_percentile", ivComponent, confidence, horizon, `IV percentile ${ivPct.toFixed(0)}`),
      makeSignal(ctx, prep, "vol_term_structure", termComponent, confidence, horizon, `Term-structure slope ${fmtSigned(term, 3)}`),
      makeSignal(ctx, prep, "vol_skew", skewComponent, confidence, horizon, `Skew ${fmtSigned(skew, 3)}`),
      makeSignal(ctx, prep, "implied_vs_realised", impliedVsRealised, confidence, horizon, `Implied move ${pct(expMove, 1)} vs realised ${realised === null ? "n/a" : pct(realised, 1)}`),
    ];
    if (Math.abs(strength) < 0.15) {
      return { signals, view: { direction: "flat", strength: 0, confidence: confidence * 0.5, horizonDays: horizon, expectedUpsidePct: 0, expectedDownsidePct: 0, invalidationPrice: null, targetPrice: null, explanation: `Volatility backdrop is neutral. ${explanation}` } };
    }
    return { signals, view: makeView(ctx, prep, { strength, confidence, horizonDays: horizon, explanation: `${strength > 0 ? "Volatility is cheap and calm: supportive backdrop." : "Volatility is rich or stressed: wait or trim."} ${explanation}` }) };
  },
);

export const OPTIONS_STRATEGIES = [optionsVolatility];
