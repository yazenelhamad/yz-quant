import { useApi } from "../../api/hooks";
import type { ComparisonResponse, ComparisonRow } from "../../api/types";
import { AutonomyBadge, Badge } from "../../components/Badge";
import { Banner, PageHeader } from "../../components/Controls";
import { Meter } from "../../components/Meter";
import { Panel } from "../../components/Panel";
import { EmptyState, QueryState } from "../../components/States";
import { StatusPill, brokerText, brokerTone } from "../../components/StatusPill";
import { fmt } from "../../lib/fmt";
import { inferFormat } from "../../lib/riskFormat";

export function ComparisonPage() {
  const q = useApi<ComparisonResponse>("/admin/comparison", { refetchInterval: 30_000 });
  return (
    <>
      <PageHeader title="Account comparison" sub="Informational, side-by-side view of each user's account. Portfolios are never merged; there are no combined totals by design." />
      <div className="stack">
        <Banner tone="info">Read-only. Admin cannot trade, resize or reconfigure another user's account from here.</Banner>
        <QueryState query={q} loadingLabel="Loading comparison" skeleton="kpis" isEmpty={(d) => d.accounts.length === 0} empty={<EmptyState title="No accounts" />}>
          {(d) => (
            <>
              <div className="grid auto">{d.accounts.map((r) => <Card key={r.account.id} r={r} />)}</div>
              <Panel title="Side by side" flush>
                <table className="data">
                  <thead><tr><th>Metric</th>{d.accounts.map((r) => <th key={r.account.id} className="num">{r.owner.displayName} · {r.account.label}</th>)}</tr></thead>
                  <tbody>
                    <Row label="Kind" cells={d.accounts.map((r) => r.account.kind === "simulated" ? "Simulated" : "Robinhood")} />
                    <Row label="Portfolio value" cells={d.accounts.map((r) => r.account.portfolio ? fmt.money(r.account.portfolio.totalValue) : "No data")} />
                    <Row label="Daily P&L" cells={d.accounts.map((r) => fmt.money(r.dailyPnl, { signed: true }))} tones={d.accounts.map((r) => fmt.signClass(r.dailyPnl))} />
                    <Row label="Total return" cells={d.accounts.map((r) => fmt.pct(r.totalReturnPct, { signed: true }))} tones={d.accounts.map((r) => fmt.signClass(r.totalReturnPct))} />
                    <Row label="Drawdown" cells={d.accounts.map((r) => fmt.pct(r.drawdownPct))} />
                    <Row label="Exposure" cells={d.accounts.map((r) => fmt.pct(r.exposurePct, { digits: 1 }))} />
                    <Row label="Positions" cells={d.accounts.map((r) => fmt.int(r.positions))} />
                    <Row label="Active strategies" cells={d.accounts.map((r) => fmt.int(r.activeStrategies))} />
                    <Row label="Autonomy" cells={d.accounts.map((r) => fmt.label(r.account.autonomyLevel))} />
                    <Row label="State" cells={d.accounts.map((r) => r.account.killSwitchActive ? "Kill switch" : r.account.tradingPaused ? "Paused" : "Active")} />
                  </tbody>
                </table>
              </Panel>
            </>
          )}
        </QueryState>
      </div>
    </>
  );
}

function Row({ label, cells, tones }: { label: string; cells: string[]; tones?: ("pos" | "neg" | "flat")[] }) {
  return <tr><td>{label}</td>{cells.map((c, i) => <td key={i} className={`num ${tones?.[i] ?? ""}`}>{c}</td>)}</tr>;
}

function Card({ r }: { r: ComparisonRow }) {
  const a = r.account;
  return (
    <Panel title={<div><h2>{r.owner.displayName}</h2><div className="tiny muted">{a.label} · {a.accountNumberMasked ?? "no number"} {a.kind === "simulated" && <Badge tone="sim">Simulated</Badge>}</div></div>} actions={<AutonomyBadge level={a.autonomyLevel} />}>
      <div className="row" style={{ marginBottom: 8 }}>
        <StatusPill tone={a.kind === "simulated" ? "neutral" : brokerTone(a.status)}>{brokerText(a.status, a.kind)}</StatusPill>
        {a.killSwitchActive && <Badge tone="neg">Kill switch</Badge>}
        {a.tradingPaused && <Badge tone="warn">Paused</Badge>}
      </div>
      <div className="grid cols-2">
        <div className="kpi"><div className="kpi-label">Portfolio value</div><div className={`kpi-value ${a.portfolio ? "" : "na"}`} style={{ fontSize: 18 }}>{a.portfolio ? fmt.money(a.portfolio.totalValue) : "No data"}</div></div>
        <div className="kpi"><div className="kpi-label">Daily P&L</div><div className={`kpi-value ${fmt.signClass(r.dailyPnl)}`} style={{ fontSize: 18 }}>{fmt.money(r.dailyPnl, { signed: true })}</div></div>
      </div>
      <div style={{ marginTop: 8 }}>
        {Object.keys(r.riskUtilization).length === 0 ? <div className="muted small">No utilization data.</div> : Object.entries(r.riskUtilization).map(([k, v]) => <Meter key={k} label={fmt.label(k)} used={v.used} limit={v.limit} format={inferFormat(k)} />)}
      </div>
    </Panel>
  );
}
