import { useApi } from "../api/hooks";
import type { HealthResponse } from "../api/types";
import { PageHeader } from "../components/Controls";
import { EmptyState, QueryState } from "../components/States";
import { HealthPill } from "../components/StatusPill";
import { fmt } from "../lib/fmt";

export function SystemHealthPage() {
  const q = useApi<HealthResponse>("/system/health", { refetchInterval: 15_000 });
  return (
    <>
      <PageHeader title="System health" sub="Component status across the platform. Any critical component fails trading closed." actions={q.data && <HealthPill status={q.data.overall} />} />
      <QueryState query={q} loadingLabel="Loading health" skeleton="kpis" isEmpty={(d) => d.components.length === 0} empty={<EmptyState title="No health data" />}>
        {(d) => (
          <div className="grid auto">
            {[...d.components].sort((a, b) => rank(b.status) - rank(a.status)).map((c) => (
              <div key={c.name} className={`health-card ${c.status}`}>
                <div className="row between"><strong>{fmt.label(c.name)}</strong><HealthPill status={c.status} /></div>
                <div className="small dim">{c.detail || "No detail."}</div>
                {c.metrics && Object.keys(c.metrics).length > 0 && (
                  <dl className="kv tiny" style={{ marginTop: 4 }}>{Object.entries(c.metrics).map(([k, v]) => <MetricRow key={k} k={k} v={v} />)}</dl>
                )}
                <div className="tiny muted">checked {fmt.ago(c.checkedAt)}</div>
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}

function MetricRow({ k, v }: { k: string; v: number | string | null }) {
  return <><dt>{fmt.label(k)}</dt><dd>{v === null ? "—" : typeof v === "number" ? fmt.num(v, Number.isInteger(v) ? 0 : 2) : v}</dd></>;
}

function rank(s: string): number {
  return s === "critical" ? 3 : s === "warning" ? 2 : s === "unknown" ? 1 : 0;
}
