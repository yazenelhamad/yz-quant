import type { ReactNode } from "react";

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? "active" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={`tab ${o.value === value ? "active" : ""}`} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function KV({ items, wide }: { items: [ReactNode, ReactNode][]; wide?: boolean }) {
  return (
    <dl className={`kv ${wide ? "wide" : ""}`}>
      {items.map(([k, v], i) => (<KVRow key={i} k={k} v={v} />))}
    </dl>
  );
}
function KVRow({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <><dt>{k}</dt><dd>{v ?? <span className="muted">—</span>}</dd></>;
}

export function Banner({ tone = "info", children, action }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; action?: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"}><div className="grow">{children}</div>{action}</div>;
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/** Comma-separated symbol list <-> string[] */
export function SymbolsInput({ value, onChange, placeholder }: { value: string[] | null; onChange: (v: string[] | null) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value ? value.join(", ") : ""}
      placeholder={placeholder ?? "e.g. AAPL, MSFT"}
      onChange={(e) => {
        const t = e.target.value.trim();
        if (!t) return onChange(null);
        onChange(t.split(/[,\s]+/).map((s) => s.toUpperCase()).filter(Boolean));
      }}
    />
  );
}
