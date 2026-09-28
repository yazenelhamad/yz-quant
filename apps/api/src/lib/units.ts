/**
 * Unit conventions at the API boundary.
 *
 * - API responses and RiskSettings use FRACTIONS for every `*Pct` field (0.0123 = 1.23%).
 * - Core risk / portfolio / sizing engines use fractions.
 * - Core learning, backtest and variant engines use PERCENT POINTS (1.23 = 1.23%) and bps for slippage.
 * Convert explicitly at the boundary with these helpers; never pass a value across without knowing its unit.
 */
export const pctPointsToFraction = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v / 100);
export const fractionToPctPoints = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v * 100);
export const bpsToFraction = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v / 10_000);
