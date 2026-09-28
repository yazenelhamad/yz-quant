import { useApi } from "../api/hooks";
import type { Opportunity } from "../api/types";
import { useScoped } from "../app/AccountContext";
import { CandidateStatusBadge } from "../components/Badge";
import { ContributionList } from "../components/charts/Bars";
import { Column, DataTable } from "../components/DataTable";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { PageHeader } from "../components/Controls";
import { fmt } from "../lib/fmt";

export function OpportunitiesPage() {
  const scoped = useScoped();
  const q = useApi<{ opportunities: Opportunity[] }>(scoped("opportunities"), { refetchInterval: 30_000 });

  const cols: Column<Opportunity>[] = [
    { key: "symbol", header: "Symbol", render: (o) => <strong>{o.symbol}</strong>, sortValue: (o) => o.symbol },
    { key: "strategy", header: "Strategy", render: (o) => <span title={o.strategyKey}>{o.strategyName}</span>, sortValue: (o) => o.strategyName },
    { key: "edge", header: "Expected edge", align: "right", render: (o) => fmt.signed(o.expectedEdge), sortValue: (o) => o.expectedEdge, title: "Net expected edge from the signal ensemble, −1..1" },
    { key: "conf", header: "Confidence", align: "right", render: (o) => fmt.score(o.confidence), sortValue: (o) => o.confidence },
    { key: "cconf", header: "Calibrated", align: "right", render: (o) => fmt.score(o.calibratedConfidence), sortValue: (o) => o.calibratedConfidence, title: "Confidence after calibration adjustment" },
    { key: "down", header: "Downside", align: "right", render: (o) => fmt.pct(o.potentialDownsidePct, { digits: 1 }), sortValue: (o) => o.potentialDownsidePct },
    { key: "hold", header: "Holding", align: "right", render: (o) => fmt.days(o.holdingPeriodDays), sortValue: (o) => o.holdingPeriodDays },
    { key: "regime", header: "Regime fit", align: "right", render: (o) => fmt.score(o.regimeFit), sortValue: (o) => o.regimeFit },
    { key: "liq", header: "Liquidity", align: "right", render: (o) => fmt.score(o.liquidityScore), sortValue: (o) => o.liquidityScore },
    { key: "cat", header: "Catalyst", render: (o) => o.catalyst ? <span className="truncate" style={{ maxWidth: 180, display: "inline-block" }} title={o.catalyst}>{o.catalyst}</span> : <span className="muted">none</span> },
    { key: "risk", header: "Risk", align: "right", render: (o) => <span title={o.risk.notes.join("\n")}>{fmt.score(o.risk.score)}</span>, sortValue: (o) => o.risk.score },
    { key: "fit", header: "Portfolio fit", align: "right", render: (o) => <span className={o.portfolioFit !== null && o.portfolioFit < 0 ? "warn-text" : ""}>{fmt.signed(o.portfolioFit)}</span>, sortValue: (o) => o.portfolioFit, title: "Fit for THIS account: exposure, sector, correlation, beta, drawdown, capacity" },
    { key: "hist", header: "Hist. similarity", align: "right", render: (o) => o.historicalSimilarity ? <span title={`${o.historicalSimilarity.positive}/${o.historicalSimilarity.analogs} positive`}>{o.historicalSimilarity.analogs} analogs · {fmt.pct(o.historicalSimilarity.avgReturnPct, { digits: 1 })}</span> : <span className="muted">none</span>, sortValue: (o) => o.historicalSimilarity?.avgReturnPct },
    { key: "sp", header: "Strategy perf", align: "right", render: (o) => o.strategyPerformance ? <span title={`${o.strategyPerformance.trades} trades`}>WR {fmt.score(o.strategyPerformance.winRate)} · PF {fmt.num(o.strategyPerformance.profitFactor, 2)}</span> : <span className="muted">n/a</span>, sortValue: (o) => o.strategyPerformance?.expectancyPct },
    { key: "variant", header: "Variant", align: "right", render: (o) => fmt.score(o.variantScore), sortValue: (o) => o.variantScore },
    { key: "status", header: "Final status", render: (o) => <CandidateStatusBadge status={o.finalStatus} />, sortValue: (o) => o.finalStatus },
    { key: "age", header: "Created", render: (o) => <span className="muted">{fmt.ago(o.createdAt)}</span>, sortValue: (o) => o.createdAt },
  ];

  return (
    <>
      <PageHeader title="Opportunities" sub="Trade candidates from the shared intelligence stack, with portfolio fit computed for the selected account. Candidates are not orders: every one still passes the portfolio engine, fast brain and risk engine." />
      <Panel flush>
        <QueryState query={q} isEmpty={(d) => d.opportunities.length === 0} empty={<EmptyState title="No opportunities" detail="No strategy has produced a candidate that meets this account's thresholds." />}>
          {(d) => (
            <DataTable
              rows={d.opportunities}
              columns={cols}
              rowKey={(o) => o.candidateId}
              defaultSort={{ key: "edge", dir: "desc" }}
              renderExpanded={(o) => <OpportunityDetail o={o} />}
            />
          )}
        </QueryState>
      </Panel>
    </>
  );
}

function OpportunityDetail({ o }: { o: Opportunity }) {
  return (
    <div className="grid cols-3">
      <div>
        <h3>Ensemble contributions</h3>
        {o.ensemble && o.ensemble.components.length > 0 ? (
          <>
            <ContributionList components={o.ensemble.components} total={o.expectedEdge} />
            <div className="tiny muted" style={{ marginTop: 6 }}>disagreement {fmt.score(o.ensemble.disagreement)} · uncertainty {fmt.score(o.ensemble.uncertainty)}</div>
          </>
        ) : <div className="muted small">Ensemble breakdown not provided for this candidate.</div>}
      </div>
      <div>
        <h3>Reasons</h3>
        {o.reasons.length > 0 ? <ul className="bullets">{o.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : <div className="muted small">No reasons recorded.</div>}
        {o.risk.notes.length > 0 && <><h3 style={{ marginTop: 10 }}>Risk notes</h3><ul className="bullets">{o.risk.notes.map((r, i) => <li key={i}>{r}</li>)}</ul></>}
      </div>
      <div>
        <h3>Assessment</h3>
        <dl className="kv">
          <dt>Variant score</dt><dd>{fmt.score(o.variantScore)}</dd>
          <dt>Final status</dt><dd><CandidateStatusBadge status={o.finalStatus} /></dd>
          <dt>Portfolio fit</dt><dd>{fmt.signed(o.portfolioFit)}</dd>
          <dt>Catalyst</dt><dd>{o.catalyst ?? <span className="muted">none</span>}</dd>
          <dt>Candidate id</dt><dd className="mono tiny">{o.candidateId}</dd>
        </dl>
      </div>
    </div>
  );
}
