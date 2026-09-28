import type { ReactNode } from "react";
import { fmt } from "../lib/fmt";

export interface TimelineItem {
  at: string | null | undefined;
  title: ReactNode;
  note?: ReactNode;
  tone?: "ok" | "bad" | "warn" | "info" | "neutral";
}

/** Vertical decision timeline: a dot per event, mono timestamp, one-line title and an optional note. */
export function Timeline({ items, emptyText = "No events." }: { items: TimelineItem[]; emptyText?: string }) {
  if (items.length === 0) return <div className="muted small">{emptyText}</div>;
  return (
    <ol className="tl">
      {items.map((it, i) => (
        <li key={i} className={it.tone ?? ""}>
          <span className="when">{fmt.dateTime(it.at)}</span>
          <span className="what">
            <div>{it.title}</div>
            {it.note && <div className="note">{it.note}</div>}
          </span>
        </li>
      ))}
    </ol>
  );
}
