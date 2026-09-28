import { useState } from "react";
import { qs } from "../api/client";
import { useApi } from "../api/hooks";
import type { JournalEntry, JournalResponse, TradeDetailResponse } from "../api/types";
import { useScoped } from "../app/AccountContext";
import { Badge, CLASSIFICATION_HELP, ClassificationBadge, TradeStateBadge } from "../components/Badge";
import { Column, DataTable } from "../components/DataTable";
import { Explanation } from "../components/Explanation";
import { PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, Loading, QueryState } from "../components/States";
import { Timeline } from "../components/Timeline";
import { fmt } from "../lib/fmt";

export function JournalPage() {
  const scoped = useScoped();
  const [limit, setLimit] = useState(100);
  const q = useApi<JournalResponse>(scoped(`journal${qs({ limit })}`));

  const cols: Column<JournalEntry>[] = [
    { key: "closed", header: "Closed", render: (e) => fmt.dateTime(e.closedAt), sortValue: (e) => e.closedAt },
    { key: "symbol", header: "Symbol", render: (e) => <span className="sym">{e.symbol}</span>, sortValue: (e) => e.symbol },
    { key: "strategy", header: "Strategy", render: (e) => <span className="mono small">{e.strategyKey}</span>, sortValue: (e) => e.strategyKey },
    { key: "opened", header: "Opened", render: (e) => fmt.date(e.openedAt), sortValue: (e) => e.openedAt },
    { key: "ret", header: "Return", align: "right", render: (e) => <span className={fmt.signClass(e.returnPct)}>{fmt.pct(e.returnPct, { signed: true })}</span>, sortValue: (e) => e.returnPct },
    { key: "class", header: "Classification", render: (e) => <ClassificationBadge c={e.classification} />, sortValue: (e) => e.classification },
    { key: "thesis", header: "Thesis", render: (e) => <span className="truncate" style={{ maxWidth: 360, display: "inline-block" }} title={e.thesisSummary}>{e.thesisSummary}</span> },
  ];

  return (
    <>
      <PageHeader title="Trade journal" sub="Every closed trade with its post-trade review: was the thesis right, the timing right, the size right, the execution efficient?" actions={<label className="row small">Show <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[50, 100, 250, 500].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>} />
      <Panel flush>
        <QueryState query={q} loadingLabel="Loading journal" skeleton="table" isEmpty={(d) => d.entries.length === 0} empty={<EmptyState title="No journal entries yet" detail="Entries appear when trades close and are reviewed." />}>
          {(d) => <DataTable rows={d.entries} columns={cols} rowKey={(e) => e.tradeId} defaultSort={{ key: "closed", dir: "desc" }} renderExpanded={(e) => <JournalDetail entry={e} path={scoped(`trades/${encodeURIComponent(e.tradeId)}`)} />} />}
        </QueryState>
      </Panel>
    </>
  );
}

function JournalDetail({ entry, path }: { entry: JournalEntry; path: string }) {
  const q = useApi<TradeDetailResponse>(path);
  if (q.isPending) return <Loading label="Loading trade" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const rv = d.review;
  const yn = (v: boolean | null) => (v === null ? <span className="muted">unknown</span> : v ? <Badge tone="pos">yes</Badge> : <Badge tone="neg">no</Badge>);
  return (
    <div className="stack">
      <div className="row"><TradeStateBadge state={d.trade.state} /><Badge tone={d.trade.mode === "live" ? "accent" : "outline"}>{d.trade.mode}</Badge><span className="small dim">entry {fmt.price(d.trade.averageEntryPrice)} → exit {fmt.price(d.trade.averageExitPrice)} · realized <span className={fmt.signClass(d.trade.realizedPnl)}>{fmt.money(d.trade.realizedPnl, { signed: true })}</span> · fees {fmt.money(d.trade.fees)} · exit reason {d.trade.exitReason ?? "—"}</span></div>
      <Explanation title="What happened and why" text={d.explanation} defaultOpen evidence={d.riskDecisions.flatMap((r) => r.checks.filter((c) => !c.passed || c.severity !== "info").map((c) => ({ label: `${fmt.label(c.code)}: ${c.detail}`, polarity: c.passed ? ("neutral" as const) : ("against" as const), source: `risk engine ${r.riskEngineVersion}`, observedAt: r.decidedAt })))} />
      <div className="grid cols-3">
        <div>
          <h3>Review</h3>
          {rv ? (
            <dl className="kv">
              <dt>Classification</dt><dd><ClassificationBadge c={rv.classification} /> <span className="tiny muted">{CLASSIFICATION_HELP[rv.classification]}</span></dd>
              <dt>Thesis correct</dt><dd>{yn(rv.thesisCorrect)}</dd>
              <dt>Timing correct</dt><dd>{yn(rv.timingCorrect)}</dd>
              <dt>Sizing correct</dt><dd>{yn(rv.sizingCorrect)}</dd>
              <dt>Execution efficient</dt><dd>{yn(rv.executionEfficient)} {rv.slippageBps !== null && <span className="tiny muted">{fmt.bps(rv.slippageBps)}</span>}</dd>
              <dt>Behaved as intended</dt><dd>{yn(rv.strategyBehavedAsIntended)}</dd>
              <dt>Confidence calibrated</dt><dd>{yn(rv.confidenceCalibrated)} <span className="tiny muted">initial {fmt.score(rv.initialConfidence)}</span></dd>
              <dt>Would take again</dt><dd>{yn(rv.wouldTakeAgain)}</dd>
              <dt>MAE / MFE</dt><dd>{fmt.pct(rv.maePct, { digits: 1 })} / {fmt.pct(rv.mfePct, { digits: 1 })}</dd>
              <dt>Regime</dt><dd>{fmt.label(rv.regimeAtEntry)} → {fmt.label(rv.regimeAtExit)}</dd>
              <dt>Signals helped</dt><dd>{rv.signalsHelped.length ? rv.signalsHelped.map((s) => <span className="tag" key={s}>{s}</span>) : "—"}</dd>
              <dt>Signals hurt</dt><dd>{rv.signalsHurt.length ? rv.signalsHurt.map((s) => <span className="tag" key={s}>{s}</span>) : "—"}</dd>
            </dl>
          ) : <div className="muted small">Not reviewed yet.</div>}
          {rv?.narrative && <div className="pre small dim" style={{ marginTop: 8 }}>{rv.narrative}</div>}
        </div>
        <div>
          <h3>Lesson</h3>
          {d.lessons.length === 0 ? <div className="muted small">{entry.lesson ?? "No lesson recorded."}</div> : d.lessons.map((l) => (
            <div key={l.id} className="fold" style={{ marginBottom: 6 }}>
              <div><strong>{l.lesson}</strong></div>
              <div className="small dim">Setup: {l.setup}</div>
              <div className="small dim">Expected: {l.expected} · Actual: {l.actual}</div>
              <div className="small">Action: {l.action}</div>
              <div className="tiny muted">confirmed {l.timesConfirmed} · contradicted {l.timesContradicted} · confidence impact {fmt.signed(l.confidenceImpact)}</div>
            </div>
          ))}
        </div>
        <div>
          <h3>Decision timeline</h3>
          <Timeline items={[
            ...d.events.map((e) => ({ at: e.at, tone: (e.to === "rejected" || e.to === "canceled" ? "bad" : e.to === "filled" || e.to === "closed" ? "ok" : e.to === "reduce" || e.to === "exit_requested" ? "warn" : "neutral") as "bad" | "ok" | "warn" | "neutral", title: <>{e.from ? <span className="muted">{fmt.label(e.from)} → </span> : null}<TradeStateBadge state={e.to} /></>, note: e.note })),
            ...d.riskDecisions.map((r) => ({ at: r.decidedAt, tone: (r.verdict === "approve" ? "ok" : r.verdict === "reduce" ? "warn" : "bad") as "ok" | "warn" | "bad", title: <>Risk engine <Badge tone={r.verdict === "approve" ? "pos" : r.verdict === "reduce" ? "warn" : "neg"}>{r.verdict}</Badge> <span className="num">{fmt.qty(r.requestedQuantity)} → {fmt.qty(r.approvedQuantity)}</span></>, note: r.reasons.slice(0, 2).join("; ") || `${r.checks.filter((c) => c.passed).length}/${r.checks.length} checks passed` })),
            ...d.fills.map((f) => ({ at: f.at, tone: "info" as const, title: <>Fill <span className="num">{f.side} {fmt.qty(f.quantity)} @ {fmt.price(f.price)}</span>{f.derived && <span className="tiny muted"> (derived)</span>}</>, note: f.fees ? `fees ${fmt.money(f.fees)}` : undefined })),
          ].sort((a, b) => String(a.at).localeCompare(String(b.at)))} emptyText="No events recorded for this trade." />
        </div>
      </div>
    </div>
  );
}
