import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt } from "../../lib/fmt";
import { EmptyState } from "../States";

/** Monte Carlo band: p05–p95 wash with the median line. One axis, one hue. */
export function BandChart({ bands, height = 220 }: { bands: { time: string; p05: number; p50: number; p95: number }[] | null | undefined; height?: number }) {
  if (!bands || bands.length === 0) return <EmptyState title="No simulation bands" detail="The Monte Carlo result has summary statistics only; per-step bands were not provided." />;
  const data = bands.map((b) => ({ ...b, range: [b.p05, b.p95] as [number, number] }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="time" tickFormatter={(v: string) => fmt.date(v)} minTickGap={40} tickLine={false} axisLine={{ stroke: "var(--axis)" }} />
        <YAxis tickFormatter={(v: number) => fmt.money(v, { compact: true, whole: true })} width={64} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
        <Tooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0]?.payload as (typeof data)[number] | undefined;
          return (
            <div className="chart-tooltip">
              <div className="t">{fmt.date(label)}</div>
              <div className="v">p95 {fmt.money(p?.p95)}</div>
              <div className="v">median {fmt.money(p?.p50)}</div>
              <div className="v">p05 {fmt.money(p?.p05)}</div>
            </div>
          );
        }} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: "var(--text-2)" }} />
        <Area dataKey="range" name="p05–p95" stroke="none" fill="var(--series-1)" fillOpacity={0.12} isAnimationActive={false} />
        <Line dataKey="p50" name="Median" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
