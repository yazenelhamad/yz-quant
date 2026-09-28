import type { ReactNode } from "react";
import { NA } from "../lib/fmt";
import { Sparkline } from "./Sparkline";

/**
 * Stat tile. `value` already formatted; pass null/undefined to render an honest "no data"
 * state instead of a number. `tone` colours the value only for P&L-like semantics.
 * `delta` renders a signed chip; `history` renders a sparkline only when real points exist
 * (otherwise a labelled "no history yet" placeholder line).
 */
export function KpiTile({ label, value, sub, tone, hero, naText, delta, history, historyLabel }: {
  label: string;
  value: string | null | undefined;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "flat" | "warn";
  hero?: boolean;
  naText?: string;
  delta?: { text: string; tone?: "pos" | "neg" | "flat" | "warn"; title?: string } | null;
  /** When provided (even empty) the tile reserves a sparkline row. */
  history?: (number | null | undefined)[] | null;
  historyLabel?: string;
}) {
  const missing = value === null || value === undefined || value === NA;
  const cls = missing ? "na" : tone === "pos" ? "pos" : tone === "neg" ? "neg" : tone === "warn" ? "warn-text" : "";
  const sparkTone = tone === "pos" ? "pos" : tone === "neg" ? "neg" : "accent";
  return (
    <div className={`kpi ${hero ? "hero" : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls}`}>{missing ? (naText ?? "No data") : value}</div>
      {(sub || delta) && (
        <div className="kpi-sub">
          {delta && <span className={`delta ${delta.tone ?? "flat"}`} title={delta.title}>{delta.text}</span>}
          {sub}
        </div>
      )}
      {history !== undefined && <Sparkline points={history} tone={sparkTone} label={historyLabel ?? label} />}
    </div>
  );
}
