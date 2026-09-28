import { useState } from "react";
import { qs } from "../api/client";
import { useApi } from "../api/hooks";
import type { AnalyticsResponse, PerformanceStats } from "../api/types";
import { useScoped } from "../app/AccountContext";
import { TimeSeriesChart } from "../components/charts/TimeSeriesChart";
import { Column, DataTable } from "../components/DataTable";
import { PageHeader, Segmented } from "../components/Controls";
import { KpiTile } from "../components/KpiTile";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { fmt } from "../lib/fmt";

type Period = "1w" | "1m" | "3m" | "ytd" | "1y" | "all";

export function AnalyticsPage() {
  const scoped = useScoped();
  const [period, setPeriod] = useState<Period>("3m");
  const q = useApi<AnalyticsResponse>(scoped(`analytics${qs({ period })}`));
  return (
    <>
      <PageHeader title="Analytics" sub="Realized performance of this account. Platform-computed statistics are shown separately from the broker's own realized P&L." actions={<Segmented value={period} options={[{ value: "1w", label: "1W" }, { value: "1m", label: "1M" }, { value: "3m", label: "3M" }, { value: "ytd", label: "YTD" }, { value: "1y", label: "1Y" }, { value: "all", label: "All" }]} onChange={setPeriod} />} />
      <QueryState query={q} loadingLabel="Loading analytics" skeleton="kpis">{(d) => <Body d={d} />}</QueryState>
    </>
  );
}

function Body({ d }: { d: AnalyticsResponse }) {
  const p = d.performance;
  type Row = AnalyticsResponse["byStrategy"][number];
  const cols: Column<Row>[] = [
    { key: "s", header: "Strategy", render: (r) => <><strong>{r.name ?? r.strategyKey}</strong> <span className="mono tiny muted">{r.strategyKey}</span></>, sortValue: (r) => r.strategyKey },
    { key: "trades", header: "Trades", align: "right", render: (r) => fmt.int(r.stats.trades), sortValue: (r) => r.stats.trades },
    { key: "wr", header: "Win rate", align: "right", render: (r) => fmt.score(r.stats.winRate), sortValue: (r) => r.stats.winRate },
    { key: "pf", header: "Profit factor", align: "right", render: (r) => fmt.num(r.stats.profitFactor, 2), sortValue: (r) => r.stats.profitFactor },
    { key: "exp", header: "Expectancy", align: "right", render: (r) => <span className={fmt.signClass(r.stats.expectancyPct)}>{fmt.pct(r.stats.expectancyPct, { signed: true })}</span>, sortValue: (r) => r.stats.expectancyPct },
    { key: "avg", header: "Avg win / loss", align: "right", render: (r) => `${fmt.pct(r.stats.avgWinPct, { digits: 1 })} / ${fmt.pct(r.stats.avgLossPct, { digits: 1 })}` },
    { key: "sharpe", header: "Sharpe", align: "right", render: (r) => fmt.num(r.stats.sharpe, 2), sortValue: (r) => r.stats.sharpe },
    { key: "dd", header: "Max DD", align: "right", render: (r) => fmt.pct(r.stats.maxDrawdownPct, { digits: 1 }), sortValue: (r) => r.stats.maxDrawdownPct },
    { key: "hold", header: "Avg hold", align: "right", render: (r) => fmt.days(r.stats.avgHoldingDays), sortValue: (r) => r.stats.avgHoldingDays },
    { key: "slip", header: "Slippage", align: "right", render: (r) => fmt.bps(r.stats.avgSlippageBps), sortValue: (r) => r.stats.avgSlippageBps },
    { key: "pnl", header: "Realized P&L", align: "right", render: (r) => <span className={fmt.signClass(r.realizedPnl)}>{fmt.money(r.realizedPnl, { signed: true })}</span>, sortValue: (r) => r.realizedPnl },
  ];
  return (
    <div className="stack">
      <StatsTiles p={p} />
      <div className="grid cols-3">
        <Panel title="Equity"><TimeSeriesChart data={d.equityCurve} kind="money" area title="Equity" /></Panel>
        <Panel title="Drawdown"><TimeSeriesChart data={d.drawdownCurve.map((x) => ({ time: x.time, value: -Math.abs(x.value) }))} kind="pct" area title="Drawdown" /></Panel>
        <Panel title="Gross exposure"><TimeSeriesChart data={d.exposureHistory} kind="pct" title="Exposure" /></Panel>
      </div>
      <div className="grid cols-3">
        <div className="span-2">
          <Panel title="By strategy" flush>
            <DataTable rows={d.byStrategy} columns={cols} rowKey={(r) => r.strategyKey} defaultSort={{ key: "pnl", dir: "desc" }} compact empty={<EmptyState title="No closed trades in this period" />} />
          </Panel>
        </div>
        <Panel title="Broker realized P&L" foot="Reported by Robinhood, independent of the platform's own trade accounting.">
          {d.realizedPnlFromBroker && d.realizedPnlFromBroker.total !== null ? (
            <KpiTile label={`Realized P&L${d.realizedPnlFromBroker.period ? ` · ${d.realizedPnlFromBroker.period}` : ""}`} value={fmt.money(d.realizedPnlFromBroker.total, { signed: true })} tone={fmt.signClass(d.realizedPnlFromBroker.total)} sub={<>as of {fmt.dateTime(d.realizedPnlFromBroker.asOf)}{d.realizedPnlFromBroker.note ? ` · ${d.realizedPnlFromBroker.note}` : ""}</>} />
          ) : <EmptyState title="Not available from broker" detail={d.realizedPnlFromBroker?.note ?? "Robinhood did not return realized P&L for this account (not connected or not supported)."} />}
        </Panel>
      </div>
    </div>
  );
}

export function StatsTiles({ p }: { p: PerformanceStats }) {
  if (p.trades === 0) return <div className="banner"><span className="grow">No closed trades in this period. Statistics need at least one closed trade.</span></div>;
  return (
    <div className="grid kpis">
      <KpiTile label="Net return" value={fmt.pct(p.netReturnPct, { signed: true, digits: 2 })} tone={fmt.signClass(p.netReturnPct)} />
      <KpiTile label="Trades" value={fmt.int(p.trades)} sub={`${p.wins} W / ${p.losses} L`} />
      <KpiTile label="Win rate" value={fmt.score(p.winRate, 1)} />
      <KpiTile label="Profit factor" value={fmt.num(p.profitFactor, 2)} />
      <KpiTile label="Expectancy" value={fmt.pct(p.expectancyPct, { signed: true })} tone={fmt.signClass(p.expectancyPct)} sub={`avg ${fmt.pct(p.avgReturnPct, { signed: true })}`} />
      <KpiTile label="Sharpe" value={fmt.num(p.sharpe, 2)} sub={`Sortino ${fmt.num(p.sortino, 2)}`} />
      <KpiTile label="Max drawdown" value={fmt.pct(p.maxDrawdownPct, { digits: 2 })} />
      <KpiTile label="Avg holding" value={fmt.days(p.avgHoldingDays)} sub={`slippage ${fmt.bps(p.avgSlippageBps, 1)}`} />
    </div>
  );
}
