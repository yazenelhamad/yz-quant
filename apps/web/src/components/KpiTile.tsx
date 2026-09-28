import type { ReactNode } from "react";
import { NA } from "../lib/fmt";

/**
 * Stat tile. `value` already formatted; pass null/undefined to render an honest "no data"
 * state instead of a number. `tone` colours the value only for P&L-like semantics.
 */
export function KpiTile({ label, value, sub, tone, hero, naText }: {
  label: string;
  value: string | null | undefined;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "flat" | "warn";
  hero?: boolean;
  naText?: string;
}) {
  const missing = value === null || value === undefined || value === NA;
  const cls = missing ? "na" : tone === "pos" ? "pos" : tone === "neg" ? "neg" : tone === "warn" ? "warn-text" : "";
  return (
    <div className={`kpi ${hero ? "hero" : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls}`}>{missing ? (naText ?? "No data") : value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
