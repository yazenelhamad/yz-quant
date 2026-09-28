import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApiMutation } from "../api/hooks";
import type { AccountSummary, BrokerKind } from "../api/types";
import { useSession } from "../auth/SessionProvider";
import { Field, PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";

export function NoAccountsPage() {
  const navigate = useNavigate();
  const { logout } = useSession();
  const [kind, setKind] = useState<BrokerKind>("robinhood_agentic");
  const [label, setLabel] = useState("");
  const m = useApiMutation<AccountSummary>({ invalidate: ["/accounts"], onSuccess: (a) => navigate(`/a/${a.id}/settings`) });
  return (
    <div className="main" style={{ maxWidth: 560, margin: "0 auto" }}>
      <PageHeader title="No trading accounts" sub="This user has no Robinhood account registered yet. Create one to continue; connecting it to Robinhood happens in Settings." actions={<button className="btn ghost sm" onClick={() => { void logout(); }}>Sign out</button>} />
      <Panel title="Create account">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate({ path: "/accounts", body: { kind, label: label.trim() } }); }}>
          <Field label="Kind" hint={kind === "simulated" ? "Simulated accounts are for shadow research only and are always labelled SIMULATED." : "A real Robinhood account enabled for Agentic Trading."}>
            <select value={kind} onChange={(e) => setKind(e.target.value as BrokerKind)}>
              <option value="robinhood_agentic">Robinhood agentic</option>
              <option value="simulated">Simulated</option>
            </select>
          </Field>
          <Field label="Label"><input type="text" value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="e.g. Main brokerage" /></Field>
          {m.isError && <div className="error-text">{m.error.message}</div>}
          <div className="form-actions"><button className="btn primary" disabled={m.isPending || !label.trim()}>{m.isPending ? "Creating…" : "Create (requires confirmation)"}</button></div>
        </form>
      </Panel>
    </div>
  );
}
