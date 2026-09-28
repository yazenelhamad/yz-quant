import type { ReactNode } from "react";
import { fmt } from "../lib/fmt";

export interface EvidenceItem {
  label: string;
  detail?: string | null;
  source?: string | null;
  reliability?: number | null;
  observedAt?: string | null;
  kind?: string | null;
  /** Supporting or contradicting the conclusion. */
  polarity?: "for" | "against" | "neutral";
}

/**
 * Plain-English explanation of a trade or decision, with a collapsible evidence list.
 * Text is rendered as text (never HTML) — model output is data, not markup.
 */
export function Explanation({ title = "Why", text, evidence, children, defaultOpen = false }: {
  title?: string;
  text: string | null | undefined;
  evidence?: EvidenceItem[];
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const hasText = Boolean(text && text.trim());
  return (
    <div className="explanation">
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      {hasText ? <div className="text pre">{text}</div> : !(evidence && evidence.length > 0) ? <div className="muted">No explanation recorded.</div> : null}
      {children}
      {evidence && evidence.length > 0 && (
        <details className="evidence" open={defaultOpen}>
          <summary>Evidence ({evidence.length})</summary>
          <div>
            {evidence.map((e, i) => (
              <div className="evidence-item" key={i}>
                <div>
                  {e.polarity === "for" && <span className="badge pos" style={{ marginRight: 6 }}>For</span>}
                  {e.polarity === "against" && <span className="badge neg" style={{ marginRight: 6 }}>Against</span>}
                  {e.label}
                  {e.detail && <div className="dim">{e.detail}</div>}
                </div>
                <div className="tiny muted nowrap">{typeof e.reliability === "number" ? `reliability ${fmt.score(e.reliability)}` : ""}</div>
                {(e.source || e.observedAt || e.kind) && (
                  <div className="meta">{[e.kind ? fmt.label(e.kind) : null, e.source, e.observedAt ? fmt.dateTime(e.observedAt) : null].filter(Boolean).join(" · ")}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
