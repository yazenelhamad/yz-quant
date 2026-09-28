import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { errorMessage, isApiError, post } from "../api/client";
import type { LoginResponse } from "../api/types";
import { useSession } from "../auth/SessionProvider";

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [step, setStep] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const next = params.get("next");
  const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const finish = async () => {
    await refresh();
    navigate(dest, { replace: true });
  };

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await post<LoginResponse>("/auth/login", { identifier: email.trim(), password });
      if (r.mfaRequired) { setStep("mfa"); setBusy(false); return; }
      await finish();
    } catch (ex) {
      setErr(isApiError(ex) && ex.status === 423 ? "This account is locked. Contact the operator." : isApiError(ex) && ex.status === 429 ? "Too many attempts. Wait a moment and try again." : errorMessage(ex));
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await post("/auth/mfa/verify", { code: code.trim() });
      await finish();
    } catch (ex) {
      setErr(errorMessage(ex));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={step === "credentials" ? submitCredentials : submitMfa}>
        <div className="wordmark">yz-quant<span>private access</span></div>
        {step === "credentials" ? (
          <>
            <div className="field">
              <label htmlFor="email">Username or email</label>
              <input id="email" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="code">Authenticator or recovery code</label>
            <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            <div className="hint">Multi-factor authentication is enabled for this account.</div>
          </div>
        )}
        {err && <div className="error-text" role="alert">{err}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Signing in…" : step === "credentials" ? "Sign in" : "Verify"}</button>
        {step === "mfa" && <button type="button" className="btn ghost sm" onClick={() => { setStep("credentials"); setCode(""); setErr(null); }}>Back</button>}
        <div className="tiny muted">Accounts are provisioned by the operator. There is no sign-up.</div>
      </form>
    </div>
  );
}
