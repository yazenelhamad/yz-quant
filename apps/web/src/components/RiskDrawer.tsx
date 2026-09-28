import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Alert, OverviewResponse } from "../api/types";
import { fmt } from "../lib/fmt";
import { Icon } from "./Icons";
import { Meter } from "./Meter";
import { StatusPill } from "./StatusPill";
import { inferFormat } from "../lib/riskFormat";

const ACK_KEY = (accountId: string) => `yz.ack.${accountId}`;

function readAck(accountId: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY(accountId)) ?? "[]") as string[]); } catch { return new Set(); }
}
function writeAck(accountId: string, s: Set<string>) {
  try { localStorage.setItem(ACK_KEY(accountId), JSON.stringify([...s].slice(-200))); } catch { /* ignore */ }
}

/**
 * Acknowledgements are a per-device convenience (the API has no acknowledge endpoint), so the drawer says so.
 * Returns the unacknowledged alerts and an ack/unack pair.
 */
export function useAlertAck(accountId: string, alerts: Alert[]) {
  const [acked, setAcked] = useState<Set<string>>(() => readAck(accountId));
  useEffect(() => { setAcked(readAck(accountId)); }, [accountId]);
  const ack = useCallback((id: string) => setAcked((s) => { const n = new Set(s); n.add(id); writeAck(accountId, n); return n; }), [accountId]);
  const clear = useCallback(() => { setAcked(new Set()); writeAck(accountId, new Set()); }, [accountId]);
  const open = alerts.filter((a) => !acked.has(a.id));
  return { open, ack, clear, ackedCount: alerts.length - open.length };
}

export function RiskDrawer({ overview, accountId, base, onClose }: { overview: OverviewResponse | undefined; accountId: string; base: string; onClose: () => void }) {
  const alerts = overview?.alerts ?? [];
  const { open, ack, clear, ackedCount } = useAlertAck(accountId, alerts);
  const util = Object.entries(overview?.risk.utilization ?? {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="side" role="complementary" aria-label="Risk and alerts">
      <div className="side-head">
        <h2>Risk &amp; Alerts</h2>
        <div className="row">
          <Link to={`${base}/risk`} className="btn ghost sm" onClick={onClose}>Risk page</Link>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon.Close width={14} height={14} /></button>
        </div>
      </div>
      <div className="side-body">
        <section>
          <div className="row between"><h3>Unacknowledged alerts</h3><span className="tiny muted">{open.length} open{ackedCount > 0 ? ` · ${ackedCount} acknowledged` : ""}</span></div>
          {!overview ? <div className="muted small">Overview not loaded yet.</div> : open.length === 0 ? (
            <div className="muted small">No open alerts for this account.{ackedCount > 0 && <> <button className="btn link small" onClick={clear}>Show acknowledged</button></>}</div>
          ) : (
            <div>
              {open.map((a) => (
                <div className="alert-item" key={a.id}>
                  <StatusPill tone={a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : "info"}>{a.severity}</StatusPill>
                  <div className="msg"><div>{a.message}</div><div className="meta">{a.code} · {fmt.ago(a.at)}</div></div>
                  <button className="btn sm ghost ack" onClick={() => ack(a.id)} title="Hide on this device">Ack</button>
                </div>
              ))}
            </div>
          )}
          <div className="tiny muted" style={{ marginTop: 6 }}>Acknowledgements are kept on this device only; the server keeps every alert.</div>
        </section>
        <section>
          <h3>Risk utilization</h3>
          {!overview ? <div className="muted small">—</div> : util.length === 0 ? <div className="muted small">No utilization data reported.</div> : (
            <div>
              {util.map(([k, v]) => <Meter key={k} label={fmt.label(k)} used={v.used} limit={v.limit} format={inferFormat(k)} />)}
              <div className="tiny muted" style={{ marginTop: 6 }}>Remaining risk capacity: {overview.risk.capacity === null ? "unknown" : fmt.score(overview.risk.capacity)}</div>
            </div>
          )}
        </section>
        {overview && (
          <section>
            <h3>Controls</h3>
            <dl className="kv">
              <dt>Kill switch</dt><dd>{overview.account.killSwitchActive ? <StatusPill tone="bad">Active</StatusPill> : <StatusPill tone="ok">Inactive</StatusPill>}</dd>
              <dt>Trading</dt><dd>{overview.account.tradingPaused ? <StatusPill tone="warn">Paused{overview.account.pausedReason ? ` · ${overview.account.pausedReason}` : ""}</StatusPill> : <StatusPill tone="neutral">{fmt.label(overview.account.autonomyLevel)}</StatusPill>}</dd>
              <dt>Drawdown</dt><dd className="num">{fmt.pct(overview.drawdownPct, { digits: 2 })}</dd>
              <dt>Execution issues</dt><dd className="num">{fmt.int(overview.executionIssues.length)}</dd>
            </dl>
          </section>
        )}
      </div>
    </aside>
  );
}
