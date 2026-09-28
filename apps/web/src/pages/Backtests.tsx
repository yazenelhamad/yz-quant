import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { qs } from "../api/client";
import { useApi, useApiMutation } from "../api/hooks";
import type { BacktestKind, BacktestRun, BacktestsResponse, RunBacktestBody, RunBacktestResponse, SharedStrategiesResponse } from "../api/types";
import { useAccount } from "../app/AccountContext";
import { Badge } from "../components/Badge";
import { Column, DataTable } from "../components/DataTable";
import { Field, PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { fmt } from "../lib/fmt";

const KINDS: BacktestKind[] = ["in_sample", "out_of_sample", "walk_forward", "monte_carlo", "stress", "sensitivity"];

export function BacktestsPage() {
  const { base } = useAccount();
  const navigate = useNavigate();
  const [strategyKey, setStrategyKey] = useState("");
  const q = useApi<BacktestsResponse>(`/backtests${qs({ strategyKey })}`, { refetchInterval: 15_000 });
  const strategies = useApi<SharedStrategiesResponse>("/strategies");
  const [form, setForm] = useState<RunBacktestBody>({ strategyKey: "", symbols: [], start: "", end: "", kind: "in_sample" });
  const [symbolsText, setSymbolsText] = useState("");
  const run = useApiMutation<RunBacktestResponse, RunBacktestBody>({ invalidate: ["/backtests"] });

  const cols: Column<BacktestRun>[] = [
    { key: "requested", header: "Requested", render: (b) => fmt.dateTime(b.requestedAt), sortValue: (b) => b.requestedAt },
    { key: "strategy", header: "Strategy", render: (b) => <span className="mono small">{b.strategyKey}</span>, sortValue: (b) => b.strategyKey },
    { key: "kind", header: "Kind", render: (b) => fmt.label(b.kind), sortValue: (b) => b.kind },
    { key: "symbols", header: "Symbols", render: (b) => <span title={b.symbols.join(", ")}>{b.symbols.length <= 4 ? b.symbols.join(", ") : `${b.symbols.slice(0, 4).join(", ")} +${b.symbols.length - 4}`}</span> },
    { key: "window", header: "Window", render: (b) => `${fmt.date(b.start)} – ${fmt.date(b.end)}` },
    { key: "status", header: "Status", render: (b) => <Badge tone={b.status === "completed" ? "pos" : b.status === "failed" ? "neg" : "accent"}>{b.status}</Badge>, sortValue: (b) => b.status },
    { key: "ret", header: "Net return", align: "right", render: (b) => <span className={fmt.signClass(b.summary?.totalReturnPct)}>{fmt.pct(b.summary?.totalReturnPct, { signed: true, digits: 1 })}</span>, sortValue: (b) => b.summary?.totalReturnPct },
    { key: "sharpe", header: "Sharpe", align: "right", render: (b) => fmt.num(b.summary?.sharpe, 2), sortValue: (b) => b.summary?.sharpe },
    { key: "dd", header: "Max DD", align: "right", render: (b) => fmt.pct(b.summary?.maxDrawdownPct, { digits: 1 }), sortValue: (b) => b.summary?.maxDrawdownPct },
    { key: "trades", header: "Trades", align: "right", render: (b) => fmt.int(b.summary?.tradeCount), sortValue: (b) => b.summary?.tradeCount },
  ];

  return (
    <>
      <PageHeader title="Backtests" sub="Bias-aware simulations with realistic costs. Results feed promotion reviews; they never change a live account." actions={
        <label className="row small">Strategy
          <select value={strategyKey} onChange={(e) => setStrategyKey(e.target.value)}>
            <option value="">All</option>
            {strategies.data?.strategies.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
          </select>
        </label>
      } />
      <div className="grid cols-3">
        <div className="span-2">
          <Panel title="Runs" flush>
            <QueryState query={q} loadingLabel="Loading backtests" skeleton="table" isEmpty={(d) => d.backtests.length === 0} empty={<EmptyState title="No backtests yet" detail="Queue one with the form." />}>
              {(d) => <DataTable rows={d.backtests} columns={cols} rowKey={(b) => b.id} defaultSort={{ key: "requested", dir: "desc" }} onRowClick={(b) => navigate(`${base}/backtests/${b.id}`)} rowClass={(b) => (b.status === "failed" ? "" : undefined)} />}
            </QueryState>
          </Panel>
        </div>
        <Panel title="Run a backtest">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const symbols = symbolsText.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
            run.mutate({ path: "/backtests", body: { ...form, symbols } });
          }}>
            <Field label="Strategy">
              <select value={form.strategyKey} onChange={(e) => setForm({ ...form, strategyKey: e.target.value })} required>
                <option value="">Select…</option>
                {strategies.data?.strategies.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Kind"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as BacktestKind })}>{KINDS.map((k) => <option key={k} value={k}>{fmt.label(k)}</option>)}</select></Field>
            <Field label="Symbols" hint="Comma-separated. Delisted names in the window are included for survivorship protection."><input type="text" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} placeholder="AAPL, MSFT, NVDA" required /></Field>
            <div className="grid cols-2">
              <Field label="Start"><input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} required /></Field>
              <Field label="End"><input type="date" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} required /></Field>
            </div>
            {run.isError && <div className="error-text">{run.error.message}</div>}
            {run.isSuccess && <div className="ok-text">Queued as <code>{run.data.id}</code> ({run.data.status}).</div>}
            <div className="form-actions"><button className="btn primary" disabled={run.isPending || !form.strategyKey}>{run.isPending ? "Queuing…" : "Queue run"}</button></div>
          </form>
        </Panel>
      </div>
    </>
  );
}
