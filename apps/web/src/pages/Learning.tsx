import { useState } from "react";
import { useApi } from "../api/hooks";
import type { AgentIntelligenceProfile, LearningView, ModelIntelligenceProfile, RejectedTrade, StrategyTrendItem, SignalTrendItem } from "../api/types";
import { useScoped } from "../app/AccountContext";
import { Badge } from "../components/Badge";
import { CalibrationChart } from "../components/charts/CalibrationChart";
import { Column, DataTable } from "../components/DataTable";
import { PageHeader, Segmented } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { HealthPill } from "../components/StatusPill";
import { fmt } from "../lib/fmt";

export function LearningPage() {
  const scoped = useScoped();
  const [scope, setScope] = useState<"account" | "shared">("account");
  const q = useApi<LearningView>(scope === "account" ? scoped("learning") : "/learning");
  return (
    <>
      <PageHeader title="Learning" sub="What the system learned, in plain English. Learning only proposes bounded parameter changes; it never deploys new live logic." actions={<Segmented value={scope} options={[{ value: "account", label: "This account" }, { value: "shared", label: "Shared (all accounts)" }]} onChange={setScope} />} />
      <QueryState query={q}>{(d) => <Body d={d} />}</QueryState>
    </>
  );
}

function Digest({ title, d }: { title: string; d: LearningView["today"] }) {
  return (
    <Panel title={title}>
      {!d ? <EmptyState title="Nothing learned yet" detail="No trades were reviewed in this period." /> : (
        <div className="stack" style={{ gap: 6 }}>
          <div className="pre">{d.summary}</div>
          {d.highlights.length > 0 && <ul className="bullets">{d.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>}
          <div className="tiny muted">generated {fmt.dateTime(d.generatedAt)}{typeof d.tradesReviewed === "number" ? ` · ${d.tradesReviewed} trades reviewed` : ""}</div>
        </div>
      )}
    </Panel>
  );
}

function StrategyTrend({ items, tone }: { items: StrategyTrendItem[]; tone: "pos" | "neg" }) {
  if (items.length === 0) return <EmptyState title="None" />;
  return <ul className="list">{items.map((s) => <li key={s.strategyKey}><Badge tone={tone}>{fmt.label(s.trend)}</Badge><span className="grow"><strong>{s.name ?? s.strategyKey}</strong> <span className="dim">{s.note}</span></span><span className="when">{fmt.pct(s.longTermExpectancyPct, { signed: true })} → {fmt.pct(s.recentExpectancyPct, { signed: true })}</span></li>)}</ul>;
}
function SignalTrend({ items, tone }: { items: SignalTrendItem[]; tone: "pos" | "neg" }) {
  if (items.length === 0) return <EmptyState title="None" />;
  return <ul className="list">{items.map((s) => <li key={s.signalKey}><Badge tone={tone}>{tone === "pos" ? "Improving" : "Deteriorating"}</Badge><span className="grow"><span className="mono">{s.signalKey}</span> <span className="dim">{s.note}</span></span><span className="when">IC {fmt.num(s.historicalPredictiveValue, 3)} → {fmt.num(s.recentPredictiveValue, 3)} · w {fmt.num(s.currentWeight, 2)}</span></li>)}</ul>;
}

function Body({ d }: { d: LearningView }) {
  const [calKey, setCalKey] = useState<string>(d.calibration[0]?.key ?? "");
  const cal = d.calibration.find((c) => c.key === calKey) ?? d.calibration[0] ?? null;

  const modelCols: Column<ModelIntelligenceProfile>[] = [
    { key: "name", header: "Model", render: (m) => <><strong>{m.modelName}</strong> <span className="muted tiny">{m.modelVersion}</span></>, sortValue: (m) => m.modelName },
    { key: "acc", header: "Accuracy", align: "right", render: (m) => fmt.score(m.accuracy), sortValue: (m) => m.accuracy },
    { key: "brier", header: "Brier", align: "right", render: (m) => fmt.num(m.calibration.brierScore, 3), sortValue: (m) => m.calibration.brierScore },
    { key: "value", header: "Value added", align: "right", render: (m) => <span className={fmt.signClass(m.valueAdded)}>{fmt.signed(m.valueAdded, 3)}</span>, sortValue: (m) => m.valueAdded },
    { key: "lat", header: "p50 latency", align: "right", render: (m) => m.latencyMsP50 === null ? "—" : fmt.duration(m.latencyMsP50), sortValue: (m) => m.latencyMsP50 },
    { key: "fail", header: "Failure rate", align: "right", render: (m) => fmt.score(m.failureRate, 1), sortValue: (m) => m.failureRate },
    { key: "cost", header: "Cost", align: "right", render: (m) => fmt.money(m.costUsd), sortValue: (m) => m.costUsd },
    { key: "w", header: "Routing weight", align: "right", render: (m) => fmt.num(m.routingWeight, 2), sortValue: (m) => m.routingWeight },
  ];
  const agentCols: Column<AgentIntelligenceProfile>[] = [
    { key: "name", header: "Agent", render: (a) => <strong>{fmt.label(a.agentName)}</strong>, sortValue: (a) => a.agentName },
    { key: "n", header: "Decisions influenced", align: "right", render: (a) => fmt.int(a.decisionsInfluenced), sortValue: (a) => a.decisionsInfluenced },
    { key: "value", header: "Value added", align: "right", render: (a) => <span className={fmt.signClass(a.valueAdded)}>{fmt.signed(a.valueAdded, 3)}</span>, sortValue: (a) => a.valueAdded },
    { key: "veto", header: "Veto accuracy", align: "right", render: (a) => fmt.score(a.vetoAccuracy), sortValue: (a) => a.vetoAccuracy },
    { key: "brier", header: "Brier", align: "right", render: (a) => fmt.num(a.calibration.brierScore, 3), sortValue: (a) => a.calibration.brierScore },
    { key: "w", header: "Influence weight", align: "right", render: (a) => fmt.num(a.influenceWeight, 2), sortValue: (a) => a.influenceWeight },
  ];
  const missedCols: Column<RejectedTrade>[] = [
    { key: "at", header: "Rejected", render: (r) => fmt.dateTime(r.rejectedAt), sortValue: (r) => r.rejectedAt },
    { key: "symbol", header: "Symbol", render: (r) => <strong>{r.symbol}</strong>, sortValue: (r) => r.symbol },
    { key: "strategy", header: "Strategy", render: (r) => <span className="mono small">{r.strategyKey ?? r.strategyId}</span> },
    { key: "reasons", header: "Reasons", render: (r) => r.reasons.map((x) => <span className="tag" key={x}>{fmt.label(x)}</span>) },
    { key: "after", header: "Subsequent return", render: (r) => r.subsequentReturnPct ? Object.entries(r.subsequentReturnPct).map(([h, v]) => <span className={`tag ${fmt.signClass(v)}`} key={h}>{h} {fmt.pct(v, { signed: true, digits: 1 })}</span>) : <span className="muted">pending</span> },
    { key: "verdict", header: "Verdict", render: (r) => r.reviewVerdict ? <Badge tone={r.reviewVerdict === "missed_opportunity" ? "warn" : r.reviewVerdict === "correct_rejection" ? "pos" : "outline"}>{fmt.label(r.reviewVerdict)}</Badge> : <span className="muted">—</span>, sortValue: (r) => r.reviewVerdict },
  ];

  const lh = d.learningHealth;
  return (
    <div className="stack">
      <div className={`banner ${lh.frozen ? "bad" : lh.status === "healthy" ? "ok" : "warn"}`}>
        <HealthPill status={lh.status} />
        <span className="grow">
          {lh.frozen ? <><strong>Adaptation frozen.</strong> {lh.reason ?? "Learning infrastructure is unavailable; trading continues on the last validated strategy versions and nothing new is deployed."}</> : <>Learning engine {lh.status}{lh.reason ? ` — ${lh.reason}` : ""}.</>}
        </span>
        <span className="tiny muted">last run {lh.lastRunAt ? fmt.ago(lh.lastRunAt) : "never"}</span>
      </div>

      <div className="grid cols-2">
        <Digest title="What the system learned today" d={d.today} />
        <Digest title="What the system learned this week" d={d.week} />
      </div>

      <div className="grid cols-2">
        <Panel title="Strategies improving"><StrategyTrend items={d.strategiesImproving} tone="pos" /></Panel>
        <Panel title="Strategies deteriorating"><StrategyTrend items={d.strategiesDeteriorating} tone="neg" /></Panel>
        <Panel title="Signals improving"><SignalTrend items={d.signalsImproving} tone="pos" /></Panel>
        <Panel title="Signals deteriorating"><SignalTrend items={d.signalsDeteriorating} tone="neg" /></Panel>
      </div>

      <Panel title="Confidence calibration" actions={d.calibration.length > 1 && <select value={cal?.key ?? ""} onChange={(e) => setCalKey(e.target.value)}>{d.calibration.map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}</select>}>
        <p className="small dim">When the system said it was 70% confident, how often was it right? Bars above the predicted level mean underconfidence; below, overconfidence.</p>
        <CalibrationChart profile={cal} />
      </Panel>

      <div className="grid cols-2">
        <Panel title="Model performance" flush>
          <DataTable rows={d.models} columns={modelCols} rowKey={(m) => `${m.modelName}@${m.modelVersion}`} compact empty={<EmptyState title="AI models: not configured" detail="No model profiles exist. Configure models under Admin → Models & Agents." />} />
        </Panel>
        <Panel title="Agent performance" flush>
          <DataTable rows={d.agents} columns={agentCols} rowKey={(a) => a.agentName} compact empty={<EmptyState title="No agent data" detail="Agent profiles appear once the slow-brain committee has influenced decisions." />} />
        </Panel>
      </div>

      <div className="grid cols-2">
        <Panel title="Recent lessons">
          {d.recentLessons.length === 0 ? <EmptyState title="No lessons yet" /> : d.recentLessons.map((l) => (
            <div key={l.id} className="fold" style={{ marginBottom: 6 }}>
              <div><strong>{l.lesson}</strong> <span className="tag">{l.strategyKey}</span><span className="tag">{fmt.label(l.regime)}</span></div>
              <div className="small dim">{l.setup} — expected {l.expected}; actual {l.actual}.</div>
              <div className="small">→ {l.action}</div>
              <div className="tiny muted">{fmt.dateTime(l.createdAt)} · confirmed {l.timesConfirmed} · contradicted {l.timesContradicted}</div>
            </div>
          ))}
        </Panel>
        <Panel title="Repeated mistakes">
          {d.repeatedMistakes.length === 0 ? <EmptyState title="No repeated mistakes detected" /> : (
            <ul className="list">{d.repeatedMistakes.map((m, i) => <li key={i}><Badge tone="warn">{m.occurrences}×</Badge><span className="grow"><strong>{m.pattern}</strong>{m.strategyKey && <span className="tag">{m.strategyKey}</span>}<div className="small dim">Suggested: {m.suggestedAction}</div></span><span className="when">{fmt.ago(m.lastSeenAt)}</span></li>)}</ul>
          )}
        </Panel>
      </div>

      <Panel title="Missed opportunities" flush>
        <DataTable rows={d.missedOpportunities} columns={missedCols} rowKey={(r) => r.id} defaultSort={{ key: "at", dir: "desc" }} compact empty={<EmptyState title="No missed opportunities recorded" detail="Rejected candidates are reviewed after the fact to see whether the rejection was right." />} />
      </Panel>

      <div className="grid cols-2">
        <Panel title="Regime insights">
          {d.regimeInsights.length === 0 ? <EmptyState title="No regime insights" /> : d.regimeInsights.map((r, i) => <div key={i} className="fold" style={{ marginBottom: 6 }}><Badge tone="outline">{fmt.label(r.regime)}</Badge> {r.insight}{r.evidence.length > 0 && <ul className="bullets tight tiny muted">{r.evidence.map((e, j) => <li key={j}>{e}</li>)}</ul>}</div>)}
        </Panel>
        <Panel title="Execution insights">
          {d.executionInsights.length === 0 ? <EmptyState title="No execution insights" /> : <ul className="list">{d.executionInsights.map((e, i) => <li key={i}><Badge tone="outline">{fmt.label(e.bucket)}</Badge><span className="grow">{e.insight}</span><span className="when">{fmt.bps(e.avgSlippageBps)} · fill {fmt.score(e.fillRate)}</span></li>)}</ul>}
        </Panel>
      </div>

      <Panel title="Adaptation proposals" flush foot="Proposals within bounds may be applied automatically; anything else must pass the validation pipeline (backtest → out-of-sample → walk-forward → shadow).">
        {d.adaptationProposals.length === 0 ? <EmptyState title="No proposals" /> : (
          <table className="data compact">
            <thead><tr><th>Target</th><th>Key</th><th className="num">Current</th><th className="num">Proposed</th><th>Bounds</th><th>Evidence</th><th>Status</th></tr></thead>
            <tbody>{d.adaptationProposals.map((p) => <tr key={p.id}><td>{fmt.label(p.target)}</td><td className="mono small">{p.key}</td><td className="num">{fmt.num(p.currentValue, 3)}</td><td className="num">{fmt.num(p.proposedValue, 3)}</td><td className="tiny muted">[{fmt.num(p.bounds.min, 2)}, {fmt.num(p.bounds.max, 2)}] · max {fmt.num(p.bounds.maxStepPerDay, 3)}/day</td><td className="wrap small">{p.evidence}</td><td>{p.appliedAt ? <Badge tone="pos">Applied {fmt.ago(p.appliedAt)}</Badge> : p.autoApplicable ? <Badge tone="accent">Auto-applicable</Badge> : <Badge tone="warn">Needs validation</Badge>}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
