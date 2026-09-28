import { Link } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { Opportunity, OverviewResponse } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { Badge, CandidateStatusBadge, StageBadge } from "../components/Badge";
import { ShareBar } from "../components/charts/Bars";
import { Column, DataTable } from "../components/DataTable";
import { KpiTile } from "../components/KpiTile";
import { Meter } from "../components/Meter";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { StatusPill, brokerText, brokerTone, freshnessTone } from "../components/StatusPill";
import { PageHeader } from "../components/Controls";
import { fmt } from "../lib/fmt";

export function OverviewPage() {
  const scoped = useScoped();
  const { account, base } = useAccount();
  const q = useApi<OverviewResponse>(scoped("overview"), { refetchInterval: 30_000 });

  return (
    <>
      <PageHeader title="Overview" sub={<>{account.label} · {account.kind === "simulated" ? "simulated account" : "Robinhood agentic account"} · refreshed {q.dataUpdatedAt ? fmt.ago(new Date(q.dataUpdatedAt).toISOString()) : "—"}</>} />
      <QueryState query={q}>
        {(d) => <OverviewBody d={d} base={base} />}
      </QueryState>
    </>
  );
}

function OverviewBody({ d, base }: { d: OverviewResponse; base: string }) {
  const p = d.portfolio;
  const util = Object.entries(d.risk.utilization ?? {});
  const drawdownLimit = d.risk.utilization?.drawdown?.limit ?? d.risk.utilization?.maxDrawdownPct?.limit ?? null;

  const oppCols: Column<Opportunity>[] = [
    { key: "symbol", header: "Symbol", render: (o) => <strong>{o.symbol}</strong>, sortValue: (o) => o.symbol },
    { key: "strategy", header: "Strategy", render: (o) => o.strategyName, sortValue: (o) => o.strategyName },
    { key: "edge", header: "Edge", align: "right", render: (o) => fmt.signed(o.expectedEdge), sortValue: (o) => o.expectedEdge },
    { key: "conf", header: "Calib. conf", align: "right", render: (o) => fmt.score(o.calibratedConfidence), sortValue: (o) => o.calibratedConfidence },
    { key: "fit", header: "Portfolio fit", align: "right", render: (o) => fmt.signed(o.portfolioFit), sortValue: (o) => o.portfolioFit },
    { key: "status", header: "Status", render: (o) => <CandidateStatusBadge status={o.finalStatus} /> },
  ];

  return (
    <div className="stack">
      {(d.broker.status !== "connected" && d.account.kind !== "simulated") && (
        <div className="banner warn"><span className="grow">{brokerText(d.broker.status)}{d.broker.detail ? ` — ${d.broker.detail}` : ""}. No new trades can be placed until the connection is healthy.</span><Link to={`${base}/settings`} className="btn sm">Settings</Link></div>
      )}
      {d.account.killSwitchActive && <div className="banner bad"><span className="grow">Kill switch is active for this account. Only risk-reducing exits are allowed.</span><Link to={`${base}/risk`} className="btn sm">Risk</Link></div>}
      {d.account.tradingPaused && !d.account.killSwitchActive && <div className="banner warn"><span className="grow">Trading is paused{d.account.pausedReason ? `: ${d.account.pausedReason}` : ""}.</span><Link to={`${base}/settings`} className="btn sm">Settings</Link></div>}

      <div className="grid kpis">
        <KpiTile label="Portfolio value" value={p ? fmt.money(p.totalValue) : null} sub={p ? `as of ${fmt.dateTime(p.asOf)}` : "Broker data not available"} />
        <KpiTile label="Daily P&L" value={fmt.money(d.pnl.daily, { signed: true })} tone={fmt.signClass(d.pnl.daily)} sub={d.pnl.dailyPct !== null ? fmt.pct(d.pnl.dailyPct, { signed: true }) : undefined} />
        <KpiTile label="Total P&L" value={fmt.money(d.pnl.total, { signed: true })} tone={fmt.signClass(d.pnl.total)} sub={d.pnl.totalPct !== null ? fmt.pct(d.pnl.totalPct, { signed: true }) : undefined} />
        <KpiTile label="Cash" value={p ? fmt.money(p.cash) : null} />
        <KpiTile label="Buying power" value={p ? fmt.money(p.buyingPower) : null} />
        <KpiTile label="Positions" value={fmt.int(d.positionsCount)} sub={<Link to={`${base}/positions`}>View positions</Link>} />
        <KpiTile label="Gross exposure" value={fmt.pct(d.exposure.grossPct, { digits: 1 })} sub={d.exposure.beta !== null ? `beta ${fmt.num(d.exposure.beta, 2)}` : "beta unknown"} />
        <KpiTile label="Drawdown" value={fmt.pct(d.drawdownPct, { digits: 2 })} tone={d.drawdownPct && drawdownLimit && d.drawdownPct >= drawdownLimit * 0.8 ? "warn" : undefined} sub={drawdownLimit !== null ? `limit ${fmt.pct(drawdownLimit, { digits: 1 })}` : undefined} />
      </div>

      <div className="grid cols-3">
        <Panel title="Market regime" actions={d.regime && <StatusPill tone={freshnessTone(d.regime.dataQuality)} dot>{fmt.label(d.regime.dataQuality)}</StatusPill>}>
          {d.regime ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row between">
                <div><div className="kpi-label">Primary</div><div style={{ fontSize: 18, fontWeight: 600 }}>{fmt.label(d.regime.primary)}</div></div>
                <div className="right"><div className="kpi-label">Confidence</div><div className="num" style={{ fontSize: 18, fontWeight: 600 }}>{fmt.score(d.regime.confidence)}</div></div>
                <div className="right"><div className="kpi-label">Abnormality</div><div className="num" style={{ fontSize: 18, fontWeight: 600 }}>{fmt.score(d.regime.abnormality)}</div></div>
              </div>
              <ShareBar parts={Object.entries(d.regime.probabilities).map(([label, value]) => ({ label, value: value ?? 0 }))} />
              {d.regime.explanation.length > 0 && <ul className="bullets tight small dim">{d.regime.explanation.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}</ul>}
              <div className="tiny muted">as of {fmt.dateTime(d.regime.asOf)}</div>
            </div>
          ) : <EmptyState title="Regime not assessed" detail="The regime engine has not produced an assessment yet." />}
        </Panel>

        <Panel title="Risk utilization" actions={<Link to={`${base}/risk`} className="small">Details</Link>}>
          {util.length === 0 ? <EmptyState title="No utilization data" /> : (
            <div>
              {util.map(([k, v]) => <Meter key={k} label={fmt.label(k)} used={v.used} limit={v.limit} format={inferFormat(k)} />)}
              <div className="tiny muted" style={{ marginTop: 6 }}>Remaining risk capacity: {d.risk.capacity === null ? "unknown" : fmt.score(d.risk.capacity)}</div>
            </div>
          )}
        </Panel>

        <Panel title="Connection & data quality">
          <dl className="kv wide">
            <dt>Broker</dt><dd><StatusPill tone={d.account.kind === "simulated" ? "neutral" : brokerTone(d.broker.status)}>{brokerText(d.broker.status, d.account.kind)}</StatusPill>{d.broker.detail && <div className="tiny muted">{d.broker.detail}</div>}</dd>
            <dt>Last reconciled</dt><dd>{d.account.lastReconciledAt ? <>{fmt.ago(d.account.lastReconciledAt)} {d.account.reconciliationOk === false && <Badge tone="neg">mismatch</Badge>}</> : <span className="muted">never</span>}</dd>
            <dt>Quotes</dt><dd><StatusPill tone={freshnessTone(d.dataQuality.quotes)}>{fmt.label(d.dataQuality.quotes)}</StatusPill></dd>
            <dt>Bars</dt><dd><StatusPill tone={freshnessTone(d.dataQuality.bars)}>{fmt.label(d.dataQuality.bars)}</StatusPill></dd>
            <dt>Regime</dt><dd><StatusPill tone={freshnessTone(d.dataQuality.regime)}>{fmt.label(d.dataQuality.regime)}</StatusPill></dd>
          </dl>
          {(d.dataQuality.quotes !== "fresh" || d.dataQuality.bars !== "fresh") && <div className="tiny warn-text" style={{ marginTop: 8 }}>Data quality gate: no new entries while quotes or bars are not fresh.</div>}
        </Panel>
      </div>

      <div className="grid cols-2">
        <Panel title="Highest-conviction opportunities" actions={<Link to={`${base}/opportunities`} className="small">All opportunities</Link>} flush>
          <DataTable rows={d.topOpportunities} columns={oppCols} rowKey={(o) => o.candidateId} compact empty={<EmptyState title="No opportunities" detail="No trade candidates meet this account's thresholds right now." />} />
        </Panel>
        <Panel title="Active strategies" actions={<Link to={`${base}/strategies`} className="small">Manage</Link>} flush>
          {d.activeStrategies.length === 0 ? <EmptyState title="No strategies enabled" detail="Enable strategies for this account under Strategies." /> : (
            <table className="data compact">
              <thead><tr><th>Strategy</th><th>Stage</th><th className="num">Allocation</th></tr></thead>
              <tbody>{d.activeStrategies.map((s) => <tr key={s.id}><td>{s.name} <span className="muted mono tiny">{s.key}</span></td><td><StageBadge stage={s.stage} /></td><td className="num">{fmt.score(s.allocation, 0)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid cols-3">
        <Panel title="Risk alerts">
          {d.alerts.length === 0 ? <EmptyState title="No alerts" /> : (
            <ul className="list">{d.alerts.map((a) => <li key={a.id}><StatusPill tone={a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : "info"} dot>{a.severity}</StatusPill><span className="grow">{a.message}</span><span className="when">{fmt.ago(a.at)}</span></li>)}</ul>
          )}
        </Panel>
        <Panel title="Upcoming catalysts">
          {d.upcomingCatalysts.length === 0 ? <EmptyState title="No catalysts scheduled" /> : (
            <ul className="list">{d.upcomingCatalysts.map((c, i) => <li key={i}><strong>{c.symbol}</strong><span className="grow"><Badge tone="outline">{fmt.label(c.kind)}</Badge> {c.description}</span><span className="when">{fmt.date(c.at)}</span></li>)}</ul>
          )}
        </Panel>
        <Panel title="Execution issues">
          {d.executionIssues.length === 0 ? <EmptyState title="No execution issues" /> : (
            <ul className="list">{d.executionIssues.map((e) => <li key={e.orderId}><strong>{e.symbol}</strong><span className="grow">{e.issue} <span className="mono tiny muted">{e.orderId}</span></span><span className="when">{fmt.ago(e.at)}</span></li>)}</ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function inferFormat(key: string): "pct" | "money" | "num" | "score" {
  const k = key.toLowerCase();
  if (k.includes("pct") || k.includes("exposure") || k.includes("drawdown") || k.includes("loss") || k.includes("deployed") || k.includes("sector") || k.includes("position") && !k.includes("positions")) return "pct";
  if (k.includes("notional") || k.includes("usd") || k.includes("capital")) return "money";
  if (k.includes("beta")) return "score";
  return "num";
}
