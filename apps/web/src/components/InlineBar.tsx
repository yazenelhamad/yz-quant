import { clamp } from "../lib/fmt";

/**
 * Table-cell bar for a fraction (0..1) or a signed value (-1..1 with `signed`). The number is always
 * printed beside the bar; null renders an em dash and an empty track so a missing value never reads as zero.
 */
export function InlineBar({ value, text, signed, max = 1, tone }: {
  value: number | null | undefined;
  text: string;
  signed?: boolean;
  max?: number;
  tone?: "accent" | "pos" | "neg" | "warn" | "muted";
}) {
  const has = typeof value === "number" && Number.isFinite(value);
  const ratio = has ? clamp(Math.abs(value) / (max || 1), 0, 1) : 0;
  const width = signed ? ratio * 50 : ratio * 100;
  const cls = tone ?? (signed ? (has && value < 0 ? "neg" : "pos") : "accent");
  return (
    <span className={`ibar ${signed ? "signed" : ""}`}>
      <span className="track" aria-hidden>
        {has && <span className={`fill ${cls}`} style={{ width: `${width}%` }} />}
      </span>
      <span className="v">{text}</span>
    </span>
  );
}
