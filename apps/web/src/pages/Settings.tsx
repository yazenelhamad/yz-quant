import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { del, errorMessage, post } from "../api/client";
import { useApi, useInvalidate } from "../api/hooks";
import { AUTONOMY_LEVELS, type AutonomyLevel, type BrokerConnectResponse, type BrokerStatus, type BrokerSyncResponse, type MfaConfirmResponse, type MfaEnrollResponse, type RevokeAllResponse, type SessionRecord, type SessionsResponse } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { useSession, useUser } from "../auth/SessionProvider";
import { useStepUp } from "../auth/StepUpProvider";
import { AUTONOMY_DESCRIPTIONS, AutonomyBadge, Badge } from "../components/Badge";
import { ConfirmDialog } from "../components/Dialog";
import { Column, DataTable } from "../components/DataTable";
import { Banner, Field, KV, PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { StatusPill, brokerText, brokerTone } from "../components/StatusPill";
import { fmt } from "../lib/fmt";

export function SettingsPage() {
  const { account, isOwner } = useAccount();
  const [params] = useSearchParams();
  return (
    <>
      <PageHeader title="Settings" sub={`${account.label} · ${account.accountNumberMasked ?? "no account number"}`} />
      <div className="stack">
        {params.get("connected") === "1" && <Banner tone="ok">Robinhood authorization completed. Run a sync to pull the portfolio.</Banner>}
        {!isOwner && <Banner tone="warn">You are viewing another user's account as admin. Account controls are read-only; only the owner can change autonomy, connection or risk settings.</Banner>}
        <div className="grid cols-2">
          <AutonomyPanel readOnly={!isOwner} />
          <BrokerPanel readOnly={!isOwner} />
        </div>
        <div className="grid cols-2">
          <MfaPanel />
          <PasswordPanel />
        </div>
        <SessionsPanel />
      </div>
    </>
  );
}

function AutonomyPanel({ readOnly }: { readOnly: boolean }) {
  const { account } = useAccount();
  const scoped = useScoped();
  const invalidate = useInvalidate();
  const { ensureFresh } = useStepUp();
  const [level, setLevel] = useState<AutonomyLevel>(account.autonomyLevel);
  const [confirm, setConfirm] = useState<"level" | "pause" | "resume" | null>(null);
  const changed = level !== account.autonomyLevel;
  return (
    <Panel title="Autonomous trading" actions={<AutonomyBadge level={account.autonomyLevel} />} foot="Changing the level requires password (+ MFA) confirmation and is audited. Pausing needs no confirmation; resuming does.">
      <div className="stack" style={{ gap: 6 }}>
        {AUTONOMY_LEVELS.map((l) => (
          <label key={l} className="check" style={{ alignItems: "flex-start", opacity: readOnly ? 0.7 : 1 }}>
            <input type="radio" name="autonomy" value={l} checked={level === l} disabled={readOnly} onChange={() => setLevel(l)} style={{ marginTop: 3 }} />
            <span><strong>{fmt.label(l)}</strong>{l === account.autonomyLevel && <Badge tone="accent" > current</Badge>}<div className="small dim">{AUTONOMY_DESCRIPTIONS[l]}</div></span>
          </label>
        ))}
      </div>
      {!readOnly && (
        <div className="form-actions" style={{ justifyContent: "space-between" }}>
          <div className="row">
            {account.tradingPaused
              ? <><Badge tone="warn">Paused{account.pausedReason ? ` · ${account.pausedReason}` : ""}</Badge><button className="btn" onClick={() => setConfirm("resume")}>Resume trading</button></>
              : <button className="btn" onClick={() => setConfirm("pause")}>Pause trading</button>}
          </div>
          <button className="btn primary" disabled={!changed} onClick={() => setConfirm("level")}>Apply level (confirm identity)</button>
        </div>
      )}
      {confirm === "level" && (
        <ConfirmDialog title={`Change autonomy to ${fmt.label(level)}`} confirmLabel="Change level" danger={level === "fully_autonomous"} requireText={level === "fully_autonomous" ? "FULLY AUTONOMOUS" : undefined}
          body={<><p>{AUTONOMY_DESCRIPTIONS[level]}</p><p className="dim small">Every order still passes the deterministic risk engine and kill switches.</p></>}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { const ok = await ensureFresh("Changing the autonomy level requires confirmation."); if (!ok) throw new Error("Confirmation cancelled."); await post(scoped("autonomy"), { level }); await invalidate("/accounts"); setConfirm(null); }} />
      )}
      {confirm === "pause" && (
        <ConfirmDialog title="Pause trading" confirmLabel="Pause" reasonLabel="Reason" body={<p>No new orders will be placed. Open positions stay open and are still monitored; risk-reducing exits remain allowed.</p>} onCancel={() => setConfirm(null)}
          onConfirm={async (reason) => { await post(scoped("pause"), { paused: true, reason }); await invalidate("/accounts"); setConfirm(null); }} />
      )}
      {confirm === "resume" && (
        <ConfirmDialog title="Resume trading" confirmLabel="Resume" body={<p>Trading resumes at the <strong>{fmt.label(account.autonomyLevel)}</strong> level. This requires identity confirmation.</p>} onCancel={() => setConfirm(null)}
          onConfirm={async () => { const ok = await ensureFresh("Resuming trading requires confirmation."); if (!ok) throw new Error("Confirmation cancelled."); await post(scoped("pause"), { paused: false }); await invalidate("/accounts"); setConfirm(null); }} />
      )}
    </Panel>
  );
}

function BrokerPanel({ readOnly }: { readOnly: boolean }) {
  const { account } = useAccount();
  const scoped = useScoped();
  const invalidate = useInvalidate();
  const q = useApi<BrokerStatus>(scoped("broker/status"), { refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } finally { setBusy(null); await invalidate(scoped("broker"), "/accounts", scoped("overview")); }
  };
  if (account.kind === "simulated") {
    return <Panel title="Robinhood connection"><EmptyState title="Simulated account" detail="This account never connects to a broker. Orders are simulated for shadow research only." /></Panel>;
  }
  return (
    <Panel title="Robinhood connection" actions={<StatusPill tone={brokerTone(q.data?.status ?? account.status)}>{brokerText(q.data?.status ?? account.status)}</StatusPill>}>
      <QueryState query={q}>
        {(s) => (
          <KV items={[
            ["Detail", s.detail ?? "—"],
            ["Agentic account", s.agenticAccountNumberMasked ?? <span className="muted">unknown until connected</span>],
            ["Last healthy", s.lastHealthyAt ? fmt.ago(s.lastHealthyAt) : "never"],
            ["Consecutive failures", fmt.int(s.consecutiveFailures)],
            ["MCP tools", s.tools === null ? <span className="muted">not discovered</span> : s.tools.length === 0 ? <span className="muted">none</span> : <details><summary className="small">{s.tools.length} tools</summary><div className="tiny mono pre">{s.tools.join("\n")}</div></details>],
            ["Agentic allowed", account.agenticAllowed ? <Badge tone="pos">yes</Badge> : <Badge tone="warn">not confirmed</Badge>],
            ["Options at broker", account.optionsEnabledAtBroker ? "enabled" : "disabled"],
          ]} />
        )}
      </QueryState>
      {!readOnly && (
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" disabled={busy !== null} onClick={() => run("connect", async () => { const r = await post<BrokerConnectResponse>(scoped("broker/connect")); window.location.assign(r.authorizationUrl); return "Redirecting to Robinhood…"; })}>{account.status === "connected" ? "Re-authorize" : "Connect Robinhood"}</button>
          <button className="btn" disabled={busy !== null || account.status === "not_connected"} onClick={() => run("sync", async () => { const r = await post<BrokerSyncResponse>(scoped("broker/sync")); return `Synced: ${r.positions} positions, ${r.orders} orders${r.reconciliation ? r.reconciliation.ok ? ", reconciliation OK" : `, reconciliation MISMATCH (${r.reconciliation.mismatches.join("; ")})` : ""}.`; })}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>
          <button className="btn danger" disabled={busy !== null || account.status === "not_connected"} onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
          {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
        </div>
      )}
      {confirmDisconnect && (
        <ConfirmDialog title="Disconnect Robinhood" danger confirmLabel="Disconnect" requireText="DISCONNECT" body={<p>The stored credential is deleted and the account is paused. Open positions remain at the broker but the platform can no longer manage them.</p>} onCancel={() => setConfirmDisconnect(false)}
          onConfirm={async () => { await run("disconnect", async () => { await post(scoped("broker/disconnect")); return "Disconnected."; }); setConfirmDisconnect(false); }} />
      )}
    </Panel>
  );
}

function MfaPanel() {
  const user = useUser();
  const { refresh } = useSession();
  const [enroll, setEnroll] = useState<MfaEnrollResponse | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const wrap = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); } };
  return (
    <Panel title="Multi-factor authentication" actions={user.mfaEnabled ? <Badge tone="pos">Enabled</Badge> : <Badge tone="warn">Not enabled</Badge>}>
      {recovery ? (
        <div className="stack">
          <Banner tone="warn">Save these recovery codes now. They are shown once.</Banner>
          <div className="recovery">{recovery.map((c) => <div key={c}>{c}</div>)}</div>
          <button className="btn" onClick={() => setRecovery(null)}>Done</button>
        </div>
      ) : user.mfaEnabled ? (
        <div className="stack">
          <p className="dim small">TOTP is required at sign-in and for step-up confirmations.</p>
          {!disabling ? <button className="btn danger" onClick={() => setDisabling(true)}>Disable MFA</button> : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void wrap(async () => { await post("/auth/mfa/disable", { code }); await refresh(); setDisabling(false); setCode(""); }); }}>
              <input type="text" inputMode="numeric" placeholder="Current code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 140 }} required />
              <button className="btn danger" disabled={busy}>Confirm disable</button>
              <button type="button" className="btn ghost" onClick={() => setDisabling(false)}>Cancel</button>
            </form>
          )}
          {err && <div className="error-text">{err}</div>}
        </div>
      ) : enroll ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void wrap(async () => { const r = await post<MfaConfirmResponse>("/auth/mfa/confirm", { code }); setRecovery(r.recoveryCodes); setEnroll(null); setCode(""); await refresh(); }); }}>
          <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
            <img className="qr" src={enroll.qrDataUrl} alt="Authenticator QR code" />
            <div className="stack" style={{ gap: 6, flex: 1 }}>
              <div className="small dim">Scan with your authenticator app, or enter the secret manually:</div>
              <code className="pre" style={{ wordBreak: "break-all" }}>{enroll.secret}</code>
              <Field label="Code from app"><input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
            </div>
          </div>
          {err && <div className="error-text">{err}</div>}
          <div className="form-actions"><button type="button" className="btn ghost" onClick={() => setEnroll(null)}>Cancel</button><button className="btn primary" disabled={busy}>Confirm & enable</button></div>
        </form>
      ) : (
        <div className="stack">
          <p className="dim small">Protect this account with a time-based one-time code. Strongly recommended before enabling any live autonomy level.</p>
          {err && <div className="error-text">{err}</div>}
          <div><button className="btn primary" disabled={busy} onClick={() => void wrap(async () => setEnroll(await post<MfaEnrollResponse>("/auth/mfa/enroll")))}>Set up MFA (confirm identity)</button></div>
        </div>
      )}
    </Panel>
  );
}

function PasswordPanel() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const mismatch = again.length > 0 && next !== again;
  return (
    <Panel title="Password" foot="Changing the password signs out every other session.">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setBusy(true); setMsg(null); post("/auth/password", { currentPassword: cur, newPassword: next }).then(() => { setMsg({ ok: true, text: "Password changed. Other sessions were revoked." }); setCur(""); setNext(""); setAgain(""); }).catch((err) => setMsg({ ok: false, text: errorMessage(err) })).finally(() => setBusy(false)); }}>
        <Field label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
        <Field label="New password" hint="At least 12 characters."><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} required /></Field>
        <Field label="Repeat new password"><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />{mismatch && <span className="error-text">Passwords do not match.</span>}</Field>
        {msg && <div className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</div>}
        <div className="form-actions"><button className="btn primary" disabled={busy || mismatch || !next}>Change password (confirm identity)</button></div>
      </form>
    </Panel>
  );
}

function SessionsPanel() {
  const q = useApi<SessionsResponse>("/auth/sessions");
  const invalidate = useInvalidate();
  const [msg, setMsg] = useState<string | null>(null);
  const cols: Column<SessionRecord>[] = [
    { key: "device", header: "Device", render: (s) => <>{s.deviceLabel ?? <span className="muted">unknown device</span>} {s.current && <Badge tone="accent">This session</Badge>}</>, sortValue: (s) => s.deviceLabel },
    { key: "ua", header: "User agent", render: (s) => <span className="truncate tiny muted" style={{ maxWidth: 320, display: "inline-block" }} title={s.userAgent ?? ""}>{s.userAgent ?? "—"}</span> },
    { key: "ip", header: "IP", render: (s) => <span className="mono">{s.ip ?? "—"}</span> },
    { key: "created", header: "Signed in", render: (s) => fmt.dateTime(s.createdAt), sortValue: (s) => s.createdAt },
    { key: "seen", header: "Last seen", render: (s) => fmt.ago(s.lastSeenAt), sortValue: (s) => s.lastSeenAt },
    { key: "x", header: "", render: (s) => s.current ? null : <button className="btn sm danger" onClick={async () => { await del(`/auth/sessions/${encodeURIComponent(s.id)}`); await invalidate("/auth/sessions"); }}>Revoke</button> },
  ];
  return (
    <Panel title="Sessions & devices" flush actions={<button className="btn sm" onClick={async () => { const r = await del<RevokeAllResponse>("/auth/sessions"); setMsg(`Revoked ${r.revoked} other session(s).`); await invalidate("/auth/sessions"); }}>Sign out other devices</button>}>
      {msg && <div className="panel-body ok-text">{msg}</div>}
      <QueryState query={q}>{(d) => <DataTable rows={d.sessions} columns={cols} rowKey={(s) => s.id} defaultSort={{ key: "seen", dir: "desc" }} compact />}</QueryState>
    </Panel>
  );
}
