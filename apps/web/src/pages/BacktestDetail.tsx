import { Link, useParams } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { BacktestDetailResponse, BacktestMetrics, BacktestTrade } from "../api/types";
import { useAccount } from "../app/AccountContext";
import { Badge } from "../components/Badge";
import { BandChart } from "../components/charts/BandChart";
import { TimeSeriesChart } from "../components/charts/TimeSeriesChart";
import { Column, DataTable } from "../components/DataTable";
import { KV, PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { fmt } from "../lib/fmt";

export function BacktestDetailPage() {
  const { backtestId = "" } = useParams();
  const { base } = useAccount();
  const q = useApi<BacktestDetailResponse>(`/backtests/${encodeURIComponent(backtestId)}`, { refetchInterval: (query) => (query.state.data?.backtest.status === "completed" || query.state.data?.backtest.status === "failed" ? false : 5000) });
  return (
    <>
      <PageHeader title={<><Link to={`${base}/backtests`} className="dim">Backtests</Link> <span className="muted">/</span> {q.data ? `${q.data.backtest.strategyKey} · ${fmt.label(q.data.backtest.kind)}` : backtestId}</>} sub={q.data ? `${q.data.backtest.symbols.join(", ")} · ${fmt.date(q.data.backtest.start)} – ${fmt.date(q.data.backtest.end)}` : undefined} />
      <QueryState query={q}>{(d) => <Body d={d} />}</QueryState>
    </>
  );
}

function MetricsGrid({ m }: { m: BacktestMetrics }) {
  const tile = (label: string, value: string, tone?: "pos" | "neg" | "flat") => (
    <div className="kpi" key={label}><div className="kpi-label">{label}</div><div className={`kpi-value ${tone ?? ""}`} style={{ fontSize: 18 }}>{value}</div></div>
  );
  return (
    <div className="grid kpis">
      {tile("Net return", fmt.pct(m.netReturnPct, { signed: true, digits: 1 }), fmt.signClass(m.netReturnPct))}
      {tile("Gross return", fmt.pct(m.grossReturnPct, { signed: true, digits: 1 }))}
      {tile("CAGR", fmt.pct(m.cagr, { digits: 1 }))}
      {tile("Sharpe", fmt.num(m.sharpe, 2))}
      {tile("Sortino", fmt.num(m.sortino, 2))}
      {tile("Calmar", fmt.num(m.calmar, 2))}
      {tile("Max drawdown", fmt.pct(m.maxDrawdownPct, { digits: 1 }))}
      {tile("DD duration", `${fmt.int(m.maxDrawdownDurationBars)} bars`)}
      {tile("Win rate", fmt.score(m.winRate))}
      {tile("Profit factor", fmt.num(m.profitFactor, 2))}
      {tile("Expectancy", fmt.pct(m.expectancyPct, { signed: true }))}
      {tile("Trades", fmt.int(m.tradeCount))}
      {tile("Turnover", fmt.num(m.turnover, 2))}
      {tile("Exposure", fmt.score(m.exposure))}
      {tile("VaR 95", fmt.pct(m.var95Pct, { digits: 1 }))}
      {tile("CVaR 95", fmt.pct(m.cvar95Pct, { digits: 1 }))}
      {tile("Total costs", fmt.money(m.totalCosts))}
      {tile("Ann. volatility", fmt.pct(m.annualizedVolatility, { digits: 1 }))}
    </div>
  );
}

function Body({ d }: { d: BacktestDetailResponse }) {
  const { backtest: b, result: r, walkForward: wf, monteCarlo: mc } = d;
  if (b.status === "failed") return <div className="banner bad">Run failed: {b.error ?? "no error detail"}</div>;
  if (!r) return <EmptyState title={b.status === "queued" ? "Queued" : "Running"} detail="Results appear here when the run completes. This page refreshes automatically." />;

  const tradeCols: Column<BacktestTrade>[] = [
    { key: "symbol", header: "Symbol", render: (t) => t.symbol, sortValue: (t) => t.symbol },
    { key: "entry", header: "Entry", render: (t) => `${fmt.date(t.entryTime)} @ ${fmt.price(t.entryPrice)}`, sortValue: (t) => t.entryTime },
    { key: "exit", header: "Exit", render: (t) => t.exitTime ? `${fmt.date(t.exitTime)} @ ${fmt.price(t.exitPrice)}` : <span className="muted">open</span>, sortValue: (t) => t.exitTime },
    { key: "qty", header: "Qty", align: "right", render: (t) => fmt.qty(t.quantity) },
    { key: "ret", header: "Return", align: "right", render: (t) => <span className={fmt.signClass(t.returnPct)}>{fmt.pct(t.returnPct, { signed: true })}</span>, sortValue: (t) => t.returnPct },
    { key: "net", header: "Net P&L", align: "right", render: (t) => <span className={fmt.signClass(t.netPnl)}>{fmt.money(t.netPnl, { signed: true })}</span>, sortValue: (t) => t.netPnl },
    { key: "costs", header: "Costs", align: "right", render: (t) => fmt.money(t.costs), sortValue: (t) => t.costs },
    { key: "bars", header: "Bars", align: "right", render: (t) => fmt.int(t.holdingBars), sortValue: (t) => t.holdingBars },
    { key: "mae", header: "MAE / MFE", align: "right", render: (t) => `${fmt.pct(t.maePct, { digits: 1 })} / ${fmt.pct(t.mfePct, { digits: 1 })}` },
    { key: "regime", header: "Regime", render: (t) => fmt.label(t.regime), sortValue: (t) => t.regime },
    { key: "conf", header: "Conf.", align: "right", render: (t) => fmt.score(t.confidence), sortValue: (t) => t.confidence },
    { key: "reason", header: "Exit reason", render: (t) => fmt.label(t.exitReason) },
  ];

  return (
    <div className="stack">
      {r.warnings.length > 0 && <div className="banner warn"><ul className="bullets tight" style={{ margin: 0 }}>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      <MetricsGrid m={r.metrics} />
      <div className="grid cols-2">
        <Panel title="Equity curve"><TimeSeriesChart data={r.equityCurve.map((p) => ({ time: p.time, value: p.equity }))} kind="money" area title="Equity" /></Panel>
        <Panel title="Drawdown"><TimeSeriesChart data={r.equityCurve.map((p) => ({ time: p.time, value: -Math.abs(p.drawdownPct) }))} kind="pct" area title="Drawdown" /></Panel>
      </div>
      <div className="grid cols-3">
        <Panel title="Configuration">
          <KV items={[
            ["Strategy version", r.config.strategyVersion],
            ["Interval", r.config.interval],
            ["Initial capital", fmt.money(r.config.initialCapital, { whole: true })],
            ["Parameters", Object.keys(r.config.parameters).length ? Object.entries(r.config.parameters).map(([k, v]) => <span className="tag" key={k}>{k}={String(v)}</span>) : "defaults"],
            ["Data fingerprint", <code className="tiny">{r.dataFingerprint}</code>],
            ["Ran", `${fmt.dateTime(r.ranAt)} · ${fmt.duration(r.durationMs)}`],
          ]} />
        </Panel>
        <Panel title="By regime" flush>
          {Object.keys(r.metrics.byRegime).length === 0 ? <EmptyState title="No regime breakdown" /> : (
            <table className="data compact"><thead><tr><th>Regime</th><th className="num">Trades</th><th className="num">Return</th><th className="num">Win rate</th></tr></thead>
              <tbody>{Object.entries(r.metrics.byRegime).map(([k, v]) => <tr key={k}><td>{fmt.label(k)}</td><td className="num">{fmt.int(v.trades)}</td><td className={`num ${fmt.signClass(v.returnPct)}`}>{fmt.pct(v.returnPct, { signed: true, digits: 1 })}</td><td className="num">{fmt.score(v.winRate)}</td></tr>)}</tbody></table>
          )}
        </Panel>
        <Panel title="Monte Carlo">
          {mc ? (
            <>
              <KV items={[
                ["Runs", fmt.int(mc.runs)],
                ["Return p05 / median / p95", `${fmt.pct(mc.p05ReturnPct, { digits: 1 })} / ${fmt.pct(mc.medianReturnPct, { digits: 1 })} / ${fmt.pct(mc.p95ReturnPct, { digits: 1 })}`],
                ["Max DD median / p95", `${fmt.pct(mc.medianMaxDrawdownPct, { digits: 1 })} / ${fmt.pct(mc.p95MaxDrawdownPct, { digits: 1 })}`],
                ["Probability of loss", <span className={mc.probabilityOfLoss > 0.4 ? "warn-text" : ""}>{fmt.score(mc.probabilityOfLoss)}</span>],
              ]} />
              <div style={{ marginTop: 10 }}><BandChart bands={mc.bands} height={180} /></div>
            </>
          ) : <EmptyState title="No Monte Carlo result" detail="Run a monte_carlo backtest to see resampled paths." />}
        </Panel>
      </div>
      <Panel title="Walk-forward folds" flush>
        {!wf ? <EmptyState title="No walk-forward result" detail="Run a walk_forward backtest to see out-of-sample folds." /> : (
          <>
            <div className="panel-body row" style={{ gap: 16 }}>
              <span className="small">Aggregate net return <strong className={fmt.signClass(wf.aggregate.netReturnPct)}>{fmt.pct(wf.aggregate.netReturnPct, { signed: true, digits: 1 })}</strong></span>
              <span className="small">Sharpe <strong>{fmt.num(wf.aggregate.sharpe, 2)}</strong></span>
              <span className="small">Parameter stability <strong>{fmt.num(wf.parameterStability, 2)}</strong></span>
              <span className="small">Overfitting score <strong className={wf.overfittingScore !== null && wf.overfittingScore > 0.5 ? "warn-text" : ""}>{fmt.num(wf.overfittingScore, 2)}</strong></span>
            </div>
            <table className="data compact">
              <thead><tr><th>#</th><th>Train</th><th>Test</th><th className="num">Net return</th><th className="num">Sharpe</th><th className="num">Max DD</th><th className="num">Trades</th><th>Parameters</th></tr></thead>
              <tbody>{wf.folds.map((f, i) => <tr key={i}><td>{i + 1}</td><td>{fmt.date(f.train[0])} – {fmt.date(f.train[1])}</td><td>{fmt.date(f.test[0])} – {fmt.date(f.test[1])}</td><td className={`num ${fmt.signClass(f.metrics.netReturnPct)}`}>{fmt.pct(f.metrics.netReturnPct, { signed: true, digits: 1 })}</td><td className="num">{fmt.num(f.metrics.sharpe, 2)}</td><td className="num">{fmt.pct(f.metrics.maxDrawdownPct, { digits: 1 })}</td><td className="num">{fmt.int(f.metrics.tradeCount)}</td><td className="wrap">{Object.entries(f.parameters).map(([k, v]) => <span className="tag" key={k}>{k}={String(v)}</span>)}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </Panel>
      <Panel title={`Trades (${r.trades.length})`} flush>
        <DataTable rows={r.trades} columns={tradeCols} rowKey={(t) => `${t.symbol}-${t.entryTime}`} defaultSort={{ key: "entry", dir: "asc" }} compact maxHeight={480} empty={<EmptyState title="No trades were generated" />} />
      </Panel>
      <div className="tiny muted">Status: <Badge tone="outline">{b.status}</Badge> · completed {fmt.dateTime(b.completedAt)}</div>
    </div>
  );
}
