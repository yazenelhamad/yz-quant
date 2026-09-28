import { useState } from "react";
import { qs } from "../../api/client";
import { useApi } from "../../api/hooks";
import { AUDIT_CATEGORIES, type AdminUsersResponse, type AuditEvent, type AuditResponse } from "../../api/types";
import { useAccount } from "../../app/AccountContext";
import { Badge } from "../../components/Badge";
import { Column, DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/Controls";
import { Panel } from "../../components/Panel";
import { EmptyState, QueryState } from "../../components/States";
import { fmt } from "../../lib/fmt";

export function AuditPage() {
  const { accountId } = useAccount();
  const users = useApi<AdminUsersResponse>("/admin/users");
  const [f, setF] = useState({ userId: "", accountId: "", category: "", limit: 200 });
  const q = useApi<AuditResponse>(`/audit${qs(f)}`);
  const cols: Column<AuditEvent>[] = [
    { key: "at", header: "At", render: (e) => fmt.dateTime(e.at), sortValue: (e) => e.at },
    { key: "cat", header: "Category", render: (e) => <Badge tone="outline">{fmt.label(e.category)}</Badge>, sortValue: (e) => e.category },
    { key: "action", header: "Action", render: (e) => <span className="mono small">{e.action}</span>, sortValue: (e) => e.action },
    { key: "result", header: "Result", render: (e) => <Badge tone={e.result === "ok" ? "pos" : e.result === "error" ? "neg" : e.result === "rejected" ? "warn" : "default"}>{e.result}</Badge>, sortValue: (e) => e.result },
    { key: "user", header: "User", render: (e) => e.userId ? (users.data?.users.find((u) => u.id === e.userId)?.displayName ?? <span className="mono tiny">{e.userId}</span>) : <span className="muted">—</span> },
    { key: "actor", header: "Actor", render: (e) => e.actorUserId && e.actorUserId !== e.userId ? (users.data?.users.find((u) => u.id === e.actorUserId)?.displayName ?? <span className="mono tiny">{e.actorUserId}</span>) : <span className="muted">same</span> },
    { key: "account", header: "Account", render: (e) => e.brokerAccountId ? <span className="mono tiny">{e.brokerAccountId}</span> : <span className="muted">—</span> },
    { key: "refs", header: "Refs", render: (e) => <span className="tiny muted">{[e.tradeId && `trade ${e.tradeId}`, e.orderId && `order ${e.orderId}`, e.strategyId && `strategy ${e.strategyId}`].filter(Boolean).join(" · ") || "—"}</span> },
    { key: "ip", header: "IP", render: (e) => <span className="mono tiny">{e.ip ?? "—"}</span> },
  ];
  return (
    <>
      <PageHeader title="Audit log" sub="Every authentication, setting, order, risk and admin event. Admins see all users; traders see their own." />
      <Panel flush title={
        <div className="row">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All categories</option>{AUDIT_CATEGORIES.map((c) => <option key={c} value={c}>{fmt.label(c)}</option>)}</select>
          <select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">All users</option>{users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
          <label className="check small"><input type="checkbox" checked={f.accountId === accountId} onChange={(e) => setF({ ...f, accountId: e.target.checked ? accountId : "" })} /> Current account only</label>
          <select value={f.limit} onChange={(e) => setF({ ...f, limit: Number(e.target.value) })}>{[100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n} rows</option>)}</select>
        </div>
      }>
        <QueryState query={q} isEmpty={(d) => d.events.length === 0} empty={<EmptyState title="No audit events match" />}>
          {(d) => <DataTable rows={d.events} columns={cols} rowKey={(e) => e.id} defaultSort={{ key: "at", dir: "desc" }} compact renderExpanded={(e) => (
            <div className="grid cols-2">
              <div><h3>Detail</h3><pre className="tiny mono pre" style={{ margin: 0 }}>{JSON.stringify(e.detail, null, 2)}</pre></div>
              <div>{e.error && <><h3>Error</h3><div className="error-text pre">{e.error}</div></>}</div>
            </div>
          )} />}
        </QueryState>
      </Panel>
    </>
  );
}
