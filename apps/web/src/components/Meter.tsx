import { clamp, fmt } from "../lib/fmt";

/**
 * Utilization meter: fill severity steps accent → warning → critical at 80% / 100% of the limit.
 * Renders "no limit" / "no data" explicitly rather than an empty bar that reads as zero.
 */
export function Meter({ label, used, limit, format = "pct", warnAt = 0.8 }: {
  label: string;
  used: number | null | undefined;
  limit: number | null | undefined;
  format?: "pct" | "money" | "num" | "score";
  warnAt?: number;
}) {
  const f = (n: number | null | undefined) =>
    format === "pct" ? fmt.pct(n, { digits: 1 }) : format === "money" ? fmt.money(n, { whole: true }) : format === "score" ? fmt.num(n, 2) : fmt.num(n, 0);
  const hasData = typeof used === "number" && Number.isFinite(used);
  const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const ratio = hasData && hasLimit ? used / limit : 0;
  const width = clamp(ratio, 0, 1) * 100;
  const cls = ratio >= 1 ? "crit" : ratio >= warnAt ? "warn" : "";
  return (
    <div className="meter" title={hasData && hasLimit ? `${(ratio * 100).toFixed(0)}% of limit` : undefined}>
      <div className="meter-label">{label}</div>
      <div className="meter-track" role="meter" aria-valuenow={hasData ? used : undefined} aria-valuemax={hasLimit ? limit : undefined} aria-label={label}>
        {hasData && hasLimit && <div className={`meter-fill ${cls}`} style={{ width: `${width}%` }} />}
      </div>
      <div className="meter-value">
        {!hasData ? "no data" : !hasLimit ? `${f(used)} / no limit` : `${f(used)} / ${f(limit)}`}
      </div>
    </div>
  );
}
