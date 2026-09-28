import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiHandlers, errorMessage, post } from "../api/client";
import type { StepUpResponse } from "../api/types";
import { Dialog } from "../components/Dialog";
import { useSession } from "./SessionProvider";
import { useToastOptional } from "../components/Toast";

interface StepUpCtx {
  /** Prompt for password (+ MFA) now. Resolves true on success, false when cancelled. */
  requestStepUp: (reason?: string) => Promise<boolean>;
  /** Prompt only when the current step-up window has (nearly) expired. */
  ensureFresh: (reason?: string) => Promise<boolean>;
  /** True while the last step-up is still valid. */
  isFresh: () => boolean;
}

const Ctx = createContext<StepUpCtx | null>(null);

interface Pending { reason: string; resolve: (ok: boolean) => void; promise: Promise<boolean> }

/**
 * Global step-up flow. The fetch wrapper calls `apiHandlers.onStepUpRequired` on 428; we show
 * one dialog, and concurrent 428s share the same promise so the user is asked once.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { session, refresh } = useSession();
  const toast = useToastOptional();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const requestStepUp = useCallback((reason?: string) => {
    if (pendingRef.current) return pendingRef.current.promise;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });
    const p: Pending = { reason: reason ?? "This action needs a fresh confirmation of your identity.", resolve, promise };
    pendingRef.current = p;
    setPending(p);
    return promise;
  }, []);

  const isFresh = useCallback(() => {
    const until = session?.stepUpValidUntil;
    if (!until) return false;
    return new Date(until).getTime() - Date.now() > 20_000;
  }, [session?.stepUpValidUntil]);

  const ensureFresh = useCallback((reason?: string) => (isFresh() ? Promise.resolve(true) : requestStepUp(reason)), [isFresh, requestStepUp]);

  useEffect(() => {
    apiHandlers.onStepUpRequired = (reason) => requestStepUp(reason);
    return () => { apiHandlers.onStepUpRequired = async () => false; };
  }, [requestStepUp]);

  const settle = (ok: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(ok);
  };

  const value = useMemo(() => ({ requestStepUp, ensureFresh, isFresh }), [requestStepUp, ensureFresh, isFresh]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {pending && (
        <StepUpDialog
          reason={pending.reason}
          mfaEnabled={session?.user.mfaEnabled ?? false}
          onCancel={() => { toast.warn("Confirmation cancelled", "The action was not performed."); settle(false); }}
          onDone={async () => { await refresh(); toast.ok("Identity confirmed", "Step-up is valid for about 10 minutes."); settle(true); }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useStepUp(): StepUpCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStepUp outside StepUpProvider");
  return v;
}

export function StepUpDialog({ reason, mfaEnabled, onCancel, onDone }: { reason: string; mfaEnabled: boolean; onCancel: () => void; onDone: () => Promise<void> | void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await post<StepUpResponse>("/auth/step-up", { password, ...(code.trim() ? { code: code.trim() } : {}) }, { _stepUpRetried: true });
      await onDone();
    } catch (ex) {
      setErr(errorMessage(ex));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Confirm it's you" onClose={busy ? undefined : onCancel}>
      <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
        <p className="dim">{reason}</p>
        <div className="field">
          <label htmlFor="su-pw">Password</label>
          <input id="su-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="su-code">{mfaEnabled ? "Authenticator code" : "Authenticator code (if enabled)"}</label>
          <input id="su-code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required={mfaEnabled} placeholder="123456" />
        </div>
        {err && <div className="error-text" role="alert">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !password}>{busy ? "Confirming…" : "Confirm"}</button>
        </div>
      </form>
    </Dialog>
  );
}
