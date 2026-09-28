import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../api/client";

export function Dialog({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose?: () => void; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="dialog-head" id={id}>{title}</div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation dialog for destructive or capital-affecting actions. `onConfirm` may throw;
 * the error is shown inline and the dialog stays open.
 */
export function ConfirmDialog({ title, body, confirmLabel = "Confirm", danger, onConfirm, onCancel, requireText, reasonLabel }: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
  onCancel: () => void;
  /** When set, the user must type this exact text to enable the confirm button. */
  requireText?: string;
  /** When set, a free-text reason field is shown and required. */
  reasonLabel?: string;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = (!requireText || typed === requireText) && (!reasonLabel || reason.trim().length > 0);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={busy ? undefined : onCancel} footer={
      <>
        {err && <span className="error-text" style={{ marginRight: "auto" }}>{err}</span>}
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? "danger solid" : "primary"}`} onClick={submit} disabled={!ready || busy}>{busy ? "Working…" : confirmLabel}</button>
      </>
    }>
      {body}
      {reasonLabel && (
        <div className="field">
          <label>{reasonLabel}</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </div>
      )}
      {requireText && (
        <div className="field">
          <label>Type <code>{requireText}</code> to confirm</label>
          <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      )}
    </Dialog>
  );
}

export function Drawer({ title, children, onClose, actions }: { title: ReactNode; children: ReactNode; onClose: () => void; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div>{typeof title === "string" ? <h2>{title}</h2> : title}</div>
          <div className="row">{actions}<button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
