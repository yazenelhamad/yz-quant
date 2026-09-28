import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { errorMessage, put } from "../api/client";
import { useApi, useInvalidate } from "../api/hooks";
import { STRATEGY_STAGE_ORDER, type AccountStrategiesResponse, type AccountStrategyRow, type PerformanceStats, type StrategyDetailResponse, type StrategyIntelligenceProfile, type StrategyScorecard, type StrategyStage, type UserStrategySettings } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { Badge, StageBadge } from "../components/Badge";
import { CalibrationChart } from "../components/charts/CalibrationChart";
import { Column, DataTable } from "../components/DataTable";
import { Field, KV, PageHeader, SymbolsInput } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, Loading, QueryState } from "../components/States";
import { fmt } from "../lib/fmt";

export function StrategiesPage() {
  const scoped = useScoped();
  const { base, isOwner } = useAccount();
  const { strategyId } = useParams();
  const navigate = useNavigate();
  const q = useApi<AccountStrategiesResponse>(scoped("strategies"));

  const cols: Column<AccountStrategyRow>[] = [
    { key: "name", header: "Strategy", render: (s) => <><strong>{s.name}</strong> <span className="mono tiny muted">{s.key}</span>{s.globallyDisabled && <> <Badge tone="neg">Disabled globally</Badge></>}{s.visibility !== "shared" && <> <Badge tone="outline">Private</Badge></>}</>, sortValue: (s) => s.name },
    { key: "family", header: "Family", render: (s) => fmt.label(s.family), sortValue: (s) => s.family },
    { key: "gstage", header: "Global stage", render: (s) => <StageBadge stage={s.globalStage} />, sortValue: (s) => STRATEGY_STAGE_ORDER.indexOf(s.globalStage) },
    { key: "stage", header: "Account stage", render: (s) => <StageBadge stage={s.settings.stage} />, sortValue: (s) => STRATEGY_STAGE_ORDER.indexOf(s.settings.stage) },
    { key: "enabled", header: "Enabled", render: (s) => s.settings.enabled ? <Badge tone="pos">On</Badge> : <Badge>Off</Badge>, sortValue: (s) => (s.settings.enabled ? 1 : 0) },
    { key: "alloc", header: "Allocation", align: "right", render: (s) => fmt.score(s.settings.capitalAllocation, 0), sortValue: (s) => s.settings.capitalAllocation },
    { key: "maxpos", header: "Max position", align: "right", render: (s) => fmt.pct(s.settings.maxPositionPct, { digits: 1 }), sortValue: (s) => s.settings.maxPositionPct },
    { key: "trades", header: "Trades", align: "right", render: (s) => fmt.int(s.scorecard?.stats.trades), sortValue: (s) => s.scorecard?.stats.trades },
    { key: "wr", header: "Win rate", align: "right", render: (s) => fmt.score(s.scorecard?.stats.winRate), sortValue: (s) => s.scorecard?.stats.winRate },
    { key: "pf", header: "Profit factor", align: "right", render: (s) => fmt.num(s.scorecard?.stats.profitFactor, 2), sortValue: (s) => s.scorecard?.stats.profitFactor },
    { key: "exp", header: "Expectancy", align: "right", render: (s) => <span className={fmt.signClass(s.scorecard?.stats.expectancyPct)}>{fmt.pct(s.scorecard?.stats.expectancyPct, { signed: true })}</span>, sortValue: (s) => s.scorecard?.stats.expectancyPct },
    { key: "profile", header: "", render: (s) => <button className="btn sm" onClick={(e) => { e.stopPropagation(); navigate(`${base}/strategies/${s.id}`); }}>Intelligence profile</button> },
  ];

  return (
    <>
      <PageHeader title="Strategies" sub="Shared strategy library with this account's own settings. A strategy can never run beyond its global stage here." />
      <div className="stack">
        <QueryState query={q} isEmpty={(d) => d.strategies.length === 0} empty={<EmptyState title="No strategies in the library" />}>
          {(d) => (
            <>
              <ScorecardCards rows={d.strategies.filter((s) => s.settings.enabled)} />
              <Panel flush title="Library">
                <DataTable rows={d.strategies} columns={cols} rowKey={(s) => s.id} defaultSort={{ key: "enabled", dir: "desc" }} renderExpanded={(s) => <SettingsEditor row={s} path={scoped(`strategies/${s.id}/settings`)} readOnly={!isOwner} listPath={scoped("strategies")} />} />
              </Panel>
            </>
          )}
        </QueryState>
        {strategyId && <ProfilePanel strategyId={strategyId} accountRow={q.data?.strategies.find((s) => s.id === strategyId) ?? null} onClose={() => navigate(`${base}/strategies`)} />}
      </div>
    </>
  );
}

function ScorecardCards({ rows }: { rows: AccountStrategyRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="grid auto">
      {rows.map((s) => <ScorecardCard key={s.id} name={s.name} stage={s.settings.stage} card={s.scorecard} />)}
    </div>
  );
}

function ScorecardCard({ name, stage, card }: { name: string; stage: StrategyStage; card: StrategyScorecard | null }) {
  return (
    <div className="kpi">
      <div className="row between"><span className="kpi-label">{name}</span><StageBadge stage={stage} /></div>
      {card ? (
        <>
          <div className={`kpi-value ${fmt.signClass(card.stats.expectancyPct)}`}>{fmt.pct(card.stats.expectancyPct, { signed: true })}</div>
          <div className="kpi-sub">expectancy · {card.stats.trades} {card.mode} trades · WR {fmt.score(card.stats.winRate)} · PF {fmt.num(card.stats.profitFactor, 2)} · Sharpe {fmt.num(card.stats.sharpe, 2)}</div>
          <div className="tiny muted">last trade {card.lastTradeAt ? fmt.ago(card.lastTradeAt) : "never"}</div>
        </>
      ) : <div className="kpi-value na">No trades yet</div>}
    </div>
  );
}

function SettingsEditor({ row, path, readOnly, listPath }: { row: AccountStrategyRow; path: string; readOnly: boolean; listPath: string }) {
  const [s, setS] = useState<UserStrategySettings>(row.settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const invalidate = useInvalidate();
  useEffect(() => setS(row.settings), [row.settings]);

  const maxIdx = STRATEGY_STAGE_ORDER.indexOf(row.globalStage);
  const stages: StrategyStage[] = [...STRATEGY_STAGE_ORDER.slice(0, Math.max(0, maxIdx) + 1), "paused"];
  const set = <K extends keyof UserStrategySettings>(k: K, v: UserStrategySettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const pctIn = (v: number) => Math.round(v * 10000) / 100;
  const pctOut = (v: string) => (v === "" ? 0 : Number(v) / 100);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await put(path, s);
      await invalidate(listPath);
      setMsg({ ok: true, text: "Saved." });
    } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } finally { setBusy(false); }
  };

  return (
    <div>
      <p className="dim small">{row.description}</p>
      {readOnly && <div className="banner warn small" style={{ marginBottom: 8 }}>Read-only: only the account owner can change strategy settings.</div>}
      <fieldset disabled={readOnly || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field label="Enabled"><label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Run for this account</label></Field>
          <Field label="Stage" hint={`Global stage: ${fmt.label(row.globalStage)}. Enabling live requires confirmation.`}>
            <select value={s.stage} onChange={(e) => set("stage", e.target.value as StrategyStage)}>{stages.map((st) => <option key={st} value={st}>{fmt.label(st)}</option>)}</select>
          </Field>
          <Field label="Capital allocation %" hint="Share of deployable capital"><input type="number" min={0} max={100} step={1} value={pctIn(s.capitalAllocation)} onChange={(e) => set("capitalAllocation", pctOut(e.target.value))} /></Field>
          <Field label="Max position %"><input type="number" min={0} max={100} step={0.5} value={pctIn(s.maxPositionPct)} onChange={(e) => set("maxPositionPct", pctOut(e.target.value))} /></Field>
          <Field label="Max loss per trade %"><input type="number" min={0} max={100} step={0.1} value={pctIn(s.maxLossPerTradePct)} onChange={(e) => set("maxLossPerTradePct", pctOut(e.target.value))} /></Field>
          <Field label="Min confidence" hint="Blank = account default"><input type="number" min={0} max={1} step={0.01} value={s.minConfidence ?? ""} onChange={(e) => set("minConfidence", e.target.value === "" ? null : Number(e.target.value))} /></Field>
          <Field label="Min expected edge" hint="Blank = account default"><input type="number" min={0} max={1} step={0.01} value={s.minExpectedEdge ?? ""} onChange={(e) => set("minExpectedEdge", e.target.value === "" ? null : Number(e.target.value))} /></Field>
          <Field label="Options"><label className="check"><input type="checkbox" checked={s.optionsAllowed} onChange={(e) => set("optionsAllowed", e.target.checked)} /> Allow options</label></Field>
          <Field label="Allowed symbols" hint="Blank = no restriction"><SymbolsInput value={s.allowedSymbols} onChange={(v) => set("allowedSymbols", v)} /></Field>
          <Field label="Blocked symbols"><SymbolsInput value={s.blockedSymbols} onChange={(v) => set("blockedSymbols", v ?? [])} /></Field>
        </div>
      </fieldset>
      {!readOnly && (
        <div className="form-actions">
          {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
          <button className="btn" onClick={() => setS(row.settings)} disabled={busy}>Reset</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
        </div>
      )}
    </div>
  );
}

function StatsRow({ label, s }: { label: string; s: PerformanceStats }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmt.int(s.trades)}</td>
      <td className="num">{fmt.score(s.winRate)}</td>
      <td className="num">{fmt.num(s.profitFactor, 2)}</td>
      <td className={`num ${fmt.signClass(s.expectancyPct)}`}>{fmt.pct(s.expectancyPct, { signed: true })}</td>
      <td className="num">{fmt.num(s.sharpe, 2)}</td>
      <td className="num">{fmt.pct(s.maxDrawdownPct, { digits: 1 })}</td>
      <td className="num">{fmt.bps(s.avgSlippageBps)}</td>
    </tr>
  );
}

export function StatsTable({ rows }: { rows: [string, PerformanceStats][] }) {
  if (rows.length === 0) return <EmptyState title="No data" />;
  return (
    <table className="data compact">
      <thead><tr><th>Bucket</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">PF</th><th className="num">Expectancy</th><th className="num">Sharpe</th><th className="num">Max DD</th><th className="num">Slippage</th></tr></thead>
      <tbody>{rows.map(([k, s]) => <StatsRow key={k} label={fmt.label(k)} s={s} />)}</tbody>
    </table>
  );
}

function ProfilePanel({ strategyId, accountRow, onClose }: { strategyId: string; accountRow: AccountStrategyRow | null; onClose: () => void }) {
  const q = useApi<StrategyDetailResponse>(`/strategies/${encodeURIComponent(strategyId)}`);
  return (
    <Panel title={<h2>Strategy intelligence profile{q.data ? ` · ${q.data.strategy.name}` : ""}</h2>} actions={<button className="btn ghost sm" onClick={onClose}>Close</button>}>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <ProfileBody d={q.data} accountRow={accountRow} />}
    </Panel>
  );
}

function ProfileBody({ d, accountRow }: { d: StrategyDetailResponse; accountRow: AccountStrategyRow | null }) {
  const p: StrategyIntelligenceProfile | null = d.profile;
  const [bucket, setBucket] = useState<"byRegime" | "byVolRegime" | "bySector" | "byHoldingPeriod" | "byConfidenceBucket" | "byLiquidity" | "bySignalStrength" | "byTimeOfDay">("byRegime");
  if (!p) return <EmptyState title="No intelligence profile yet" detail="The learning engine builds a profile once the strategy has enough shadow or live outcomes." />;
  const a = p.assessment;
  const statusTone = a.recommendedStatus === "keep_live" || a.recommendedStatus === "increase" ? "pos" : a.recommendedStatus === "insufficient_data" ? "outline" : "warn";
  const currentAlloc = accountRow?.settings.capitalAllocation ?? null;
  const recommended = currentAlloc === null ? null : Math.max(0, currentAlloc + a.recommendedAllocationDelta);
  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="kpi"><div className="kpi-label">Status</div><div className="kpi-value" style={{ fontSize: 16 }}><Badge tone={statusTone}>{fmt.label(a.recommendedStatus)}</Badge></div><div className="kpi-sub">Still working: {a.stillWorking === null ? "unknown" : a.stillWorking ? "yes" : "no"} · edge {a.edgeTrend}</div></div>
        <div className="kpi"><div className="kpi-label">Degradation</div><div className="kpi-value">{fmt.num(p.degradation.score, 2)}</div><div className="kpi-sub">{fmt.label(p.degradation.trend)} · stability {fmt.num(p.stability, 2)}</div></div>
        <div className="kpi"><div className="kpi-label">Signal decay</div><div className="kpi-value">{p.signalDecay.halfLifeDays === null ? <span className="na">unknown</span> : fmt.days(p.signalDecay.halfLifeDays)}</div><div className="kpi-sub">half-life · recent vs long-term edge {fmt.signed(p.signalDecay.recentVsLongTermEdge)}</div></div>
        <div className="kpi"><div className="kpi-label">Execution drag</div><div className={`kpi-value ${a.executionDestroyingEdge ? "neg" : ""}`}>{fmt.pct(p.executionDrag.dragPct, { digits: 2 })}</div><div className="kpi-sub">theoretical {fmt.pct(p.executionDrag.theoreticalEdgePct)} → realized {fmt.pct(p.executionDrag.realizedEdgePct)}</div></div>
      </div>
      <div className="explanation"><h3>Assessment</h3><div className="text">{a.plainEnglish || "No narrative assessment."}</div>
        <div className="grid cols-2" style={{ marginTop: 8 }}>
          <div><h3>Working where</h3>{a.workingWhere.length ? <ul className="bullets tight">{a.workingWhere.map((w, i) => <li key={i}>{w}</li>)}</ul> : <span className="muted small">—</span>}</div>
          <div><h3>Failing where</h3>{a.failingWhere.length ? <ul className="bullets tight">{a.failingWhere.map((w, i) => <li key={i}>{w}</li>)}</ul> : <span className="muted small">—</span>}</div>
        </div>
      </div>
      <div className="grid cols-2">
        <div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <h3>Performance by</h3>
            <select value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)}>
              {(["byRegime", "byVolRegime", "bySector", "byHoldingPeriod", "byConfidenceBucket", "byLiquidity", "bySignalStrength", "byTimeOfDay"] as const).map((k) => <option key={k} value={k}>{fmt.label(k.replace(/^by/, ""))}</option>)}
            </select>
          </div>
          <StatsTable rows={Object.entries(p[bucket])} />
          <h3 style={{ margin: "12px 0 6px" }}>Recent vs long-term</h3>
          <StatsTable rows={[["recent", p.recent], ["overall", p.overall]]} />
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Confidence calibration</h3>
          <CalibrationChart profile={p.calibration} />
          <h3 style={{ margin: "12px 0 6px" }}>Allocation</h3>
          <KV items={[
            ["Current (this account)", currentAlloc === null ? "not configured" : fmt.score(currentAlloc, 0)],
            ["Recommended delta", fmt.signed(a.recommendedAllocationDelta * 100, 1) + " pp"],
            ["Recommended", recommended === null ? "—" : fmt.score(recommended, 0)],
            ["Overconfident", a.overconfident === null ? "unknown" : a.overconfident ? <span className="warn-text">yes</span> : "no"],
            ["Correlation to others", Object.keys(p.correlationToOtherStrategies).length ? Object.entries(p.correlationToOtherStrategies).map(([k, v]) => <span className="tag" key={k}>{k} {fmt.num(v, 2)}</span>) : "—"],
            ["Profile mode", p.mode],
            ["Updated", fmt.dateTime(p.updatedAt)],
          ]} />
          {p.degradation.notes.length > 0 && <><h3 style={{ margin: "12px 0 6px" }}>Notes</h3><ul className="bullets tight small">{p.degradation.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
        </div>
      </div>
      {d.versions.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Versions</h3>
          <table className="data compact">
            <thead><tr><th>Version</th><th>Status</th><th>Proposed by</th><th>Summary</th><th>Deployed</th></tr></thead>
            <tbody>{d.versions.map((v) => <tr key={v.id}><td className="mono">{v.version}</td><td><Badge tone={v.approvalStatus === "approved" ? "pos" : v.approvalStatus === "rejected" ? "neg" : "outline"}>{v.approvalStatus}</Badge></td><td>{fmt.label(v.proposedBy.kind)}</td><td className="wrap">{v.changeSummary}</td><td>{fmt.date(v.deployedAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
