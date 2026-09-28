/** Content-shaped loading placeholders. Every skeleton carries a visible label so nothing waits unlabelled. */
export type SkeletonKind = "table" | "kpis" | "panel" | "detail" | "chart" | "list";

export function Skeleton({ kind = "panel", label = "Loading", rows = 6 }: { kind?: SkeletonKind; label?: string; rows?: number }) {
  return (
    <div className="skel" aria-busy="true" aria-live="polite">
      <div className="skel-label">{label}<span className="progress-dots" /></div>
      {kind === "kpis" && (
        <div className="skel-kpis">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="skel-kpi"><div className="sk h8 w40" /><div className="sk h20 w60" /><div className="sk h8 w25" /></div>)}
        </div>
      )}
      {kind === "table" && (
        <>
          <div className="skel-row"><div className="sk h8 w60" /><div className="sk h8" /><div className="sk h8" /><div className="sk h8" /><div className="sk h8" /></div>
          {Array.from({ length: rows }, (_, i) => <div key={i} className="skel-row"><div className="sk w80" /><div className="sk" /><div className="sk" /><div className="sk" /><div className="sk" /></div>)}
        </>
      )}
      {kind === "panel" && (<><div className="sk w40" /><div className="sk w100" /><div className="sk w80" /><div className="sk w60" /></>)}
      {kind === "list" && Array.from({ length: rows }, (_, i) => <div key={i} className="sk" style={{ width: `${55 + ((i * 17) % 40)}%` }} />)}
      {kind === "chart" && (<><div className="sk w25" /><div className="sk h120 w100" /></>)}
      {kind === "detail" && (
        <div className="skel-kpis">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="skel-kpi"><div className="sk h8 w40" /><div className="sk w100" /><div className="sk w80" /><div className="sk w60" /></div>)}
        </div>
      )}
    </div>
  );
}
