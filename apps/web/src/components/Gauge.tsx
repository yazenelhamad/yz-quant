import { clamp, fmt } from "../lib/fmt";

/**
 * Half-arc gauge for a 0..1 score. Fill steps accent → warning → critical at the given thresholds.
 * The value is printed beneath; null renders an empty arc labelled "—".
 */
export function Gauge({ value, label, warnAt = 0.5, critAt = 0.8 }: { value: number | null | undefined; label: string; warnAt?: number; critAt?: number }) {
  const has = typeof value === "number" && Number.isFinite(value);
  const v = has ? clamp(value, 0, 1) : 0;
  const r = 34;
  const cx = 42;
  const cy = 42;
  const arc = (from: number, to: number) => {
    const a0 = Math.PI * (1 - from);
    const a1 = Math.PI * (1 - to);
    const x0 = cx + r * Math.cos(a0), y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    // A half-circle gauge never spans more than 180 degrees, so the SVG "large arc" flag must stay
    // 0: with it set, any value above 50% was drawn the long way round, under the gauge.
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };
  const color = v >= critAt ? "var(--crit)" : v >= warnAt ? "var(--warn)" : "var(--accent)";
  return (
    <div className="gauge" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={has ? v : undefined} aria-label={label} title={`${label}: ${has ? fmt.score(v) : "no data"}`}>
      <svg viewBox="0 0 84 46">
        <path d={arc(0, 1)} fill="none" stroke="var(--surface-3)" strokeWidth="7" strokeLinecap="round" />
        {has && v > 0 && <path d={arc(0, Math.max(0.02, v))} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" />}
      </svg>
      <div className="val">{has ? fmt.score(v) : "—"}</div>
    </div>
  );
}
