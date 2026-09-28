import { useNavigate } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { PositionView } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { Badge } from "../components/Badge";
import { Column, DataTable } from "../components/DataTable";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { StatusPill, freshnessTone } from "../components/StatusPill";
import { PageHeader } from "../components/Controls";
import { fmt } from "../lib/fmt";

export function PositionsPage() {
  const scoped = useScoped();
  const { base, account } = useAccount();
  const navigate = useNavigate();
  const q = useApi<{ positions: PositionView[] }>(scoped("positions"), { refetchInterval: 30_000 });

  const cols: Column<PositionView>[] = [
    { key: "symbol", header: "Symbol", render: (p) => <><span className="sym">{p.symbol}</span> {p.external && <Badge tone="warn" title="Not opened by the platform">External</Badge>}</>, sortValue: (p) => p.symbol },
    { key: "qty", header: "Qty", align: "right", render: (p) => fmt.qty(p.quantity), sortValue: (p) => p.quantity },
    { key: "avg", header: "Avg cost", align: "right", render: (p) => fmt.price(p.averageCost), sortValue: (p) => p.averageCost },
    { key: "mark", header: "Mark", align: "right", render: (p) => fmt.price(p.markPrice), sortValue: (p) => p.markPrice },
    { key: "mv", header: "Market value", align: "right", render: (p) => fmt.money(p.marketValue), sortValue: (p) => p.marketValue },
    { key: "pnl", header: "Unrealized P&L", align: "right", render: (p) => <span className={fmt.signClass(p.unrealizedPnl)}>{fmt.money(p.unrealizedPnl, { signed: true })}</span>, sortValue: (p) => p.unrealizedPnl },
    { key: "pnlpct", header: "P&L %", align: "right", render: (p) => <span className={fmt.signClass(p.unrealizedPnlPct)}>{fmt.pct(p.unrealizedPnlPct, { signed: true })}</span>, sortValue: (p) => p.unrealizedPnlPct },
    { key: "strategy", header: "Strategy", render: (p) => p.strategyKey ? <span className="mono small">{p.strategyKey}</span> : <span className="muted">none</span>, sortValue: (p) => p.strategyKey },
    { key: "conf", header: "Confidence", align: "right", render: (p) => p.initialConfidence === null ? "—" : <span title="initial → current">{fmt.score(p.initialConfidence)} → {fmt.score(p.currentConfidence)}</span>, sortValue: (p) => p.currentConfidence },
    { key: "regime", header: "Regime", render: (p) => p.regimeAtEntry ? <span className="small">{fmt.label(p.regimeAtEntry)} → {fmt.label(p.currentRegime)}</span> : "—" },
    { key: "age", header: "Age / expected", align: "right", render: (p) => `${fmt.days(p.ageDays)} / ${fmt.days(p.expectedHoldingDays)}`, sortValue: (p) => p.ageDays },
    { key: "inval", header: "Invalidation", align: "right", render: (p) => fmt.price(p.invalidationPrice), sortValue: (p) => p.invalidationPrice },
    { key: "target", header: "Target", align: "right", render: (p) => fmt.price(p.targetPrice), sortValue: (p) => p.targetPrice },
    { key: "risk", header: "Risk contrib.", align: "right", render: (p) => fmt.score(p.riskContribution, 1), sortValue: (p) => p.riskContribution },
    { key: "fresh", header: "Data", render: (p) => <StatusPill tone={freshnessTone(p.dataFreshness)}>{p.dataFreshness}</StatusPill> },
  ];

  return (
    <>
      <PageHeader title="Positions" sub={`Open positions in ${account.label}. Click a row for the thesis, exit logic and history.`} />
      <Panel flush>
        <QueryState query={q} loadingLabel="Loading positions" skeleton="table" isEmpty={(d) => d.positions.length === 0} empty={<EmptyState title="No open positions" detail={account.status !== "connected" && account.kind !== "simulated" ? "Robinhood is not connected, so positions cannot be read." : "This account holds no positions."} />}>
          {(d) => <DataTable rows={d.positions} columns={cols} rowKey={(p) => p.symbol} defaultSort={{ key: "mv", dir: "desc" }} onRowClick={(p) => navigate(`${base}/positions/${encodeURIComponent(p.symbol)}`)} />}
        </QueryState>
      </Panel>
    </>
  );
}
