import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { AccountSummary, Opportunity, PositionView } from "../api/types";
import { ADMIN_NAV, NAV } from "../app/nav";
import { Icon } from "./Icons";
import { isEditable, MOD_LABEL } from "../lib/shortcuts";

export interface PaletteAction { id: string; group: string; title: string; hint?: string; icon?: ReactNode; run: () => void; keywords?: string }

interface Props {
  open: boolean;
  onClose: () => void;
  base: string;
  scoped: (rest: string) => string;
  accounts: AccountSummary[];
  isAdmin: boolean;
  extra?: PaletteAction[];
  onSwitchAccount: (id: string) => void;
}

function score(hay: string, q: string): number {
  const h = hay.toLowerCase();
  const n = q.toLowerCase().trim();
  if (!n) return 1;
  if (h.startsWith(n)) return 3;
  if (h.split(/\s+/).some((w) => w.startsWith(n))) return 2;
  if (h.includes(n)) return 1;
  return 0;
}

/** ⌘K / Ctrl+K palette: pages, accounts, symbols (open positions and live candidates), shell actions. */
export function CommandPalette({ open, onClose, base, scoped, accounts, isAdmin, extra = [], onSwitchAccount }: Props) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Symbols load lazily, only while the palette is open, through the same cached queries the pages use.
  const positions = useApi<{ positions: PositionView[] }>(scoped("positions"), { enabled: open, staleTime: 30_000 });
  const opps = useApi<{ opportunities: Opportunity[] }>(scoped("opportunities"), { enabled: open, staleTime: 30_000 });

  useEffect(() => { if (open) { setQ(""); setSel(0); window.setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const actions = useMemo<PaletteAction[]>(() => {
    const pages: PaletteAction[] = [...NAV, ...(isAdmin ? ADMIN_NAV : [])].map((n) => {
      const I = Icon[n.icon];
      return { id: `page:${n.to}`, group: "Pages", title: n.label, hint: n.key ? `g ${n.key}` : undefined, icon: <I />, run: () => navigate(`${base}/${n.to}`) };
    });
    const accts: PaletteAction[] = accounts.map((a) => ({
      id: `acct:${a.id}`, group: "Accounts", title: `${a.label} · ${a.accountNumberMasked ?? "no number"}`, hint: `${a.owner.displayName}${a.kind === "simulated" ? " · simulated" : ""}`, icon: <Icon.Account />, run: () => onSwitchAccount(a.id), keywords: a.owner.displayName,
    }));
    const seen = new Set<string>();
    const syms: PaletteAction[] = [];
    for (const p of positions.data?.positions ?? []) {
      if (seen.has(p.symbol)) continue; seen.add(p.symbol);
      syms.push({ id: `pos:${p.symbol}`, group: "Symbols", title: p.symbol, hint: `open position${p.strategyKey ? ` · ${p.strategyKey}` : ""}`, icon: <Icon.Symbol />, run: () => navigate(`${base}/positions/${encodeURIComponent(p.symbol)}`) });
    }
    for (const o of opps.data?.opportunities ?? []) {
      if (seen.has(o.symbol)) continue; seen.add(o.symbol);
      syms.push({ id: `opp:${o.symbol}`, group: "Symbols", title: o.symbol, hint: `candidate · ${o.strategyName}`, icon: <Icon.Opportunities />, run: () => navigate(`${base}/opportunities`), keywords: o.strategyName });
    }
    return [...pages, ...accts, ...syms, ...extra];
  }, [accounts, base, extra, isAdmin, navigate, onSwitchAccount, opps.data, positions.data]);

  const results = useMemo(() => {
    const n = q.trim();
    const scored = actions.map((a) => ({ a, s: Math.max(score(a.title, n), score(a.keywords ?? "", n) * 0.9, score(a.hint ?? "", n) * 0.5) })).filter((x) => x.s > 0);
    scored.sort((x, y) => y.s - x.s);
    return scored.map((x) => x.a).slice(0, 40);
  }, [actions, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const run = (a: PaletteAction) => { onClose(); a.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const a = results[sel]; if (a) run(a); }
    else if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); onClose(); }
  };

  let lastGroup = "";
  const symbolsLoading = (positions.isPending || opps.isPending) && !q.trim();
  return (
    <div className="palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="palette-input">
          <Icon.Search />
          <input ref={inputRef} type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a page, account or symbol…" aria-label="Search commands" autoComplete="off" spellCheck={false} onKeyDown={(e) => { if (isEditable(e.target) && e.key === "Tab") e.preventDefault(); }} />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">No matches for “{q}”. Symbols come from open positions and current candidates only.</div>}
          {results.map((a, i) => {
            const head = a.group !== lastGroup ? <div className="palette-group" key={`g:${a.group}`}>{a.group}</div> : null;
            lastGroup = a.group;
            return (
              <div key={a.id}>
                {head}
                <div className={`palette-item ${i === sel ? "sel" : ""}`} role="option" aria-selected={i === sel} data-idx={i} onMouseEnter={() => setSel(i)} onClick={() => run(a)}>
                  {a.icon ?? <Icon.ChevronRight />}
                  <span className="t">{a.title}</span>
                  {a.hint && <span className="h">{a.hint}</span>}
                </div>
              </div>
            );
          })}
          {symbolsLoading && <div className="palette-group">Loading symbols…</div>}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>{MOD_LABEL}</kbd> <kbd>K</kbd> toggle</span></div>
      </div>
    </div>
  );
}
