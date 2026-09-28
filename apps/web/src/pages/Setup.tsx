import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage, get, post } from "../api/client";

interface UserForm { email: string; displayName: string; role: "admin" | "trader"; password: string }

/**
 * One-time first-run setup for headless deployments. The API only accepts it while no users exist
 * and the operator configured SETUP_TOKEN; afterwards the route answers 410 and this page says so.
 * This is not a sign-up page.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [users, setUsers] = useState<UserForm[]>([
    { email: "", displayName: "", role: "admin", password: "" },
    { email: "", displayName: "", role: "trader", password: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  useEffect(() => {
    get<{ available: boolean }>("/setup").then((r) => setAvailable(r.available)).catch(() => setAvailable(false));
  }, []);

  const update = (i: number, patch: Partial<UserForm>) => setUsers((u) => u.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const payload = { token: token.trim(), users: users.filter((u) => u.email.trim()).map((u) => ({ ...u, email: u.email.trim(), displayName: u.displayName.trim() || u.email.trim() })) };
      const r = await post<{ ok: true; created: string[] }>("/setup", payload);
      setDone(r.created);
    } catch (ex) {
      setErr(errorMessage(ex));
      setBusy(false);
    }
  };

  if (available === null) return <div className="login-wrap"><div className="login-card"><div className="wordmark">yz-quant<span>first-run setup</span></div><div className="muted">Checking…</div></div></div>;
  if (available === false && !done) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="wordmark">yz-quant<span>first-run setup</span></div>
          <div className="muted">Setup is closed: users already exist, or no setup token was configured on the server.</div>
          <button type="button" className="btn primary" onClick={() => navigate("/login")}>Go to sign in</button>
        </div>
      </div>
    );
  }
  if (done) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="wordmark">yz-quant<span>first-run setup</span></div>
          <div>Created: {done.join(", ")}. Setup is now permanently closed.</div>
          <div className="hint">Next: sign in, enrol MFA under Settings → Security, then connect your Robinhood Agentic account.</div>
          <button type="button" className="btn primary" onClick={() => navigate("/login")}>Sign in</button>
        </div>
      </div>
    );
  }
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="wordmark">yz-quant<span>first-run setup</span></div>
        <div className="hint">Enter the setup token you chose when deploying, then the two authorised users. This page works once and then disables itself.</div>
        <div className="field">
          <label htmlFor="token">Setup token</label>
          <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
        </div>
        {users.map((u, i) => (
          <fieldset key={i} className="field" style={{ border: "1px solid var(--border, #333)", padding: 12, borderRadius: 6 }}>
            <legend>{i === 0 ? "User A" : "User B"}</legend>
            <div className="field"><label>Email</label><input type="email" autoComplete="off" value={u.email} onChange={(e) => update(i, { email: e.target.value })} required={i === 0} /></div>
            <div className="field"><label>Display name</label><input type="text" autoComplete="off" value={u.displayName} onChange={(e) => update(i, { displayName: e.target.value })} /></div>
            <div className="field"><label>Role</label>
              <select value={u.role} onChange={(e) => update(i, { role: e.target.value as UserForm["role"] })}><option value="admin">admin</option><option value="trader">trader</option></select>
            </div>
            <div className="field"><label>Password</label><input type="password" autoComplete="new-password" value={u.password} onChange={(e) => update(i, { password: e.target.value })} required={i === 0} /><div className="hint">At least 12 characters mixing three of: lowercase, uppercase, digits, symbols.</div></div>
          </fieldset>
        ))}
        {err && <div className="error-text" role="alert">{err}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create users"}</button>
        <div className="tiny muted">At least one user must be an admin. Accounts cannot be created any other way.</div>
      </form>
    </div>
  );
}
