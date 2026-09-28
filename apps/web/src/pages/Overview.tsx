import { Link } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { AnalyticsResponse, Opportunity, OverviewResponse, TimePoint } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { Badge, CandidateStatusBadge, StageBadge } from "../components/Badge";
import { ShareBar } from "../components/charts/Bars";
import { Column, DataTable } from "../components/DataTable";
import { Gauge } from "../components/Gauge";
import { InlineBar } from "../components/InlineBar";
import { KpiTile } from "../components/KpiTile";
import { Meter } from "../components/Meter";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { StatusPill, brokerText, brokerTone, freshnessTone } from "../components/StatusPill";
import { Timeline } from "../components/Timeline";
import { PageHeader } from "../components/Controls";
import { fmt } from "../lib/fmt";
import { inferFormat } from "../lib/riskFormat";


export function OverviewPage() {
  const scoped = useScoped();
  const { account, base } = useAccount();
  const q = useApi<OverviewResponse>(scoped("overview"), { refetchInterval: 30_000 });
  // Sparkline history: the last 30 points of the one-month analytics curves. Absent → labelled "no history yet".
  const hist = useApi<AnalyticsResponse>(scoped("analytics?period=1m"), { staleTime: 60_000 });

  return (
    <>
      <PageHeader title="Overview" sub={<>{account.label} · {account.kind === "simulated" ? "simulated account" : "Robinhood agentic account"} · refreshed {q.dataUpdatedAt ? fmt.ago(new Date(q.dataUpdatedAt).toISOString()) : "—"}</>} />
      <QueryState query={q} loadingLabel="Loading overview" skeleton="kpis">
        {(d) => <OverviewBody d={d} base={base} history={hist.data ?? null} />}
      </QueryState>
    </>
  );
}

function last30(points: TimePoint[] | null | undefined): number[] {
  return (points ?? []).map((p) => p.value).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(-30);
}

function OverviewBody({ d, base, history }: { d: OverviewResponse; base: string; history: AnalyticsResponse | null }) {
  const p = d.portfolio;
  const util = Object.entries(d.risk.utilization ?? {});
  const drawdownLimit = d.risk.utilization?.drawdown?.limit ?? d.risk.utilization?.maxDrawdownPct?.limit ?? null;
  const sectorLimit = util.find(([k]) => /sector/i.test(k))?.[1]?.limit ?? null;
  const equity = last30(history?.equityCurve);
  const exposureHist = last30(history?.exposureHistory);
  const ddHist = last30(history?.drawdownCurve).map((v) => -Math.abs(v));
  const maxEdge = Math.max(1e-9, ...d.topOpportunities.map((o) => Math.abs(o.expectedEdge)));

  const oppCols: Column<Opportunity>[] = [
    { key: "symbol", header: "Symbol", render: (o) => <span className="sym">{o.symbol}</span>, sortValue: (o) => o.symbol },
    { key: "strategy", header: "Strategy", render: (o) => <span title={o.strategyKey}>{o.strategyName}</span>, sortValue: (o) => o.strategyName },
    { key: "edge", header: "Expected edge", align: "right", render: (o) => <InlineBar value={o.expectedEdge} max={maxEdge} signed text={fmt.signed(o.expectedEdge)} />, sortValue: (o) => o.expectedEdge, title: "Net expected edge from the signal ensemble" },
    { key: "conf", header: "Calibrated conf.", align: "right", render: (o) => <InlineBar value={o.calibratedConfidence} text={fmt.score(o.calibratedConfidence)} />, sortValue: (o) => o.calibratedConfidence },
    { key: "fit", header: "Portfolio fit", align: "right", render: (o) => <InlineBar value={o.portfolioFit} signed text={fmt.signed(o.portfolioFit)} />, sortValue: (o) => o.portfolioFit, title: "Fit for THIS account" },
    { key: "hold", header: "Hold", align: "right", render: (o) => fmt.days(o.holdingPeriodDays), sortValue: (o) => o.holdingPeriodDays },
    { key: "status", header: "Status", render: (o) => <CandidateStatusBadge status={o.finalStatus} /> },
  ];

  const sectors = Object.entries(d.exposure.bySector ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  const sectorMax = Math.max(1e-9, sectorLimit ?? 0, ...sectors.map(([, v]) => v));

  return (
    <div className="stack">
      {(d.broker.status !== "connected" && d.account.kind !== "simulated") && (
        <div className="banner warn"><span className="grow">{brokerText(d.broker.status)}{d.broker.detail ? ` — ${d.broker.detail}` : ""}. No new trades can be placed until the connection is healthy.</span><Link to={`${base}/settings`} className="btn sm">Settings</Link></div>
      )}
      {d.account.killSwitchActive && <div className="banner bad"><span className="grow">Kill switch is active for this account. Only risk-reducing exits are allowed.</span><Link to={`${base}/risk`} className="btn sm">Risk</Link></div>}
      {d.account.tradingPaused && !d.account.killSwitchActive && <div className="banner warn"><span className="grow">Trading is paused{d.account.pausedReason ? `: ${d.account.pausedReason}` : ""}.</span><Link to={`${base}/settings`} className="btn sm">Settings</Link></div>}

      <div className="grid kpis">
        <KpiTile hero label="Portfolio value" value={p ? fmt.money(p.totalValue) : null} sub={p ? `as of ${fmt.ago(p.asOf)}` : "Broker data not available"} history={equity} historyLabel="Equity, last 30 points" />
        <KpiTile label="Daily P&L" value={fmt.money(d.pnl.daily, { signed: true })} tone={fmt.signClass(d.pnl.daily)} delta={d.pnl.dailyPct !== null ? { text: fmt.pct(d.pnl.dailyPct, { signed: true }), tone: fmt.signClass(d.pnl.dailyPct), title: "vs previous close" } : null} sub={d.pnl.daily === null ? "no P&L reported" : undefined} />
        <KpiTile label="Total P&L" value={fmt.money(d.pnl.total, { signed: true })} tone={fmt.signClass(d.pnl.total)} delta={d.pnl.totalPct !== null ? { text: fmt.pct(d.pnl.totalPct, { signed: true }), tone: fmt.signClass(d.pnl.totalPct), title: "vs cost basis" } : null} sub={d.pnl.total === null ? "no P&L reported" : undefined} />
        <KpiTile label="Cash" value={p ? fmt.money(p.cash) : null} />
        <KpiTile label="Buying power" value={p ? fmt.money(p.buyingPower) : null} />
        <KpiTile label="Positions" value={fmt.int(d.positionsCount)} sub={<Link to={`${base}/positions`}>View positions</Link>} />
        <KpiTile label="Gross exposure" value={fmt.pct(d.exposure.grossPct, { digits: 1 })} sub={d.exposure.beta !== null ? `beta ${fmt.num(d.exposure.beta, 2)}` : "beta unknown"} history={exposureHist} historyLabel="Gross exposure, last 30 points" />
        <KpiTile label="Drawdown" value={fmt.pct(d.drawdownPct, { digits: 2 })} tone={d.drawdownPct && drawdownLimit && d.drawdownPct >= drawdownLimit * 0.8 ? "warn" : undefined} delta={drawdownLimit !== null ? { text: `limit ${fmt.pct(drawdownLimit, { digits: 1 })}`, tone: d.drawdownPct && d.drawdownPct >= drawdownLimit * 0.8 ? "warn" : "flat" } : null} history={ddHist} historyLabel="Drawdown, last 30 points" />
      </div>

      <div className="grid g12">
        <Panel className="c4" title="Market regime" actions={d.regime && <StatusPill tone={freshnessTone(d.regime.dataQuality)} dot>{fmt.label(d.regime.dataQuality)}</StatusPill>}>
          {d.regime ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row between" style={{ alignItems: "flex-end" }}>
                <div><div className="kpi-label">Primary</div><div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>{fmt.label(d.regime.primary)}</div></div>
                <div className="right"><div className="kpi-label">Confidence</div><div className="num" style={{ fontSize: 18, fontWeight: 600 }}>{fmt.score(d.regime.confidence)}</div></div>
                <div className="right"><div className="kpi-label">Abnormality</div><Gauge value={d.regime.abnormality} label="Abnormality" /></div>
              </div>
              <ShareBar parts={Object.entries(d.regime.probabilities).map(([label, value]) => ({ label, value: value ?? 0 }))} />
              {d.regime.explanation.length > 0 && <ul className="bullets tight small dim">{d.regime.explanation.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}</ul>}
              <div className="tiny muted">as of {fmt.dateTime(d.regime.asOf)}</div>
            </div>
          ) : <EmptyState title="Regime not assessed" detail="The regime engine has not produced an assessment yet." />}
        </Panel>

        <Panel className="c4" title="Exposure by sector" actions={sectorLimit !== null && <span className="tiny muted">limit {fmt.pct(sectorLimit, { digits: 0 })}</span>}>
          {sectors.length === 0 ? <EmptyState title="No sector exposure" detail={d.positionsCount === 0 ? "No open positions, so nothing is allocated." : "Sector classification is not available for the current holdings."} /> : (
            <div className="sectors">
              {sectors.map(([name, v]) => {
                const over = sectorLimit !== null && v > sectorLimit;
                return (
                  <div className="sector-row" key={name} title={`${fmt.label(name)} ${fmt.pct(v, { digits: 1 })}${sectorLimit !== null ? ` of ${fmt.pct(sectorLimit, { digits: 0 })} limit` : ""}`}>
                    <span className="name">{fmt.label(name)}</span>
                    <span className="track">
                      <span className={`fill ${over ? "over" : ""}`} style={{ width: `${(v / sectorMax) * 100}%` }} />
                      {sectorLimit !== null && <span className="lim" style={{ left: `${(sectorLimit / sectorMax) * 100}%` }} aria-hidden />}
                    </span>
                    <span className={`v ${over ? "warn-text" : ""}`}>{fmt.pct(v, { digits: 1 })}</span>
                  </div>
                );
              })}
              <div className="tiny muted">Gross {fmt.pct(d.exposure.grossPct, { digits: 1 })}{d.exposure.beta !== null ? ` · beta ${fmt.num(d.exposure.beta, 2)}` : ""}</div>
            </div>
          )}
        </Panel>

        <Panel className="c4" title="Connection & data quality">
          <dl className="kv wide">
            <dt>Broker</dt><dd><StatusPill tone={d.account.kind === "simulated" ? "neutral" : brokerTone(d.broker.status)}>{brokerText(d.broker.status, d.account.kind)}</StatusPill>{d.broker.detail && <div className="tiny muted">{d.broker.detail}</div>}</dd>
            <dt>Last reconciled</dt><dd>{d.account.lastReconciledAt ? <>{fmt.ago(d.account.lastReconciledAt)} {d.account.reconciliationOk === false && <Badge tone="neg">mismatch</Badge>}</> : <span className="muted">never</span>}</dd>
            <dt>Quotes</dt><dd><StatusPill tone={freshnessTone(d.dataQuality.quotes)}>{fmt.label(d.dataQuality.quotes)}</StatusPill></dd>
            <dt>Bars</dt><dd><StatusPill tone={freshnessTone(d.dataQuality.bars)}>{fmt.label(d.dataQuality.bars)}</StatusPill></dd>
            <dt>Regime</dt><dd><StatusPill tone={freshnessTone(d.dataQuality.regime)}>{fmt.label(d.dataQuality.regime)}</StatusPill></dd>
          </dl>
          {(d.dataQuality.quotes !== "fresh" || d.dataQuality.bars !== "fresh") && <div className="tiny warn-text" style={{ marginTop: 8 }}>Data quality gate: no new entries while quotes or bars are not fresh.</div>}
        </Panel>

        <Panel className="c8" title="Highest conviction" actions={<Link to={`${base}/opportunities`} className="small">All opportunities</Link>} flush>
          <DataTable rows={d.topOpportunities} columns={oppCols} rowKey={(o) => o.candidateId} compact defaultSort={{ key: "edge", dir: "desc" }} empty={<EmptyState title="No opportunities" detail="No trade candidate meets this account's thresholds right now." />} />
        </Panel>

        <Panel className="c4" title="Risk utilization" actions={<Link to={`${base}/risk`} className="small">Details</Link>}>
          {util.length === 0 ? <EmptyState title="No utilization data" detail="The risk engine has not reported limits for this account." /> : (
            <div>
              {util.map(([k, v]) => <Meter key={k} label={fmt.label(k)} used={v.used} limit={v.limit} format={inferFormat(k)} />)}
              <div className="tiny muted" style={{ marginTop: 6 }}>Remaining risk capacity: {d.risk.capacity === null ? "unknown" : fmt.score(d.risk.capacity)}</div>
            </div>
          )}
        </Panel>

        <Panel className="c3" title="Upcoming catalysts">
          {d.upcomingCatalysts.length === 0 ? <EmptyState title="No catalysts scheduled" detail="No earnings, events or dates are attached to current holdings or candidates." /> : (
            <Timeline items={[...d.upcomingCatalysts].sort((a, b) => a.at.localeCompare(b.at)).map((c) => ({ at: c.at, tone: "info", title: <><span className="sym">{c.symbol}</span> <Badge tone="outline">{fmt.label(c.kind)}</Badge></>, note: c.description }))} />
          )}
        </Panel>
        <Panel className="c3" title="Execution issues">
          {d.executionIssues.length === 0 ? <EmptyState title="No execution issues" detail="Every recent order filled or cancelled as expected." /> : (
            <ul className="list">{d.executionIssues.map((e) => <li key={e.orderId}><span className="sym">{e.symbol}</span><span className="grow">{e.issue} <span className="mono tiny muted">{e.orderId}</span></span><span className="when">{fmt.ago(e.at)}</span></li>)}</ul>
          )}
        </Panel>
        <Panel className="c3" title="Risk alerts">
          {d.alerts.length === 0 ? <EmptyState title="No alerts" detail="The risk engine has not raised anything for this account." /> : (
            <ul className="list">{d.alerts.map((a) => <li key={a.id}><StatusPill tone={a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : "info"} dot>{a.severity}</StatusPill><span className="grow">{a.message}</span><span className="when">{fmt.ago(a.at)}</span></li>)}</ul>
          )}
        </Panel>
        <Panel className="c3" title="Active strategies" actions={<Link to={`${base}/strategies`} className="small">Manage</Link>} flush>
          {d.activeStrategies.length === 0 ? <EmptyState title="No strategies enabled" detail="Enable strategies for this account under Strategies." /> : (
            <table className="data compact">
              <thead><tr><th>Strategy</th><th>Stage</th><th className="num">Alloc.</th></tr></thead>
              <tbody>{d.activeStrategies.map((s) => <tr key={s.id}><td><Link to={`${base}/strategies/${s.id}`}>{s.name}</Link></td><td><StageBadge stage={s.stage} /></td><td className="num"><InlineBar value={s.allocation} text={fmt.score(s.allocation, 0)} /></td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
