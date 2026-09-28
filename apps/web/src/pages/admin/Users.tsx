import { useState } from "react";
import { post } from "../../api/client";
import { useApi, useInvalidate } from "../../api/hooks";
import type { AdminUser, AdminUsersResponse } from "../../api/types";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/Dialog";
import { Column, DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/Controls";
import { Panel } from "../../components/Panel";
import { QueryState } from "../../components/States";
import { fmt } from "../../lib/fmt";

export function UsersPage() {
  const q = useApi<AdminUsersResponse>("/admin/users");
  const invalidate = useInvalidate();
  const [action, setAction] = useState<{ kind: "revoke" | "mfa"; user: AdminUser } | null>(null);
  const cols: Column<AdminUser>[] = [
    { key: "name", header: "User", render: (u) => <><strong>{u.displayName}</strong> <span className="muted tiny">{u.username ?? u.email}</span></>, sortValue: (u) => u.displayName },
    { key: "role", header: "Role", render: (u) => <Badge tone={u.role === "admin" ? "accent" : "outline"}>{u.role}</Badge>, sortValue: (u) => u.role },
    { key: "mfa", header: "MFA", render: (u) => u.mfaEnabled ? <Badge tone="pos">Enabled</Badge> : <Badge tone="warn">Off</Badge>, sortValue: (u) => (u.mfaEnabled ? 1 : 0) },
    { key: "sessions", header: "Sessions", align: "right", render: (u) => fmt.int(u.sessionsCount), sortValue: (u) => u.sessionsCount },
    { key: "accounts", header: "Accounts", render: (u) => u.accounts?.length ? u.accounts.map((a) => <span className="tag" key={a.id}>{a.label}{a.kind === "simulated" ? " (sim)" : ""}</span>) : <span className="muted">—</span> },
    { key: "last", header: "Last login", render: (u) => u.lastLoginAt ? fmt.ago(u.lastLoginAt) : "never", sortValue: (u) => u.lastLoginAt },
    { key: "created", header: "Created", render: (u) => fmt.date(u.createdAt), sortValue: (u) => u.createdAt },
    { key: "x", header: "", render: (u) => <span className="row"><button className="btn sm" onClick={() => setAction({ kind: "revoke", user: u })}>Revoke sessions</button><button className="btn sm danger" onClick={() => setAction({ kind: "mfa", user: u })}>Reset MFA</button></span> },
  ];
  return (
    <>
      <PageHeader title="Users" sub="Operator-provisioned accounts. There is no sign-up; add users with npm run bootstrap." />
      <Panel flush>
        <QueryState query={q} loadingLabel="Loading users" skeleton="table">{(d) => <DataTable rows={d.users} columns={cols} rowKey={(u) => u.id} />}</QueryState>
      </Panel>
      {action?.kind === "revoke" && <ConfirmDialog title={`Revoke all sessions for ${action.user.displayName}`} confirmLabel="Revoke" body={<p>The user is signed out everywhere and must log in again.</p>} onCancel={() => setAction(null)} onConfirm={async () => { await post(`/admin/users/${encodeURIComponent(action.user.id)}/sessions/revoke`); await invalidate("/admin/users"); setAction(null); }} />}
      {action?.kind === "mfa" && <ConfirmDialog title={`Reset MFA for ${action.user.displayName}`} danger confirmLabel="Reset MFA" requireText={action.user.username ?? action.user.email ?? action.user.displayName} body={<p>MFA is disabled for this user until they enrol again. Requires identity confirmation.</p>} onCancel={() => setAction(null)} onConfirm={async () => { await post(`/admin/users/${encodeURIComponent(action.user.id)}/mfa/reset`); await invalidate("/admin/users"); setAction(null); }} />}
    </>
  );
}
