import { useEffect, useState } from "react";
import { errorMessage, put } from "../../api/client";
import { useApi, useInvalidate } from "../../api/hooks";
import type { AgentRegistryEntry, AgentsResponse, ModelRegistryEntry, ModelsResponse } from "../../api/types";
import { Badge } from "../../components/Badge";
import { Banner, PageHeader } from "../../components/Controls";
import { Panel } from "../../components/Panel";
import { EmptyState, QueryState } from "../../components/States";
import { fmt } from "../../lib/fmt";

export function ModelsAgentsPage() {
  const models = useApi<ModelsResponse>("/admin/models");
  const agents = useApi<AgentsResponse>("/admin/agents");
  return (
    <>
      <PageHeader title="Models & agents" sub="Model routing weights and slow-brain agent influence. Weights are bounded; the learning engine may propose changes but only an admin applies them here." />
      <div className="stack">
        <Panel title="Model registry" flush>
          <QueryState query={models} loadingLabel="Loading model registry" skeleton="table">{(d) => d.models.length === 0 || !d.configured ? <EmptyState title="AI models: not configured" detail="No model provider credentials are configured on the server. The slow brain, variant perception and research agents are unavailable until this is set." /> : <ModelsTable rows={d.models} />}</QueryState>
        </Panel>
        <Panel title="Agent registry" flush>
          <QueryState query={agents} loadingLabel="Loading agent registry" skeleton="table">{(d) => d.agents.length === 0 ? <EmptyState title="No agents registered" /> : <AgentsTable rows={d.agents} />}</QueryState>
        </Panel>
      </div>
    </>
  );
}

function useEditable<T extends { name: string }>(rows: T[]) {
  const [edit, setEdit] = useState<T[]>(rows);
  useEffect(() => setEdit(rows), [rows]);
  const dirty = JSON.stringify(edit) !== JSON.stringify(rows);
  const update = (name: string, patch: Partial<T>) => setEdit((p) => p.map((r) => (r.name === name ? { ...r, ...patch } : r)));
  return { edit, dirty, update, reset: () => setEdit(rows) };
}

function SaveBar({ dirty, onSave, onReset }: { dirty: boolean; onSave: () => Promise<void>; onReset: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="form-actions" style={{ padding: "8px 14px" }}>
      {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
      <button className="btn" disabled={!dirty || busy} onClick={onReset}>Discard</button>
      <button className="btn primary" disabled={!dirty || busy} onClick={async () => { setBusy(true); setMsg(null); try { await onSave(); setMsg({ ok: true, text: "Saved." }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } finally { setBusy(false); } }}>{busy ? "Saving…" : "Save weights"}</button>
    </div>
  );
}

function ModelsTable({ rows }: { rows: ModelRegistryEntry[] }) {
  const { edit, dirty, update, reset } = useEditable(rows);
  const invalidate = useInvalidate();
  return (
    <>
      <table className="data compact">
        <thead><tr><th>Model</th><th>Provider</th><th>Role</th><th>Configured</th><th>Enabled</th><th className="num">Routing weight</th><th className="num">Cost / 1k</th><th className="num">p50 latency</th><th className="num">Failure rate</th></tr></thead>
        <tbody>{edit.map((m) => (
          <tr key={m.name}>
            <td><strong>{m.name}</strong> <span className="muted tiny">{m.version}</span></td><td>{m.provider}</td><td>{fmt.label(m.role)}</td>
            <td>{m.configured ? <Badge tone="pos">yes</Badge> : <Badge tone="warn">no</Badge>}</td>
            <td><input type="checkbox" checked={m.enabled} disabled={!m.configured} onChange={(e) => update(m.name, { enabled: e.target.checked })} /></td>
            <td className="num"><input type="number" min={0} max={1} step={0.05} value={m.routingWeight} style={{ width: 80 }} onChange={(e) => update(m.name, { routingWeight: Number(e.target.value) })} /></td>
            <td className="num">{m.costPer1kTokensUsd === null ? "—" : `$${m.costPer1kTokensUsd.toFixed(4)}`}</td><td className="num">{m.latencyMsP50 === null ? "—" : fmt.duration(m.latencyMsP50)}</td><td className="num">{fmt.score(m.failureRate, 1)}</td>
          </tr>
        ))}</tbody>
      </table>
      <SaveBar dirty={dirty} onReset={reset} onSave={async () => { await put("/admin/models", { models: edit.map((m) => ({ name: m.name, enabled: m.enabled, routingWeight: m.routingWeight })) }); await invalidate("/admin/models"); }} />
    </>
  );
}

function AgentsTable({ rows }: { rows: AgentRegistryEntry[] }) {
  const { edit, dirty, update, reset } = useEditable(rows);
  const invalidate = useInvalidate();
  return (
    <>
      <Banner tone="info">The risk officer's veto is deterministic and not weighted; influence weights affect only how much an agent's vote moves a thesis.</Banner>
      <table className="data compact">
        <thead><tr><th>Agent</th><th>Description</th><th>Model</th><th>Prompt</th><th>Enabled</th><th className="num">Influence weight</th></tr></thead>
        <tbody>{edit.map((a) => (
          <tr key={a.name}>
            <td><strong>{fmt.label(a.name)}</strong></td><td className="wrap small dim">{a.description}</td><td>{a.model ?? <span className="muted">unassigned</span>}</td><td className="mono tiny">{a.promptVersion ?? "—"}</td>
            <td><input type="checkbox" checked={a.enabled} onChange={(e) => update(a.name, { enabled: e.target.checked })} /></td>
            <td className="num"><input type="number" min={0} max={1} step={0.05} value={a.influenceWeight} style={{ width: 80 }} onChange={(e) => update(a.name, { influenceWeight: Number(e.target.value) })} /></td>
          </tr>
        ))}</tbody>
      </table>
      <SaveBar dirty={dirty} onReset={reset} onSave={async () => { await put("/admin/agents", { agents: edit.map((a) => ({ name: a.name, enabled: a.enabled, influenceWeight: a.influenceWeight })) }); await invalidate("/admin/agents"); }} />
    </>
  );
}
