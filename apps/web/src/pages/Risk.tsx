import { useEffect, useState } from "react";
import { errorMessage, post, put } from "../api/client";
import { useApi, useInvalidate } from "../api/hooks";
import type { RiskDecision, RiskSettings, RiskViewResponse } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { useStepUp } from "../auth/StepUpProvider";
import { Badge } from "../components/Badge";
import { ConfirmDialog } from "../components/Dialog";
import { Column, DataTable } from "../components/DataTable";
import { Field, KV, PageHeader, SymbolsInput } from "../components/Controls";
import { Meter } from "../components/Meter";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { fmt } from "../lib/fmt";
import { inferFormat } from "./Overview";

export function RiskPage() {
  const scoped = useScoped();
  const { isOwner } = useAccount();
  const q = useApi<RiskViewResponse>(scoped("risk"), { refetchInterval: 30_000 });
  return (
    <>
      <PageHeader title="Risk" sub="Deterministic limits enforced by the risk engine. The engine has absolute veto; nothing below can be overridden by the AI." />
      <QueryState query={q}>{(d) => <Body d={d} readOnly={!isOwner} />}</QueryState>
    </>
  );
}

function Body({ d, readOnly }: { d: RiskViewResponse; readOnly: boolean }) {
  const scoped = useScoped();
  const invalidate = useInvalidate();
  const { ensureFresh } = useStepUp();
  const [confirm, setConfirm] = useState<"trigger" | "release" | null>(null);

  const decisionCols: Column<RiskDecision>[] = [
    { key: "at", header: "Decided", render: (r) => fmt.dateTime(r.decidedAt), sortValue: (r) => r.decidedAt },
    { key: "symbol", header: "Symbol", render: (r) => <strong>{r.symbol}</strong>, sortValue: (r) => r.symbol },
    { key: "action", header: "Action", render: (r) => fmt.label(r.action) },
    { key: "verdict", header: "Verdict", render: (r) => <Badge tone={r.verdict === "approve" ? "pos" : r.verdict === "reduce" ? "warn" : "neg"}>{r.verdict}</Badge>, sortValue: (r) => r.verdict },
    { key: "qty", header: "Qty req → approved", align: "right", render: (r) => `${fmt.qty(r.requestedQuantity)} → ${fmt.qty(r.approvedQuantity)}` },
    { key: "notional", header: "Approved notional", align: "right", render: (r) => fmt.money(r.approvedNotional), sortValue: (r) => r.approvedNotional },
    { key: "checks", header: "Checks", render: (r) => { const failed = r.checks.filter((c) => !c.passed).length; return <span>{r.checks.length - failed}/{r.checks.length} passed{failed > 0 && <span className="neg"> · {failed} failed</span>}</span>; } },
    { key: "fc", header: "", render: (r) => r.failedClosed ? <Badge tone="neg" title="The engine failed closed due to an internal error or missing input">Failed closed</Badge> : null },
  ];

  const ks = d.killSwitch;
  const anyGlobal = d.global.liveExecutionDisabled || d.global.forceShadowMode || d.global.pausedByAdmin;

  return (
    <div className="stack">
      {anyGlobal && (
        <div className="banner warn">
          <span className="grow"><strong>Global overrides active:</strong> {[d.global.pausedByAdmin && "paused by admin", d.global.liveExecutionDisabled && "live execution disabled", d.global.forceShadowMode && "shadow mode forced"].filter(Boolean).join(" · ")}. These are set by the admin and take precedence over account settings.</span>
        </div>
      )}
      <div className="grid cols-3">
        <div className="span-2">
          <Panel title="Utilization">
            {Object.keys(d.utilization).length === 0 ? <EmptyState title="No utilization data" /> : Object.entries(d.utilization).map(([k, v]) => <Meter key={k} label={fmt.label(k)} used={v.used} limit={v.limit} format={inferFormat(k)} />)}
          </Panel>
        </div>
        <Panel title="Kill switch" actions={<Badge tone={ks.active ? "neg" : "pos"}>{ks.active ? "ACTIVE" : "Inactive"}</Badge>}>
          {ks.active ? (
            <KV items={[
              ["Reasons", ks.reasons.map((r) => <span className="tag" key={r}>{fmt.label(r)}</span>)],
              ["Triggered", `${fmt.dateTime(ks.triggeredAt)} by ${ks.triggeredBy ?? "system"}`],
              ["Risk-reducing exits", ks.allowRiskReducingExits ? "allowed" : "blocked"],
              ["Note", ks.note ?? "—"],
            ]} />
          ) : <p className="dim small">No kill switch active. Automatic triggers: daily/weekly loss, drawdown, market-data failure, broker unreliability, reconciliation failure, abnormal AI output, repeated execution failures.</p>}
          {!readOnly && (
            <div className="form-actions" style={{ justifyContent: "flex-start" }}>
              {ks.active
                ? <button className="btn primary" onClick={() => setConfirm("release")} disabled={ks.reasons.includes("admin_global")} title={ks.reasons.includes("admin_global") ? "Released by the admin only" : "Requires confirmation"}>Release (requires confirmation)</button>
                : <button className="btn danger" onClick={() => setConfirm("trigger")}>Trigger kill switch</button>}
            </div>
          )}
        </Panel>
      </div>

      <SettingsForm initial={d.settings} readOnly={readOnly} onSave={async (s) => {
        const ok = await ensureFresh("Changing risk limits requires a fresh confirmation.");
        if (!ok) throw new Error("Confirmation cancelled.");
        await put(scoped("risk-settings"), s);
        await invalidate(scoped("risk"), scoped("overview"));
      }} />

      <Panel title="Recent risk decisions" flush>
        <DataTable rows={d.recentDecisions} columns={decisionCols} rowKey={(r) => r.id} defaultSort={{ key: "at", dir: "desc" }} compact empty={<EmptyState title="No decisions yet" />} renderExpanded={(r) => (
          <div className="grid cols-2">
            <div>
              <h3>Checks</h3>
              <table className="data compact"><thead><tr><th>Check</th><th>Result</th><th className="num">Observed</th><th className="num">Limit</th><th>Detail</th></tr></thead>
                <tbody>{r.checks.map((c, i) => <tr key={i}><td className="mono small">{c.code}</td><td>{c.passed ? <Badge tone="pos">pass</Badge> : <Badge tone={c.severity === "blocking" ? "neg" : "warn"}>{c.severity}</Badge>}</td><td className="num">{c.observed ?? "—"}</td><td className="num">{c.limit ?? "—"}</td><td className="wrap small">{c.detail}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h3>Reasons</h3>
              {r.reasons.length ? <ul className="bullets">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="muted small">—</span>}
              <div className="tiny muted" style={{ marginTop: 8 }}>engine {r.riskEngineVersion} · candidate {r.candidateId ?? "—"} · trade {r.tradeId ?? "—"}</div>
            </div>
          </div>
        )} />
      </Panel>

      {d.alerts.length > 0 && (
        <Panel title="Alerts"><ul className="list">{d.alerts.map((a) => <li key={a.id}><Badge tone={a.severity === "critical" ? "neg" : a.severity === "warning" ? "warn" : "outline"}>{a.severity}</Badge><span className="grow">{a.message}</span><span className="when">{fmt.ago(a.at)}</span></li>)}</ul></Panel>
      )}

      {confirm === "trigger" && (
        <ConfirmDialog title="Trigger kill switch" danger confirmLabel="Trigger" reasonLabel="Note" body={<p>All new orders stop immediately. Risk-reducing exits remain allowed. Releasing later requires password confirmation.</p>} onCancel={() => setConfirm(null)} onConfirm={async (note) => { await post(scoped("kill-switch"), { active: true, note }); await invalidate(scoped("risk"), "/accounts"); setConfirm(null); }} />
      )}
      {confirm === "release" && (
        <ConfirmDialog title="Release kill switch" confirmLabel="Release" requireText="RELEASE" body={<p>Trading resumes under the current autonomy level and risk limits. Make sure the underlying reason ({ks.reasons.map(fmt.label).join(", ") || "manual"}) is resolved.</p>} onCancel={() => setConfirm(null)} onConfirm={async () => { await post(scoped("kill-switch"), { active: false }); await invalidate(scoped("risk"), "/accounts"); setConfirm(null); }} />
      )}
    </div>
  );
}

type NumKey = { [K in keyof RiskSettings]: RiskSettings[K] extends number ? K : never }[keyof RiskSettings];
const PCT_FIELDS: { key: NumKey; label: string; hint?: string }[] = [
  { key: "maxCapitalDeployedPct", label: "Max capital deployed %" },
  { key: "maxPositionPct", label: "Max position %" },
  { key: "maxSectorPct", label: "Max sector %" },
  { key: "maxCorrelatedExposurePct", label: "Max correlated exposure %" },
  { key: "maxDailyLossPct", label: "Max daily loss %", hint: "Kill switch trigger" },
  { key: "maxWeeklyLossPct", label: "Max weekly loss %", hint: "Kill switch trigger" },
  { key: "maxDrawdownPct", label: "Max drawdown %", hint: "Kill switch trigger" },
  { key: "maxOptionsExposurePct", label: "Max options exposure %" },
  { key: "maxLossPerTradePct", label: "Max loss per trade %" },
  { key: "maxAnnualizedVolatility", label: "Max annualized volatility %" },
];
const NUM_FIELDS: { key: NumKey; label: string; step: number; hint?: string }[] = [
  { key: "maxPortfolioBeta", label: "Max portfolio beta", step: 0.05 },
  { key: "maxSimultaneousPositions", label: "Max simultaneous positions", step: 1 },
  { key: "minLiquidityAdv", label: "Min avg daily $ volume", step: 100000 },
  { key: "minConfidence", label: "Min confidence (0–1)", step: 0.01 },
  { key: "minExpectedEdge", label: "Min expected edge (0–1)", step: 0.01 },
  { key: "maxSpreadBps", label: "Max spread (bps)", step: 1 },
  { key: "semiAutoApprovalNotional", label: "Semi-auto approval notional ($)", step: 100, hint: "Entries above this wait for approval in semi-autonomous mode" },
  { key: "kellyFraction", label: "Kelly fraction cap (0–0.5)", step: 0.01 },
];

function SettingsForm({ initial, readOnly, onSave }: { initial: RiskSettings; readOnly: boolean; onSave: (s: RiskSettings) => Promise<void> }) {
  const [s, setS] = useState<RiskSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setS(initial), [initial]);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const setNum = (k: NumKey, v: number) => setS((p) => ({ ...p, [k]: v }));

  return (
    <Panel title="Risk limits" actions={readOnly ? <Badge tone="warn">Read-only</Badge> : dirty ? <Badge tone="warn">Unsaved changes</Badge> : null} foot="Saving requires password (+ MFA) confirmation and is audited. Limits apply to this account only.">
      <fieldset disabled={readOnly || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <h3 style={{ marginBottom: 6 }}>Exposure & loss limits</h3>
        <div className="form-grid">
          {PCT_FIELDS.map((f) => <Field key={f.key} label={f.label} hint={f.hint}><input type="number" min={0} max={f.key === "maxAnnualizedVolatility" ? 500 : 100} step={0.1} value={Math.round(s[f.key] * 10000) / 100} onChange={(e) => setNum(f.key, Number(e.target.value) / 100)} /></Field>)}
        </div>
        <h3 style={{ margin: "14px 0 6px" }}>Thresholds & sizing</h3>
        <div className="form-grid">
          {NUM_FIELDS.map((f) => <Field key={f.key} label={f.label} hint={f.hint}><input type="number" min={0} step={f.step} value={s[f.key]} onChange={(e) => setNum(f.key, Number(e.target.value))} /></Field>)}
        </div>
        <h3 style={{ margin: "14px 0 6px" }}>Trading hours & instruments</h3>
        <div className="form-grid">
          <Field label="Start"><input type="text" value={s.tradingHours.start} pattern="\d{2}:\d{2}" onChange={(e) => setS({ ...s, tradingHours: { ...s.tradingHours, start: e.target.value } })} /></Field>
          <Field label="End"><input type="text" value={s.tradingHours.end} pattern="\d{2}:\d{2}" onChange={(e) => setS({ ...s, tradingHours: { ...s.tradingHours, end: e.target.value } })} /></Field>
          <Field label="Timezone"><input type="text" value={s.tradingHours.timezone} onChange={(e) => setS({ ...s, tradingHours: { ...s.tradingHours, timezone: e.target.value } })} /></Field>
          <Field label="Extended hours"><label className="check"><input type="checkbox" checked={s.tradingHours.allowExtendedHours} onChange={(e) => setS({ ...s, tradingHours: { ...s.tradingHours, allowExtendedHours: e.target.checked } })} /> Allow</label></Field>
          <Field label="Options"><label className="check"><input type="checkbox" checked={s.optionsEnabled} onChange={(e) => setS({ ...s, optionsEnabled: e.target.checked })} /> Enable options</label></Field>
          <Field label="Restricted symbols"><SymbolsInput value={s.restrictedSymbols} onChange={(v) => setS({ ...s, restrictedSymbols: v ?? [] })} /></Field>
          <Field label="Allowed symbols" hint="Blank = any symbol"><SymbolsInput value={s.allowedSymbols} onChange={(v) => setS({ ...s, allowedSymbols: v })} /></Field>
        </div>
      </fieldset>
      {!readOnly && (
        <div className="form-actions">
          {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
          <button className="btn" disabled={!dirty || busy} onClick={() => { setS(initial); setMsg(null); }}>Discard</button>
          <button className="btn primary" disabled={!dirty || busy} onClick={async () => { setBusy(true); setMsg(null); try { await onSave(s); setMsg({ ok: true, text: "Limits saved." }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } finally { setBusy(false); } }}>{busy ? "Saving…" : "Save limits (confirm identity)"}</button>
        </div>
      )}
    </Panel>
  );
}
