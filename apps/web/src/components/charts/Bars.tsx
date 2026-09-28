import { clamp, fmt } from "../../lib/fmt";
import type { EnsembleComponent } from "../../api/types";

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

/**
 * Part-to-whole bar (e.g. regime probabilities). At most four coloured slots; the rest fold
 * into "Other" in the muted tone. A legend with values sits beneath so colour is never alone.
 */
export function ShareBar({ parts, format = (v) => fmt.score(v, 0) }: { parts: { label: string; value: number }[]; format?: (v: number) => string }) {
  const sorted = [...parts].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 4);
  const rest = sorted.slice(4).reduce((s, p) => s + p.value, 0);
  const total = sorted.reduce((s, p) => s + p.value, 0) || 1;
  const segs = [...top.map((p, i) => ({ ...p, color: SERIES[i]! })), ...(rest > 0 ? [{ label: "Other", value: rest, color: "var(--series-muted)" }] : [])];
  if (segs.length === 0) return <div className="muted small">No distribution.</div>;
  return (
    <div>
      <div className="stacked-bar" role="img" aria-label={segs.map((s) => `${s.label} ${format(s.value)}`).join(", ")}>
        {segs.map((s) => <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${fmt.label(s.label)} ${format(s.value)}`} />)}
      </div>
      <div className="chart-legend" style={{ marginTop: 6 }}>
        {segs.map((s) => <span key={s.label}><i className="swatch" style={{ background: s.color }} />{fmt.label(s.label)} <span className="num">{format(s.value)}</span></span>)}
      </div>
    </div>
  );
}

/** Horizontal bar list for a probability distribution or ranked scores (single hue). */
export function HBarList({ items, max, format = (v) => fmt.score(v, 0), highlight }: {
  items: { label: string; value: number | null }[];
  max?: number;
  format?: (v: number) => string;
  highlight?: string;
}) {
  const m = max ?? Math.max(1e-9, ...items.map((i) => Math.abs(i.value ?? 0)));
  return (
    <div>
      {items.map((it) => (
        <div className="hbar-row" key={it.label}>
          <span className={`truncate ${highlight === it.label ? "" : "dim"}`} style={{ fontWeight: highlight === it.label ? 600 : 400 }}>{fmt.label(it.label)}</span>
          <div className="track"><div className={`fill ${highlight && highlight !== it.label ? "muted" : ""}`} style={{ width: `${it.value === null ? 0 : clamp(Math.abs(it.value) / m, 0, 1) * 100}%` }} /></div>
          <span className="val">{it.value === null ? "—" : format(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Signed contribution list ("Momentum +0.61 … Final expected edge +0.49"). Bars grow from a
 * centre baseline; positive in series-1, negative in series-2 (identity, not P&L semantics).
 */
export function ContributionList({ components, total, totalLabel = "Final expected edge" }: { components: EnsembleComponent[]; total: number | null; totalLabel?: string }) {
  const m = Math.max(1e-9, Math.abs(total ?? 0), ...components.map((c) => Math.abs(c.contribution)));
  const bar = (v: number) => {
    const w = (Math.abs(v) / m) * 50;
    return <div className="bar"><i className={v < 0 ? "neg" : ""} style={v < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }} /></div>;
  };
  return (
    <div>
      {components.map((c) => (
        <div className="contrib" key={c.key} title={`weight ${fmt.num(c.weight, 2)} × value ${fmt.signed(c.value)} · cluster ${c.cluster}`}>
          <span className="truncate dim">{fmt.label(c.key)}</span>
          {bar(c.contribution)}
          <span className="num right">{fmt.signed(c.contribution)}</span>
        </div>
      ))}
      <div className="contrib total">
        <span>{totalLabel}</span>
        {total === null ? <span /> : bar(total)}
        <span className="num right">{fmt.signed(total)}</span>
      </div>
    </div>
  );
}
