import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CalibrationProfile } from "../../api/types";
import { fmt } from "../../lib/fmt";
import { EmptyState } from "../States";

/**
 * Predicted vs observed hit-rate per confidence bucket. Two series (grouped bars) + legend;
 * bars are thin, rounded at the data end, and the table view carries every value.
 */
export function CalibrationChart({ profile, height = 200 }: { profile: CalibrationProfile | null | undefined; height?: number }) {
  const [table, setTable] = useState(false);
  const buckets = (profile?.buckets ?? []).filter((b) => b.predictions > 0);
  if (!profile || buckets.length === 0) {
    return <EmptyState title="No calibration data yet" detail="Calibration needs resolved predictions to compare against outcomes." />;
  }
  const data = buckets.map((b) => ({
    bucket: `${Math.round(b.lower * 100)}–${Math.round(b.upper * 100)}%`,
    predicted: b.predicted,
    observed: b.observed,
    n: b.predictions,
  }));
  return (
    <div className="chart">
      <div className="row between" style={{ marginBottom: 4 }}>
        <div className="small dim">
          n={fmt.int(profile.sampleSize)} · Brier {fmt.num(profile.brierScore, 3)} · ECE {fmt.num(profile.expectedCalibrationError, 3)}
          {typeof profile.overconfidenceRatio === "number" && <> · {profile.overconfidenceRatio > 1.05 ? <span className="warn-text">overconfident ({fmt.ratio(profile.overconfidenceRatio)})</span> : profile.overconfidenceRatio < 0.95 ? <span>underconfident ({fmt.ratio(profile.overconfidenceRatio)})</span> : <span>well calibrated</span>}</>}
        </div>
        <button className="btn ghost sm" onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>
      </div>
      {table ? (
        <table className="data compact">
          <thead><tr><th>Bucket</th><th className="num">Predictions</th><th className="num">Predicted</th><th className="num">Observed</th><th className="num">Gap</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.bucket}>
                <td>{d.bucket}</td><td className="num">{fmt.int(d.n)}</td><td className="num">{fmt.score(d.predicted, 1)}</td><td className="num">{fmt.score(d.observed, 1)}</td>
                <td className="num">{typeof d.observed === "number" && typeof d.predicted === "number" ? fmt.signed((d.observed - d.predicted) * 100, 1) + " pp" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barGap={2} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="bucket" tickLine={false} axisLine={{ stroke: "var(--axis)" }} />
            <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} width={40} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as (typeof data)[number] | undefined;
                return (
                  <div className="chart-tooltip">
                    <div className="t">Confidence {label} · n={row ? fmt.int(row.n) : "—"}</div>
                    <div className="v">Predicted {fmt.score(row?.predicted, 1)}</div>
                    <div className="v">Observed {fmt.score(row?.observed, 1)}</div>
                  </div>
                );
              }}
            />
            <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: "var(--text-2)" }} />
            <Bar dataKey="predicted" name="Predicted" fill="var(--series-muted)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
            <Bar dataKey="observed" name="Observed" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
