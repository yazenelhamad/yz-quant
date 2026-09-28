/** Guess the display format of a risk-utilization key by its name (the API reports raw numbers). */
export function inferFormat(key: string): "pct" | "money" | "num" | "score" {
  const k = key.toLowerCase();
  if (k.includes("pct") || k.includes("exposure") || k.includes("drawdown") || k.includes("loss") || k.includes("deployed") || k.includes("sector") || (k.includes("position") && !k.includes("positions"))) return "pct";
  if (k.includes("notional") || k.includes("usd") || k.includes("capital")) return "money";
  if (k.includes("beta")) return "score";
  return "num";
}
