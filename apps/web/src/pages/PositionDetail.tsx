import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { post } from "../api/client";
import { useApi, useInvalidate } from "../api/hooks";
import type { ClosePositionResponse, PositionDetail } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { Badge } from "../components/Badge";
import { ConfirmDialog } from "../components/Dialog";
import { Explanation, type EvidenceItem } from "../components/Explanation";
import { Panel } from "../components/Panel";
import { EmptyState, QueryState } from "../components/States";
import { StatusPill, freshnessTone } from "../components/StatusPill";
import { KV, PageHeader } from "../components/Controls";
import { fmt } from "../lib/fmt";
import { OrdersTable } from "../components/OrdersTable";

export function PositionDetailPage() {
  const { symbol = "" } = useParams();
  const scoped = useScoped();
  const { base, account, isOwner } = useAccount();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const q = useApi<PositionDetail>(scoped(`positions/${encodeURIComponent(symbol)}`), { refetchInterval: 30_000 });
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<ClosePositionResponse | null>(null);

  const brokerOk = account.kind === "simulated" || account.status === "connected";

  return (
    <>
      <PageHeader
        title={<><Link to={`${base}/positions`} className="dim">Positions</Link> <span className="muted">/</span> {symbol}</>}
        sub={q.data ? `${fmt.qty(q.data.quantity)} shares · ${fmt.money(q.data.marketValue)} · ${q.data.strategyKey ?? "no strategy"}` : undefined}
        actions={isOwner && (
          <button className="btn danger" disabled={!brokerOk || !q.data} onClick={() => setClosing(true)} title={brokerOk ? "Submit a full exit through the risk and execution engines" : "Robinhood is not connected"}>Close position</button>
        )}
      />
      {!brokerOk && <div className="banner warn" style={{ marginBottom: 12 }}>Robinhood is not connected. Closing is refused until the connection is healthy.</div>}
      {closed && <div className="banner ok" style={{ marginBottom: 12 }}>Exit submitted. Trade <code>{closed.tradeId}</code>{closed.orderId ? <> · order <code>{closed.orderId}</code></> : " · no order id returned yet"}.</div>}
      <QueryState query={q}>{(p) => <Body p={p} />}</QueryState>
      {closing && q.data && (
        <ConfirmDialog
          title={`Close ${symbol}`}
          danger
          confirmLabel="Submit exit"
          reasonLabel="Reason (journaled)"
          requireText={symbol}
          body={<p>This submits a sell of <strong>{fmt.qty(q.data.sharesAvailableForSells)}</strong> available shares through the risk engine (exit path) and execution engine. It cannot be undone once filled.</p>}
          onCancel={() => setClosing(false)}
          onConfirm={async (reason) => {
            const r = await post<ClosePositionResponse>(scoped(`positions/${encodeURIComponent(symbol)}/close`), { reason });
            setClosed(r);
            setClosing(false);
            await invalidate(scoped("positions"), scoped("orders"), scoped("overview"));
            if (r.orderId) navigate(`${base}/positions/${encodeURIComponent(symbol)}`);
          }}
        />
      )}
    </>
  );
}

function Body({ p }: { p: PositionDetail }) {
  const t = p.thesis;
  const evidence: EvidenceItem[] = [
    ...(t?.supportingEvidence ?? []).map((e) => ({ label: e.summary, source: e.source, reliability: e.reliability, observedAt: e.observedAt, kind: e.kind, polarity: "for" as const })),
    ...(t?.contradictingEvidence ?? []).map((e) => ({ label: e.summary, source: e.source, reliability: e.reliability, observedAt: e.observedAt, kind: e.kind, polarity: "against" as const })),
  ];
  return (
    <div className="stack">
      <div className="grid cols-4">
        <Panel title="Position">
          <KV items={[
            ["Quantity", `${fmt.qty(p.quantity)} (${fmt.qty(p.sharesAvailableForSells)} sellable)`],
            ["Avg cost", fmt.price(p.averageCost)],
            ["Mark", <>{fmt.price(p.markPrice)} <StatusPill tone={freshnessTone(p.dataFreshness)}>{p.dataFreshness}</StatusPill></>],
            ["Market value", fmt.money(p.marketValue)],
            ["Unrealized", <span className={fmt.signClass(p.unrealizedPnl)}>{fmt.money(p.unrealizedPnl, { signed: true })} ({fmt.pct(p.unrealizedPnlPct, { signed: true })})</span>],
            ["Risk contribution", fmt.score(p.riskContribution, 1)],
            ["Origin", p.external ? <Badge tone="warn">External — not opened by the platform</Badge> : <Badge tone="outline">Platform</Badge>],
          ]} />
        </Panel>
        <Panel title="Thesis">
          <KV items={[
            ["Strategy", p.strategyKey ?? "—"],
            ["Confidence", p.initialConfidence === null ? "—" : `${fmt.score(p.initialConfidence)} initial → ${fmt.score(p.currentConfidence)} now`],
            ["Regime", p.regimeAtEntry ? `${fmt.label(p.regimeAtEntry)} → ${fmt.label(p.currentRegime)}` : "—"],
            ["Holding", `${fmt.days(p.ageDays)} of ${fmt.days(p.expectedHoldingDays)} expected`],
            ["Thesis status", t ? <Badge tone={t.status === "active" ? "pos" : t.status === "invalidated" ? "neg" : "outline"}>{t.status}</Badge> : <span className="muted">no thesis</span>],
            ["Trade id", p.tradeId ? <code>{p.tradeId}</code> : "—"],
          ]} />
        </Panel>
        <Panel title="Exit plan">
          <KV items={[
            ["Invalidation price", fmt.price(p.invalidationPrice)],
            ["Invalidation", p.invalidationCondition ?? "—"],
            ["Target", fmt.price(p.targetPrice)],
            ["Exit logic", p.exitLogic ?? "—"],
            ["Exit conditions", t && t.exitConditions.length > 0 ? <ul className="bullets tight">{t.exitConditions.map((c, i) => <li key={i}>{c}</li>)}</ul> : "—"],
          ]} />
        </Panel>
        <Panel title="Hold vs exit">
          <h3>Reasons to hold</h3>
          {p.reasonsToHold.length ? <ul className="bullets tight">{p.reasonsToHold.map((r, i) => <li key={i}>{r}</li>)}</ul> : <div className="muted small">None recorded.</div>}
          <h3 style={{ marginTop: 8 }}>Reasons to exit</h3>
          {p.reasonsToExit.length ? <ul className="bullets tight">{p.reasonsToExit.map((r, i) => <li key={i}>{r}</li>)}</ul> : <div className="muted small">None recorded.</div>}
        </Panel>
      </div>

      <Explanation title="Entry reason" text={p.entryReason ?? t?.plainEnglish ?? null} evidence={evidence} defaultOpen={false}>
        {t && <div className="small dim" style={{ marginTop: 6 }}>Entry logic: {t.entryLogic}</div>}
      </Explanation>

      <div className="grid cols-3">
        <Panel title="Model votes">
          {p.modelVotes.length === 0 ? <EmptyState title="No model votes" detail="AI models: not configured or no committee ran for this trade." /> : (
            <table className="data compact">
              <thead><tr><th>Agent</th><th>Vote</th><th className="num">Conf.</th></tr></thead>
              <tbody>{p.modelVotes.map((v, i) => <tr key={i} title={v.note}><td>{fmt.label(v.agent)}</td><td><Badge tone={/buy|proceed/.test(v.vote) ? "pos" : /sell|reject|reduce/.test(v.vote) ? "neg" : "outline"}>{fmt.label(v.vote)}</Badge></td><td className="num">{fmt.score(v.confidence)}</td></tr>)}</tbody>
            </table>
          )}
          {t?.devilsAdvocate && (
            <div style={{ marginTop: 10 }}>
              <h3>Devil's advocate · <span className="warn-text">{t.devilsAdvocate.verdict}</span></h3>
              <ul className="bullets tight small">{t.devilsAdvocate.whyWrong.map((w, i) => <li key={i}>{w}</li>)}</ul>
              <div className="row" style={{ marginTop: 4 }}>
                {t.devilsAdvocate.late && <Badge tone="warn">late</Badge>}{t.devilsAdvocate.pricedIn && <Badge tone="warn">priced in</Badge>}{t.devilsAdvocate.eventRisk && <Badge tone="warn">event risk</Badge>}{t.devilsAdvocate.sharedSignalRisk && <Badge tone="warn">shared signal</Badge>}{t.devilsAdvocate.overconfidenceFlag && <Badge tone="warn">overconfidence</Badge>}
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Thesis history">
          {p.thesisHistory.length === 0 ? <EmptyState title="No thesis revisions" /> : (
            <ul className="timeline">{p.thesisHistory.map((h) => <li key={h.thesisId}><span className="when">{fmt.dateTime(h.at)}</span><span><Badge tone="outline">{h.status}</Badge> conf {fmt.score(h.confidence)} / calib {fmt.score(h.calibratedConfidence)} / edge {fmt.signed(h.expectedEdge)}<div className="dim small">{h.summary}</div></span></li>)}</ul>
          )}
        </Panel>
        <Panel title="News">
          {p.news.length === 0 ? <EmptyState title="No news attached" /> : (
            <ul className="list">{p.news.map((n, i) => <li key={i}><span className="grow">{n.url ? <a href={n.url} target="_blank" rel="noreferrer noopener">{n.headline}</a> : n.headline}<div className="tiny muted">{n.source}{n.genuinelyNew === false ? " · already known" : ""}</div></span><span className="when">{fmt.ago(n.at)}</span></li>)}</ul>
          )}
        </Panel>
      </div>

      <div className="grid cols-2">
        <Panel title="Similar historical trades" flush>
          {p.similarTrades.length === 0 ? <EmptyState title="No analogs" detail="Not enough trade memory to find similar setups." /> : (
            <table className="data compact">
              <thead><tr><th>Symbol</th><th>Strategy</th><th>Regime</th><th className="num">Similarity</th><th className="num">Return</th><th>Thesis</th><th>Lesson</th></tr></thead>
              <tbody>{p.similarTrades.map((s) => <tr key={s.tradeId}><td>{s.symbol}</td><td className="mono small">{s.strategyKey}</td><td>{fmt.label(s.regime)}</td><td className="num">{fmt.score(s.similarity)}</td><td className={`num ${fmt.signClass(s.returnPct)}`}>{fmt.pct(s.returnPct, { signed: true, digits: 1 })}</td><td>{s.thesisCorrect === null ? "—" : s.thesisCorrect ? <Badge tone="pos">correct</Badge> : <Badge tone="neg">wrong</Badge>}</td><td className="wrap small">{s.lesson ?? "—"}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Orders" flush>
          <OrdersTable orders={p.orders} />
        </Panel>
      </div>
    </div>
  );
}
