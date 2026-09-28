/**
 * Shared number/date formatting. Never invents values: null/undefined/NaN render as an
 * explicit em dash so a missing number is visibly missing rather than zero.
 */

/** Every `*Pct` field from the API is a fraction (0.0123 = 1.23%). Flip here if the API changes. */
export const PCT_IS_FRACTION = true;

export const NA = "—";

type Num = number | null | undefined;

function ok(n: Num): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const fmt = {
  money(n: Num, opts: { compact?: boolean; whole?: boolean; signed?: boolean } = {}): string {
    if (!ok(n)) return NA;
    const abs = Math.abs(n);
    const base = opts.compact && abs >= 100_000 ? compactMoney.format(abs) : opts.whole ? moneyWhole.format(abs) : moneyFmt.format(abs);
    if (n < 0) return `−${base}`;
    if (opts.signed && n > 0) return `+${base}`;
    return base;
  },

  /** Fraction in → percentage out. `pct(0.0123)` → "1.23%". */
  pct(n: Num, opts: { digits?: number; signed?: boolean } = {}): string {
    if (!ok(n)) return NA;
    const digits = opts.digits ?? 2;
    const v = PCT_IS_FRACTION ? n * 100 : n;
    const s = `${Math.abs(v).toFixed(digits)}%`;
    if (v < 0) return `−${s}`;
    if (opts.signed && v > 0) return `+${s}`;
    return s;
  },

  /** For 0..1 scores (confidence, edge, fit) — always treated as fractions regardless of PCT_IS_FRACTION. */
  score(n: Num, digits = 0): string {
    if (!ok(n)) return NA;
    return `${(n * 100).toFixed(digits)}%`;
  },

  /** Signed unit value for edges/fits, e.g. "+0.49". */
  signed(n: Num, digits = 2): string {
    if (!ok(n)) return NA;
    const s = Math.abs(n).toFixed(digits);
    return n < 0 ? `−${s}` : n > 0 ? `+${s}` : s;
  },

  num(n: Num, digits = 2): string {
    if (!ok(n)) return NA;
    return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },

  int(n: Num): string {
    if (!ok(n)) return NA;
    return intFmt.format(n);
  },

  bps(n: Num, digits = 0): string {
    if (!ok(n)) return NA;
    return `${n.toFixed(digits)} bps`;
  },

  ratio(n: Num, digits = 2): string {
    if (!ok(n)) return NA;
    return `${n.toFixed(digits)}×`;
  },

  price(n: Num): string {
    if (!ok(n)) return NA;
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
  },

  qty(n: Num): string {
    if (!ok(n)) return NA;
    return Number.isInteger(n) ? intFmt.format(n) : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  },

  days(n: Num): string {
    if (!ok(n)) return NA;
    const d = Math.round(n * 10) / 10;
    return `${d}d`;
  },

  dateTime(iso: string | null | undefined): string {
    if (!iso) return NA;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NA;
    return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  },

  date(iso: string | null | undefined): string {
    if (!iso) return NA;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NA;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
  },

  time(iso: string | null | undefined): string {
    if (!iso) return NA;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NA;
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  },

  /** "3m ago", "2h ago", "5d ago". */
  ago(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return NA;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return NA;
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  },

  duration(ms: Num): string {
    if (!ok(ms)) return NA;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s - m * 60)}s`;
  },

  /** "bull_trend" → "Bull trend". */
  label(s: string | null | undefined): string {
    if (!s) return NA;
    const t = s.replace(/[_-]+/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  },

  /** Signed class name for P&L colouring. */
  signClass(n: Num): "pos" | "neg" | "flat" {
    if (!ok(n) || n === 0) return "flat";
    return n > 0 ? "pos" : "neg";
  },
};

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
