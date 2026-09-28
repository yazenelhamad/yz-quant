import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAccount, useScoped } from "./AccountContext";
import { ADMIN_NAV, NAV, pageLabel } from "./nav";
import { useApi } from "../api/hooks";
import type { AccountSummary, OverviewResponse } from "../api/types";
import { useSession, useUser } from "../auth/SessionProvider";
import { useInactivity } from "../auth/useInactivity";
import { AutonomyBadge, Badge } from "../components/Badge";
import { CommandPalette, type PaletteAction } from "../components/CommandPalette";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icons";
import { RiskDrawer, useAlertAck } from "../components/RiskDrawer";
import { StatusBar } from "../components/StatusBar";
import { StatusPill, brokerText, brokerTone } from "../components/StatusPill";
import { useToast } from "../components/Toast";
import { monogramDataUrl, monogramLetter, useBrandDocument } from "../lib/brand";
import { fmt } from "../lib/fmt";
import { SESSION_LABEL, useMarketClock } from "../lib/marketClock";
import { MOD_LABEL, useShortcuts } from "../lib/shortcuts";
import { useTheme } from "../lib/theme";

const RAIL_KEY = "yz.rail";

function accountOptionLabel(a: AccountSummary, withOwner: boolean): string {
  const parts = [a.label, a.accountNumberMasked ?? "no number", a.kind === "simulated" ? "SIMULATED" : "Robinhood"];
  if (withOwner) parts.unshift(a.owner.displayName);
  return parts.join(" · ");
}

function MarketClock() {
  const c = useMarketClock();
  return (
    <div className="clock" title="New York wall clock. Session is estimated from the weekday and time only; holidays and early closes are not modelled.">
      <span className="time">{c.time}</span>
      <span className="tz">{c.tz}</span>
      <span className={`session-pill ${c.session}`}><span className="dot" aria-hidden />{SESSION_LABEL[c.session]}<span className="est">· est.</span></span>
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcuts">
        <div><span>Command palette</span><span className="keys"><kbd>{MOD_LABEL}</kbd><kbd>K</kbd></span></div>
        <div><span>Risk &amp; alerts drawer</span><span className="keys"><kbd>a</kbd></span></div>
        <div><span>Collapse / expand rail</span><span className="keys"><kbd>\</kbd></span></div>
        <div><span>This help</span><span className="keys"><kbd>?</kbd></span></div>
        <div><span>Close dialog / drawer</span><span className="keys"><kbd>esc</kbd></span></div>
        {NAV.filter((n) => n.key).map((n) => <div key={n.to}><span>Go to {n.label}</span><span className="keys"><kbd>g</kbd><kbd>{n.key}</kbd></span></div>)}
      </div>
    </Dialog>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const user = useUser();
  const { session, logout } = useSession();
  const { account, own, others, isOwner, base, accountId } = useAccount();
  const scoped = useScoped();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [theme, , cycleTheme] = useTheme();
  const [loggingOut, setLoggingOut] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } });
  const acctRef = useRef<HTMLDivElement>(null);

  const brand = user.brandName?.trim() || `${user.displayName}'s Quant`;
  const rest = location.pathname.replace(/^\/a\/[^/]+/, "");
  useBrandDocument(brand, pageLabel(rest));

  // The overview feeds the alerts badge, the drawer and the status bar; the Overview page shares this cache entry.
  const overview = useApi<OverviewResponse>(scoped("overview"), { refetchInterval: 30_000 });
  const { open: openAlerts } = useAlertAck(accountId, overview.data?.alerts ?? []);
  const criticalAlerts = openAlerts.filter((a) => a.severity === "critical").length;

  const inactivity = useInactivity(session?.inactivityTimeoutSeconds, () => { void logout(); });

  const switchAccount = useCallback((id: string) => {
    const r = location.pathname.replace(/^\/a\/[^/]+/, "");
    navigate(`/a/${id}${r || "/overview"}${location.search}`);
    setAcctOpen(false);
  }, [location.pathname, location.search, navigate]);

  const toggleRail = useCallback(() => setRailCollapsed((c) => { try { localStorage.setItem(RAIL_KEY, c ? "0" : "1"); } catch { /* ignore */ } return !c; }), []);

  useEffect(() => {
    if (!acctOpen) return;
    const onDown = (e: MouseEvent) => { if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAcctOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [acctOpen]);

  const chords = useMemo(() => {
    const m: Record<string, () => void> = {};
    for (const n of NAV) if (n.key) m[`g ${n.key}`] = () => navigate(`${base}/${n.to}`);
    return m;
  }, [base, navigate]);
  useShortcuts({
    chords,
    keys: {
      "?": () => setHelpOpen((v) => !v),
      "a": () => setDrawerOpen((v) => !v),
      "\\": toggleRail,
    },
    combos: { "mod+k": () => setPaletteOpen((v) => !v) },
  }, !paletteOpen);

  const paletteExtra = useMemo<PaletteAction[]>(() => [
    { id: "act:alerts", group: "Actions", title: "Open Risk & Alerts drawer", hint: "a", icon: <Icon.Bell />, run: () => setDrawerOpen(true) },
    { id: "act:theme", group: "Actions", title: `Switch theme (now: ${theme})`, icon: theme === "light" ? <Icon.Sun /> : <Icon.Moon />, run: cycleTheme, keywords: "dark light system" },
    { id: "act:rail", group: "Actions", title: railCollapsed ? "Expand navigation rail" : "Collapse navigation rail", hint: "\\", icon: railCollapsed ? <Icon.ChevronsRight /> : <Icon.ChevronsLeft />, run: toggleRail },
    { id: "act:help", group: "Actions", title: "Keyboard shortcuts", hint: "?", icon: <Icon.Keyboard />, run: () => setHelpOpen(true) },
    { id: "act:logout", group: "Actions", title: "Sign out", icon: <Icon.Logout />, run: () => { setLoggingOut(true); void logout(); } },
  ], [cycleTheme, logout, railCollapsed, theme, toggleRail]);

  const p = account.portfolio;
  const tradingState = account.killSwitchActive
    ? { tone: "bad" as const, text: "Kill switch active" }
    : account.tradingPaused
      ? { tone: "warn" as const, text: `Paused${account.pausedReason ? ` · ${account.pausedReason}` : ""}` }
      : account.autonomyLevel === "research_only" || account.autonomyLevel === "shadow"
        ? { tone: "neutral" as const, text: "Not trading live" }
        : { tone: "ok" as const, text: "Active" };
  const connTone = account.kind === "simulated" ? "neutral" : brokerTone(account.status);
  const ThemeIcon = theme === "light" ? Icon.Sun : theme === "system" ? Icon.Monitor : Icon.Moon;

  const navLink = (n: { to: string; label: string; icon: keyof typeof Icon; key?: string }) => {
    const I = Icon[n.icon];
    return (
      <NavLink key={n.to} to={`${base}/${n.to}`} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} title={railCollapsed ? n.label : undefined} aria-label={n.label}>
        <I /><span className="lbl">{n.label}</span>{n.key && <kbd>g {n.key}</kbd>}
      </NavLink>
    );
  };

  return (
    <div className={`app ${railCollapsed ? "rail-collapsed" : ""}`}>
      <header className="topbar">
        <Link to={`${base}/overview`} className="brand" aria-label={`${brand} — overview`}>
          <img className="monogram" src={monogramDataUrl(monogramLetter(brand))} alt="" width={24} height={24} />
          <span className="wordmark">{brand}</span>
          <span className="tagline">command center</span>
        </Link>
        <span className="topbar-sep" />
        <MarketClock />
        <span className="topbar-sep" />

        <div className="acct" ref={acctRef}>
          <button className="acct-chip" aria-expanded={acctOpen} aria-haspopup="dialog" onClick={() => setAcctOpen((v) => !v)} title={`${accountOptionLabel(account, !isOwner)} — ${brokerText(account.status, account.kind)}`}>
            <span className={`status-dot ${connTone}`} aria-hidden />
            <span className="label">{account.label}</span>
            <span className="masked">{account.accountNumberMasked ?? "no number"}</span>
            {account.kind === "simulated" && <Badge tone="sim">Sim</Badge>}
            {!isOwner && <Badge tone="warn" title={`Owned by ${account.owner.displayName}. Admin read-only view.`}>Read-only</Badge>}
            <Icon.ChevronDown className="chev" width={14} height={14} />
          </button>
          <div className="acct-metrics">
            <div className="acct-metric"><span className="k">Portfolio</span><span className={`v ${p ? "" : "muted"}`}>{p ? fmt.money(p.totalValue) : "No data"}</span></div>
            <div className="acct-metric"><span className="k">Buying power</span><span className={`v ${p ? "" : "muted"}`}>{p ? fmt.money(p.buyingPower) : "No data"}</span></div>
            <AutonomyBadge level={account.autonomyLevel} />
            <StatusPill tone={tradingState.tone}>{tradingState.text}</StatusPill>
            {account.reconciliationOk === false && <StatusPill tone="bad" title="Last reconciliation mismatched">Recon mismatch</StatusPill>}
          </div>
          {acctOpen && (
            <div className="acct-pop" role="dialog" aria-label="Account">
              <div className="field">
                <label htmlFor="account-select">Account</label>
                <select id="account-select" value={account.id} onChange={(e) => switchAccount(e.target.value)} aria-label="Select Robinhood account" autoFocus>
                  <optgroup label="My accounts">
                    {own.map((a) => <option key={a.id} value={a.id}>{accountOptionLabel(a, false)}</option>)}
                  </optgroup>
                  {others.length > 0 && (
                    <optgroup label="Other users (read-only)">
                      {others.map((a) => <option key={a.id} value={a.id}>{accountOptionLabel(a, true)}</option>)}
                    </optgroup>
                  )}
                </select>
              </div>
              <dl className="kv wide">
                <dt>User</dt><dd><strong>{user.displayName}</strong> <Badge tone={user.role === "admin" ? "accent" : "outline"}>{user.role}</Badge></dd>
                <dt>Account</dt><dd>{account.label} <span className="mono dim">{account.accountNumberMasked ?? "no number"}</span> {account.kind === "simulated" ? <Badge tone="sim">Simulated</Badge> : <Badge tone="outline">Robinhood agentic</Badge>} <Badge>{fmt.label(account.accountType)}</Badge></dd>
                {!isOwner && <><dt>Owner</dt><dd><Badge tone="warn">Read-only · {account.owner.displayName}</Badge></dd></>}
                <dt>Portfolio value</dt><dd className="num">{p ? <>{fmt.money(p.totalValue)} <span className="tiny muted">as of {fmt.ago(p.asOf)}</span></> : <span className="muted">No data</span>}</dd>
                <dt>Buying power</dt><dd className="num">{p ? fmt.money(p.buyingPower) : <span className="muted">No data</span>}</dd>
                <dt>Autonomous trading</dt><dd><AutonomyBadge level={account.autonomyLevel} /> <StatusPill tone={tradingState.tone}>{tradingState.text}</StatusPill></dd>
                <dt>Connection</dt><dd><StatusPill tone={connTone} title={account.statusDetail ?? undefined}>{brokerText(account.status, account.kind)}</StatusPill></dd>
                {account.reconciliationOk === false && <><dt>Reconciliation</dt><dd><StatusPill tone="bad">Mismatch</StatusPill></dd></>}
              </dl>
            </div>
          )}
        </div>

        <div className="spacer" />

        <button className="icon-btn" onClick={() => setPaletteOpen(true)} title={`Command palette (${MOD_LABEL}+K)`} aria-label="Open command palette"><Icon.Search /><kbd>{MOD_LABEL} K</kbd></button>
        <button className={`icon-btn ${drawerOpen ? "active" : ""}`} onClick={() => setDrawerOpen((v) => !v)} title="Risk & alerts (a)" aria-label={`Risk and alerts, ${openAlerts.length} open`} aria-pressed={drawerOpen}>
          <Icon.Bell />
          {openAlerts.length > 0 && <span className={`count ${criticalAlerts > 0 ? "" : "warn"}`}>{openAlerts.length}</span>}
        </button>
        <button className="icon-btn" onClick={cycleTheme} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}><ThemeIcon /></button>
        <span className="topbar-sep" />
        <div className="topbar-user">
          <strong>{user.displayName}</strong>
          <Badge tone={user.role === "admin" ? "accent" : "outline"}>{user.role}</Badge>
          {!user.mfaEnabled && <Badge tone="warn" title="Enable MFA in Settings">No MFA</Badge>}
        </div>
        <button className="btn ghost sm" disabled={loggingOut} onClick={() => { setLoggingOut(true); void logout(); }}>Sign out</button>
      </header>

      <nav className="rail" aria-label="Main">
        <div className="nav-section">
          <div className="nav-title">Account</div>
          {NAV.map(navLink)}
        </div>
        {user.role === "admin" && (
          <div className="nav-section">
            <div className="nav-title">Admin</div>
            {ADMIN_NAV.map(navLink)}
          </div>
        )}
        <div className="rail-foot">
          <button className="rail-toggle" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)"><Icon.Keyboard /><span>Shortcuts <kbd>?</kbd></span></button>
          <button className="rail-toggle" onClick={toggleRail} title={railCollapsed ? "Expand rail (\\)" : "Collapse rail (\\)"} aria-label={railCollapsed ? "Expand rail" : "Collapse rail"}>
            {railCollapsed ? <Icon.ChevronsRight /> : <Icon.ChevronsLeft />}<span>Collapse <kbd>\</kbd></span>
          </button>
        </div>
      </nav>

      <main className="main">{children}</main>

      <StatusBar overview={overview.data} base={base} refreshedAt={overview.dataUpdatedAt || undefined} />

      {drawerOpen && <RiskDrawer overview={overview.data} accountId={accountId} base={base} onClose={() => setDrawerOpen(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} base={base} scoped={scoped} accounts={[...own, ...others]} isAdmin={user.role === "admin"} extra={paletteExtra} onSwitchAccount={(id) => { switchAccount(id); toast.info("Switched account"); }} />
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}

      {inactivity.warning && (
        <div className="inactivity" role="alertdialog" aria-live="assertive">
          <strong>Still there?</strong>
          <p className="dim" style={{ margin: "4px 0 8px" }}>You will be signed out in {inactivity.secondsLeft}s for inactivity.</p>
          <div className="row">
            <button className="btn primary sm" onClick={inactivity.extend}>Stay signed in</button>
            <button className="btn sm" onClick={() => { void logout(); }}>Sign out now</button>
          </div>
        </div>
      )}
    </div>
  );
}
