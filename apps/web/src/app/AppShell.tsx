import { useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAccount } from "./AccountContext";
import { useSession, useUser } from "../auth/SessionProvider";
import { useInactivity } from "../auth/useInactivity";
import { AutonomyBadge, Badge } from "../components/Badge";
import { StatusPill, brokerText, brokerTone } from "../components/StatusPill";
import { fmt } from "../lib/fmt";
import type { AccountSummary } from "../api/types";

const NAV: { to: string; label: string }[] = [
  { to: "overview", label: "Overview" },
  { to: "opportunities", label: "Opportunities" },
  { to: "positions", label: "Positions" },
  { to: "strategies", label: "Strategies" },
  { to: "research", label: "Research" },
  { to: "backtests", label: "Backtests" },
  { to: "journal", label: "Trade Journal" },
  { to: "learning", label: "Learning" },
  { to: "risk", label: "Risk" },
  { to: "analytics", label: "Analytics" },
  { to: "health", label: "System Health" },
  { to: "settings", label: "Settings" },
];
const ADMIN_NAV: { to: string; label: string }[] = [
  { to: "admin/comparison", label: "Comparison" },
  { to: "admin/global-risk", label: "Global Risk" },
  { to: "admin/users", label: "Users" },
  { to: "admin/models", label: "Models & Agents" },
  { to: "admin/audit", label: "Audit" },
  { to: "admin/jobs", label: "Jobs" },
];

function accountOptionLabel(a: AccountSummary, withOwner: boolean): string {
  const parts = [a.label, a.accountNumberMasked ?? "no number", a.kind === "simulated" ? "SIMULATED" : "Robinhood"];
  if (withOwner) parts.unshift(a.owner.displayName);
  return parts.join(" · ");
}

export function AppShell({ children }: { children: ReactNode }) {
  const user = useUser();
  const { session, logout } = useSession();
  const { account, own, others, isOwner, base } = useAccount();
  const navigate = useNavigate();
  const location = useLocation();
  const [loggingOut, setLoggingOut] = useState(false);

  const inactivity = useInactivity(session?.inactivityTimeoutSeconds, () => { void logout(); });

  const switchAccount = (id: string) => {
    const rest = location.pathname.replace(/^\/a\/[^/]+/, "");
    navigate(`/a/${id}${rest || "/overview"}${location.search}`);
  };

  const p = account.portfolio;
  const tradingState = account.killSwitchActive
    ? { tone: "bad" as const, text: "Kill switch active" }
    : account.tradingPaused
      ? { tone: "warn" as const, text: `Paused${account.pausedReason ? ` · ${account.pausedReason}` : ""}` }
      : account.autonomyLevel === "research_only" || account.autonomyLevel === "shadow"
        ? { tone: "neutral" as const, text: "Not trading live" }
        : { tone: "ok" as const, text: "Active" };

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">yz-quant<span>trading intelligence</span></div>
        <div className="account-select">
          <label className="strip-label" htmlFor="account-select">Account</label>
          <select id="account-select" value={account.id} onChange={(e) => switchAccount(e.target.value)} aria-label="Select Robinhood account">
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
        <div className="spacer" />
        <div className="topbar-user">
          <span className="strip-label">User</span>
          <strong>{user.displayName}</strong>
          <Badge tone={user.role === "admin" ? "accent" : "outline"}>{user.role}</Badge>
          {!user.mfaEnabled && <Badge tone="warn" title="Enable MFA in Settings">No MFA</Badge>}
        </div>
        <button className="btn ghost sm" disabled={loggingOut} onClick={() => { setLoggingOut(true); void logout(); }}>Sign out</button>
      </header>

      <div className="strip" aria-label="Current account">
        <div className="strip-item">
          <span className="strip-label">Current Robinhood account</span>
          <span className="strip-value">
            {account.label}
            <span className="mono dim">{account.accountNumberMasked ?? "no number"}</span>
            {account.kind === "simulated" ? <Badge tone="sim">Simulated</Badge> : <Badge tone="outline">Robinhood agentic</Badge>}
            <Badge>{fmt.label(account.accountType)}</Badge>
            {!isOwner && <Badge tone="warn" title={`Owned by ${account.owner.displayName}. Admin read-only view.`}>Read-only · {account.owner.displayName}</Badge>}
          </span>
        </div>
        <div className="strip-item">
          <span className="strip-label">Portfolio value</span>
          <span className={`strip-value ${p ? "" : "muted"}`}>{p ? fmt.money(p.totalValue) : "No data"}{p && <span className="tiny muted">as of {fmt.ago(p.asOf)}</span>}</span>
        </div>
        <div className="strip-item">
          <span className="strip-label">Buying power</span>
          <span className={`strip-value ${p ? "" : "muted"}`}>{p ? fmt.money(p.buyingPower) : "No data"}</span>
        </div>
        <div className="strip-item">
          <span className="strip-label">Autonomous trading</span>
          <span className="strip-value"><AutonomyBadge level={account.autonomyLevel} /><StatusPill tone={tradingState.tone}>{tradingState.text}</StatusPill></span>
        </div>
        <div className="strip-item">
          <span className="strip-label">Connection</span>
          <span className="strip-value"><StatusPill tone={account.kind === "simulated" ? "neutral" : brokerTone(account.status)} title={account.statusDetail ?? undefined}>{brokerText(account.status, account.kind)}</StatusPill></span>
        </div>
        {account.reconciliationOk === false && (
          <div className="strip-item"><span className="strip-label">Reconciliation</span><span className="strip-value"><StatusPill tone="bad">Mismatch</StatusPill></span></div>
        )}
      </div>

      <nav className="sidebar" aria-label="Main">
        <div className="nav-section">
          <div className="nav-title">Account</div>
          {NAV.map((n) => <NavLink key={n.to} to={`${base}/${n.to}`} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>{n.label}</NavLink>)}
        </div>
        {user.role === "admin" && (
          <div className="nav-section">
            <div className="nav-title">Admin</div>
            {ADMIN_NAV.map((n) => <NavLink key={n.to} to={`${base}/${n.to}`} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>{n.label}</NavLink>)}
          </div>
        )}
      </nav>

      <main className="main">{children}</main>

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
