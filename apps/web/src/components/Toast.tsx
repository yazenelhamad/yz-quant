import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

export type ToastTone = "ok" | "bad" | "warn" | "info";
export interface ToastInput { tone?: ToastTone; title: string; detail?: string; ttlMs?: number }
interface ToastItem extends ToastInput { id: number; tone: ToastTone }

interface ToastCtx {
  toast: (t: ToastInput) => void;
  ok: (title: string, detail?: string) => void;
  bad: (title: string, detail?: string) => void;
  warn: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

/** Non-blocking result notices (step-up, confirmations). Auto-dismiss; errors linger longer. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((s) => s.filter((t) => t.id !== id)), []);
  const toast = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    const tone = t.tone ?? "info";
    setItems((s) => [...s.slice(-4), { ...t, id, tone }]);
    window.setTimeout(() => dismiss(id), t.ttlMs ?? (tone === "bad" ? 9000 : 4500));
  }, [dismiss]);
  const value = useMemo<ToastCtx>(() => ({
    toast,
    ok: (title, detail) => toast({ tone: "ok", title, detail }),
    bad: (title, detail) => toast({ tone: "bad", title, detail }),
    warn: (title, detail) => toast({ tone: "warn", title, detail }),
    info: (title, detail) => toast({ tone: "info", title, detail }),
  }), [toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "bad" ? "alert" : "status"}>
            <div>
              <div className="t">{t.title}</div>
              {t.detail && <div className="d">{t.detail}</div>}
            </div>
            <button className="icon-btn x" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon.Close width={14} height={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}

/** Safe variant for components that may render outside the provider (returns no-ops). */
export function useToastOptional(): ToastCtx {
  const v = useContext(Ctx);
  return v ?? { toast: () => {}, ok: () => {}, bad: () => {}, warn: () => {}, info: () => {} };
}
