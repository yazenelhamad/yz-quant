import { useId } from "react";

/**
 * 30-point micro line. Renders ONLY real history; when fewer than two finite points exist it draws a
 * flat placeholder explicitly labelled "no history yet" so an empty series never looks like a flat market.
 */
export function Sparkline({ points, width = 120, height = 28, tone = "accent", label, loading }: {
  points: (number | null | undefined)[] | null | undefined;
  width?: number;
  height?: number;
  tone?: "accent" | "pos" | "neg" | "muted";
  label?: string;
  /** True while the history request is in flight: shows a shimmer instead of claiming "no history". */
  loading?: boolean;
}) {
  const id = useId();
  const vals = (points ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(-30);
  if (loading && vals.length < 2) {
    return <div className="kpi-spark" aria-busy="true" aria-label={`${label ?? "history"}: loading`}><div className="sk h8 w100" style={{ marginTop: 10 }} /><span className="nohist">loading history…</span></div>;
  }
  if (vals.length < 2) {
    return (
      <div className="kpi-spark" aria-label={`${label ?? "history"}: no history yet`}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
          <line x1="0" y1={height - 6} x2={width} y2={height - 6} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
        </svg>
        <span className="nohist">no history yet</span>
      </div>
    );
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const px = (i: number) => (i / (vals.length - 1)) * width;
  const py = (v: number) => height - 3 - ((v - min) / span) * (height - 8);
  const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const area = `${d} L${width},${height} L0,${height} Z`;
  const stroke = tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : tone === "muted" ? "var(--series-muted)" : "var(--accent)";
  const last = vals[vals.length - 1]!;
  const first = vals[0]!;
  return (
    <div className="kpi-spark" role="img" aria-label={`${label ?? "history"}: ${vals.length} points, ${first >= last ? "down" : "up"} over the period`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={stroke} stopOpacity="0.22" /><stop offset="1" stopColor={stroke} stopOpacity="0" /></linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={px(vals.length - 1)} cy={py(last)} r="2" fill={stroke} />
      </svg>
    </div>
  );
}
