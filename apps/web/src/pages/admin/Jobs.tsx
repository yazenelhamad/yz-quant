import { useApi } from "../../api/hooks";
import type { JobRun, JobsResponse, SystemEventsResponse } from "../../api/types";
import { Badge } from "../../components/Badge";
import { Column, DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/Controls";
import { Panel } from "../../components/Panel";
import { EmptyState, QueryState } from "../../components/States";
import { fmt } from "../../lib/fmt";

export function JobsPage() {
  const q = useApi<JobsResponse>("/admin/jobs", { refetchInterval: 15_000 });
  const events = useApi<SystemEventsResponse>("/system/events?limit=100", { refetchInterval: 30_000 });
  const cols: Column<JobRun>[] = [
    { key: "started", header: "Started", render: (j) => fmt.dateTime(j.startedAt), sortValue: (j) => j.startedAt },
    { key: "name", header: "Job", render: (j) => <strong>{fmt.label(j.name)}</strong>, sortValue: (j) => j.name },
    { key: "status", header: "Status", render: (j) => <Badge tone={j.status === "succeeded" ? "pos" : j.status === "failed" ? "neg" : j.status === "running" ? "accent" : "outline"}>{j.status}</Badge>, sortValue: (j) => j.status },
    { key: "dur", header: "Duration", align: "right", render: (j) => fmt.duration(j.durationMs), sortValue: (j) => j.durationMs },
    { key: "err", header: "Error", render: (j) => j.error ? <span className="error-text truncate" style={{ maxWidth: 360, display: "inline-block" }} title={j.error}>{j.error}</span> : <span className="muted">—</span> },
  ];
  return (
    <>
      <PageHeader title="Jobs" sub="Scheduler runs: market data, trading cycle, reconciliation, learning, variant perception." />
      <div className="stack">
        <Panel title="Recent job runs" flush>
          <QueryState query={q} loadingLabel="Loading job runs" skeleton="table" isEmpty={(d) => d.jobs.length === 0} empty={<EmptyState title="No job runs yet" />}>
            {(d) => <DataTable rows={d.jobs} columns={cols} rowKey={(j) => j.id} defaultSort={{ key: "started", dir: "desc" }} compact renderExpanded={(j) => <pre className="tiny mono pre" style={{ margin: 0 }}>{j.detail ? JSON.stringify(j.detail, null, 2) : "No detail."}</pre>} />}
          </QueryState>
        </Panel>
        <Panel title="System events" flush>
          <QueryState query={events} loadingLabel="Loading system events" skeleton="list" isEmpty={(d) => d.events.length === 0} empty={<EmptyState title="No system events" />}>
            {(d) => <ul className="list" style={{ padding: "0 14px" }}>{d.events.map((e) => <li key={e.id}><Badge tone={e.level === "error" ? "neg" : e.level === "warning" ? "warn" : "outline"}>{e.level}</Badge><span className="grow"><span className="mono tiny muted">{e.source}</span> {e.message}</span><span className="when">{fmt.dateTime(e.at)}</span></li>)}</ul>}
          </QueryState>
        </Panel>
      </div>
    </>
  );
}
