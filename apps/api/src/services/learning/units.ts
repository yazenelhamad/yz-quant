/**
 * Deep unit conversion at the API boundary: the learning / backtest / variant engines report every
 * `*Pct` value in percent points, the API contract wants fractions (0.0123 = 1.23 %). Keys ending in
 * "Pct" (and the `subsequentReturnPct` map) are divided by 100; every other value is copied as-is.
 */
export function pctFieldsToFractions<T>(value: T): T {
  return convert(value, false) as T;
}

function convert(value: unknown, parentIsPctMap: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => convert(v, parentIsPctMap));
  if (value === null || typeof value !== "object") {
    return parentIsPctMap && typeof value === "number" && Number.isFinite(value) ? value / 100 : value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.endsWith("Pct") && typeof v === "number") out[k] = Number.isFinite(v) ? v / 100 : v;
    else if (k.endsWith("Pct") && v !== null && typeof v === "object" && !Array.isArray(v)) out[k] = convert(v, true);
    else out[k] = convert(v, false);
  }
  return out;
}
