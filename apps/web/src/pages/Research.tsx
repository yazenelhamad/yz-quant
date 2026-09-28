import { useState } from "react";
import { useApi, useApiMutation } from "../api/hooks";
import type { CreateExperimentBody, Experiment, ExperimentsResponse, SharedStrategiesResponse } from "../api/types";
import { useUser } from "../auth/SessionProvider";
import { Badge } from "../components/Badge";
import { Column, DataTable } from "../components/DataTable";
import { Banner, Field, PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { fmt } from "../lib/fmt";

export function ResearchPage() {
  const user = useUser();
  const q = useApi<ExperimentsResponse>("/research/experiments");
  const strategies = useApi<SharedStrategiesResponse>("/strategies");
  const [form, setForm] = useState<CreateExperimentBody>({ title: "", hypothesis: "", strategyKey: null, method: "" });
  const create = useApiMutation<Experiment, CreateExperimentBody>({ invalidate: ["/research/experiments"], onSuccess: () => setForm({ title: "", hypothesis: "", strategyKey: null, method: "" }) });

  const cols: Column<Experiment>[] = [
    { key: "title", header: "Experiment", render: (e) => <><strong>{e.title}</strong><div className="dim small">{e.hypothesis}</div></>, sortValue: (e) => e.title, wrap: true },
    { key: "strategy", header: "Strategy", render: (e) => e.strategyKey ? <span className="mono small">{e.strategyKey}</span> : <span className="muted">—</span>, sortValue: (e) => e.strategyKey },
    { key: "status", header: "Status", render: (e) => <Badge tone={e.status === "completed" ? "pos" : e.status === "running" ? "accent" : e.status === "abandoned" ? "default" : "outline"}>{e.status}</Badge>, sortValue: (e) => e.status },
    { key: "by", header: "Created by", render: (e) => `${fmt.label(e.createdBy.kind)}${e.createdBy.displayName ? ` · ${e.createdBy.displayName}` : ""}` },
    { key: "updated", header: "Updated", render: (e) => fmt.dateTime(e.updatedAt), sortValue: (e) => e.updatedAt },
  ];

  return (
    <>
      <PageHeader title="Research" sub="Experiments and hypotheses for the shared intelligence stack." />
      <div className="stack">
        <Banner tone="info">Research cannot trade. Experiments produce evidence for promotion reviews; nothing here places orders or changes a live account.</Banner>
        <div className="grid cols-3">
          <div className="span-2">
            <Panel title="Experiments" flush>
              <QueryState query={q} isEmpty={(d) => d.experiments.length === 0} empty={<EmptyState title="No experiments yet" />}>
                {(d) => <DataTable rows={d.experiments} columns={cols} rowKey={(e) => e.id} defaultSort={{ key: "updated", dir: "desc" }} renderExpanded={(e) => (
                  <div className="grid cols-2">
                    <div><h3>Method</h3><div className="pre small">{e.method || <span className="muted">Not described.</span>}</div></div>
                    <div><h3>Conclusion</h3><div className="pre small">{e.conclusion || <span className="muted">No conclusion yet.</span>}</div></div>
                  </div>
                )} />}
              </QueryState>
            </Panel>
          </div>
          <Panel title="New experiment">
            {user.role !== "admin" ? <EmptyState title="Admin only" detail="Creating experiments is restricted to the admin role." /> : (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate({ path: "/research/experiments", body: { ...form, method: form.method || null } }); }}>
                <Field label="Title"><input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></Field>
                <Field label="Hypothesis"><textarea value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} required /></Field>
                <Field label="Strategy (optional)">
                  <select value={form.strategyKey ?? ""} onChange={(e) => setForm({ ...form, strategyKey: e.target.value || null })}>
                    <option value="">—</option>
                    {strategies.data?.strategies.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Method (optional)"><textarea value={form.method ?? ""} onChange={(e) => setForm({ ...form, method: e.target.value })} /></Field>
                {create.isError && <div className="error-text">{create.error.message}</div>}
                {create.isSuccess && <div className="ok-text">Experiment created.</div>}
                <div className="form-actions"><button className="btn primary" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create experiment"}</button></div>
              </form>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
