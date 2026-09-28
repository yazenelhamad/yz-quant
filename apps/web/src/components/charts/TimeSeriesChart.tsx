import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TimePoint } from "../../api/types";
import { fmt } from "../../lib/fmt";
import { EmptyState } from "../States";

export type ValueKind = "money" | "pct" | "num" | "score";

export function formatValue(kind: ValueKind, v: number | null | undefined): string {
  switch (kind) {
    case "money": return fmt.money(v, { whole: Math.abs(v ?? 0) >= 1000 });
    case "pct": return fmt.pct(v, { digits: 1 });
    case "score": return fmt.num(v, 2);
    default: return fmt.num(v, 2);
  }
}

function tickFormatter(kind: ValueKind) {
  return (v: number) => (kind === "money" ? fmt.money(v, { compact: true, whole: true }) : kind === "pct" ? `${(v * 100).toFixed(0)}%` : fmt.num(v, kind === "score" ? 2 : 0));
}

function dateTick(iso: string, dense: boolean) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dense ? d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }) : d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function ChartTooltip({ active, payload, kind, label }: { active?: boolean; payload?: { value: number; name?: string; payload?: TimePoint }[]; kind: ValueKind; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <div className="t">{fmt.dateTime(label)}</div>
      {payload.map((p, i) => <div className="v" key={i}>{p.name && payload.length > 1 ? `${p.name}: ` : ""}{formatValue(kind, p.value)}</div>)}
    </div>
  );
}

/**
 * Single-series time chart (line or area). One axis, hairline grid, 2px line, area at 10% wash.
 * A table view is one click away so no value is gated behind hover.
 */
export function TimeSeriesChart({ data, kind = "num", area, height = 220, title, zeroLine, color = "var(--series-1)", emptyText }: {
  data: TimePoint[] | null | undefined;
  kind?: ValueKind;
  area?: boolean;
  height?: number;
  title?: string;
  zeroLine?: boolean;
  color?: string;
  emptyText?: string;
}) {
  const [table, setTable] = useState(false);
  const points = useMemo(() => (data ?? []).filter((p) => typeof p.value === "number" && Number.isFinite(p.value)), [data]);
  if (points.length === 0) return <EmptyState title={emptyText ?? "No data yet"} detail={title ? `${title} has no history to plot.` : undefined} />;
  const dense = points.length > 0 && (new Date(points[points.length - 1]!.time).getTime() - new Date(points[0]!.time).getTime()) < 120 * 86400_000;
  const last = points[points.length - 1]!;
  const common = {
    data: points,
    margin: { top: 8, right: 12, bottom: 4, left: 4 },
  };
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--grid)" />
      <XAxis dataKey="time" tickFormatter={(v: string) => dateTick(v, dense)} minTickGap={40} tickLine={false} axisLine={{ stroke: "var(--axis)" }} />
      <YAxis tickFormatter={tickFormatter(kind)} width={64} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
      <Tooltip content={<ChartTooltip kind={kind} />} cursor={{ stroke: "var(--axis)" }} />
      {zeroLine && <ReferenceLine y={0} stroke="var(--axis)" />}
    </>
  );
  return (
    <div className="chart">
      <div className="row between" style={{ marginBottom: 4 }}>
        <div className="small dim">{title}{title ? " · " : ""}latest <span className="num">{formatValue(kind, last.value)}</span> <span className="muted">({fmt.date(last.time)})</span></div>
        <button className="btn ghost sm" onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>
      </div>
      {table ? (
        <div className="table-wrap" style={{ maxHeight: height, overflowY: "auto" }}>
          <table className="data compact">
            <thead><tr><th>Time</th><th className="num">Value</th></tr></thead>
            <tbody>{points.map((p) => <tr key={p.time}><td>{fmt.dateTime(p.time)}</td><td className="num">{formatValue(kind, p.value)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {area ? (
            <AreaChart {...common}>
              {axes}
              <Area type="monotone" dataKey="value" name={title} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.1} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
            </AreaChart>
          ) : (
            <LineChart {...common}>
              {axes}
              <Line type="monotone" dataKey="value" name={title} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
