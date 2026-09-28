import { useEffect, useState } from "react";
import { errorMessage, post, put } from "../../api/client";
import { useApi, useInvalidate } from "../../api/hooks";
import type { AdminUsersResponse, GlobalRiskState, SharedStrategiesResponse } from "../../api/types";
import { useStepUp } from "../../auth/StepUpProvider";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/Dialog";
import { Banner, Field, KV, PageHeader } from "../../components/Controls";
import { Panel } from "../../components/Panel";
import { QueryState } from "../../components/States";
import { fmt } from "../../lib/fmt";

export function GlobalRiskPage() {
  const q = useApi<GlobalRiskState>("/admin/global-risk", { refetchInterval: 30_000 });
  const users = useApi<AdminUsersResponse>("/admin/users");
  const strategies = useApi<SharedStrategiesResponse>("/strategies");
  return (
    <>
      <PageHeader title="Global risk controls" sub="Platform-wide overrides that take precedence over every account's own settings. Every change requires identity confirmation and is audited." />
      <QueryState query={q}>{(d) => <Body d={d} userOptions={users.data?.users ?? []} strategyOptions={strategies.data?.strategies ?? []} />}</QueryState>
    </>
  );
}

function Body({ d, userOptions, strategyOptions }: { d: GlobalRiskState; userOptions: AdminUsersResponse["users"]; strategyOptions: SharedStrategiesResponse["strategies"] }) {
  const invalidate = useInvalidate();
  const { ensureFresh } = useStepUp();
  const [s, setS] = useState(d);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"save" | "kill" | "release" | null>(null);
  useEffect(() => setS(d), [d]);
  const dirty = JSON.stringify({ a: s.pausedUsers, b: s.liveExecutionDisabled, c: s.forceShadowMode, e: s.disabledStrategyIds }) !== JSON.stringify({ a: d.pausedUsers, b: d.liveExecutionDisabled, c: d.forceShadowMode, e: d.disabledStrategyIds });
  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const userName = (id: string) => userOptions.find((u) => u.id === id)?.displayName ?? id;
  const stratName = (id: string) => strategyOptions.find((x) => x.id === id)?.name ?? id;

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const ok = await ensureFresh("Changing global risk controls requires confirmation.");
      if (!ok) throw new Error("Confirmation cancelled.");
      await put("/admin/global-risk", { pausedUsers: s.pausedUsers, liveExecutionDisabled: s.liveExecutionDisabled, forceShadowMode: s.forceShadowMode, disabledStrategyIds: s.disabledStrategyIds, globalKillSwitch: d.globalKillSwitch });
      await invalidate("/admin/global-risk", "/accounts");
      setMsg({ ok: true, text: "Global controls saved." });
    } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } finally { setBusy(false); setConfirm(null); }
  };

  const ks = d.globalKillSwitch;
  return (
    <div className="stack">
      {(d.liveExecutionDisabled || d.forceShadowMode || d.pausedUsers.length > 0 || ks.active) && (
        <Banner tone="warn"><strong>Overrides in force:</strong> {[ks.active && "GLOBAL KILL SWITCH", d.liveExecutionDisabled && "live execution disabled", d.forceShadowMode && "shadow mode forced", d.pausedUsers.length > 0 && `paused: ${d.pausedUsers.map(userName).join(", ")}`].filter(Boolean).join(" · ")}</Banner>
      )}
      <div className="grid cols-2">
        <Panel title="Pause users" foot="A paused user's accounts place no new orders. Risk-reducing exits remain allowed.">
          {userOptions.length === 0 ? <div className="muted small">Loading users…</div> : userOptions.map((u) => (
            <label key={u.id} className="check" style={{ padding: "4px 0" }}><input type="checkbox" checked={s.pausedUsers.includes(u.id)} onChange={() => setS({ ...s, pausedUsers: toggle(s.pausedUsers, u.id) })} /> Pause <strong>{u.displayName}</strong> <span className="muted tiny">{u.email}</span></label>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => setS({ ...s, pausedUsers: userOptions.map((u) => u.id) })}>Pause both</button>
            <button className="btn sm" onClick={() => setS({ ...s, pausedUsers: [] })}>Unpause all</button>
          </div>
        </Panel>
        <Panel title="Execution mode">
          <div className="stack" style={{ gap: 8 }}>
            <label className="check"><input type="checkbox" checked={s.liveExecutionDisabled} onChange={(e) => setS({ ...s, liveExecutionDisabled: e.target.checked })} /> <span><strong>Disable live execution</strong><div className="small dim">No order reaches Robinhood for any account. Shadow trading continues.</div></span></label>
            <label className="check"><input type="checkbox" checked={s.forceShadowMode} onChange={(e) => setS({ ...s, forceShadowMode: e.target.checked })} /> <span><strong>Force shadow mode</strong><div className="small dim">Every account behaves as if its autonomy level were <em>shadow</em>, regardless of its own setting.</div></span></label>
          </div>
        </Panel>
      </div>
      <Panel title="Disable strategies globally" foot="A globally disabled strategy produces no candidates for any account.">
        <div className="form-grid">
          {strategyOptions.map((st) => <label key={st.id} className="check"><input type="checkbox" checked={s.disabledStrategyIds.includes(st.id)} onChange={() => setS({ ...s, disabledStrategyIds: toggle(s.disabledStrategyIds, st.id) })} /> {st.name} <Badge tone="outline">{fmt.label(st.stage)}</Badge></label>)}
        </div>
      </Panel>
      <div className="form-actions">
        {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
        <button className="btn" disabled={!dirty || busy} onClick={() => setS(d)}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => setConfirm("save")}>Apply changes (confirm identity)</button>
      </div>
      <Panel title="Global kill switch" actions={<Badge tone={ks.active ? "neg" : "pos"}>{ks.active ? "ACTIVE" : "Inactive"}</Badge>}>
        {ks.active ? <KV items={[["Reasons", ks.reasons.map((r) => <span className="tag" key={r}>{fmt.label(r)}</span>)], ["Triggered", `${fmt.dateTime(ks.triggeredAt)} by ${ks.triggeredBy ?? "system"}`], ["Note", ks.note ?? "—"]]} /> : <p className="dim small">Stops every account at once. Use when the platform itself is suspect (data, broker, model output).</p>}
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          {ks.active ? <button className="btn primary" onClick={() => setConfirm("release")}>Release global kill switch</button> : <button className="btn danger solid" onClick={() => setConfirm("kill")}>Trigger global kill switch</button>}
        </div>
        <div className="tiny muted">updated {fmt.dateTime(d.updatedAt)} by {d.updatedBy ?? "—"}</div>
      </Panel>
      {confirm === "save" && <ConfirmDialog title="Apply global risk changes" confirmLabel="Apply" body={<ul className="bullets small"><li>Paused users: {s.pausedUsers.length ? s.pausedUsers.map(userName).join(", ") : "none"}</li><li>Live execution: {s.liveExecutionDisabled ? "DISABLED" : "enabled"}</li><li>Shadow mode forced: {s.forceShadowMode ? "yes" : "no"}</li><li>Disabled strategies: {s.disabledStrategyIds.length ? s.disabledStrategyIds.map(stratName).join(", ") : "none"}</li></ul>} onCancel={() => setConfirm(null)} onConfirm={save} />}
      {confirm === "kill" && <ConfirmDialog title="Trigger GLOBAL kill switch" danger confirmLabel="Trigger" requireText="KILL ALL" reasonLabel="Note" body={<p>All accounts stop placing new orders immediately.</p>} onCancel={() => setConfirm(null)} onConfirm={async (note) => { const ok = await ensureFresh("Triggering the global kill switch requires confirmation."); if (!ok) throw new Error("Confirmation cancelled."); await put("/admin/global-risk", { ...d, globalKillSwitch: { ...ks, active: true, reasons: ["admin_global"], note } }); await invalidate("/admin/global-risk", "/accounts"); setConfirm(null); }} />}
      {confirm === "release" && <ConfirmDialog title="Release global kill switch" confirmLabel="Release" requireText="RELEASE" body={<p>Accounts return to their own autonomy levels and limits.</p>} onCancel={() => setConfirm(null)} onConfirm={async () => { const ok = await ensureFresh("Releasing the global kill switch requires confirmation."); if (!ok) throw new Error("Confirmation cancelled."); await put("/admin/global-risk", { ...d, globalKillSwitch: { ...ks, active: false, reasons: [], note: null } }); await invalidate("/admin/global-risk", "/accounts"); setConfirm(null); }} />}
      <StageControl strategies={strategyOptions} />
    </div>
  );
}

function StageControl({ strategies }: { strategies: SharedStrategiesResponse["strategies"] }) {
  const invalidate = useInvalidate();
  const { ensureFresh } = useStepUp();
  const [id, setId] = useState("");
  const [stage, setStage] = useState("live_shadow");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Panel title="Promotion review — set global stage" foot="Each transition is recorded as a promotion review. Users cannot exceed the global stage.">
      <form className="form-row" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setMsg(null); try { const ok = await ensureFresh("Changing a strategy's stage requires confirmation."); if (!ok) throw new Error("Confirmation cancelled."); await post(`/admin/strategies/${encodeURIComponent(id)}/stage`, { stage, reason }); await invalidate("/strategies", "/accounts"); setMsg({ ok: true, text: "Stage updated." }); setReason(""); } catch (err) { setMsg({ ok: false, text: errorMessage(err) }); } finally { setBusy(false); } }}>
        <Field label="Strategy"><select value={id} onChange={(e) => setId(e.target.value)} required><option value="">Select…</option>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name} ({fmt.label(s.stage)})</option>)}</select></Field>
        <Field label="New stage"><select value={stage} onChange={(e) => setStage(e.target.value)}>{["research", "backtest", "out_of_sample", "walk_forward", "live_shadow", "limited_live", "live", "paused", "retired"].map((s) => <option key={s} value={s}>{fmt.label(s)}</option>)}</select></Field>
        <Field label="Reason"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required style={{ minWidth: 260 }} /></Field>
        <button className="btn primary" disabled={busy || !id}>Record promotion review</button>
        {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
      </form>
    </Panel>
  );
}
