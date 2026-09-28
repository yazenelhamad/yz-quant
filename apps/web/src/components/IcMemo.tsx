import type { ReactNode } from "react";
import type { TradeThesis } from "../api/types";
import { fmt } from "../lib/fmt";
import { Badge } from "./Badge";

function Sec({ n, title, children, none, action }: { n: number; title: string; children?: ReactNode; none?: boolean; action?: boolean }) {
  return (
    <section className={`memo-sec ${action ? "action" : ""}`}>
      <div className="k"><span className="n">{String(n).padStart(2, "0")}</span>{title}</div>
      {none ? <div className="b none">Not recorded in this thesis.</div> : <div className="b">{children}</div>}
    </section>
  );
}

/**
 * Investment-committee memo layout for a trade thesis. Every section maps to a real thesis field and
 * says "Not recorded" when that field is empty; nothing is inferred or invented.
 */
export function IcMemo({ t }: { t: TradeThesis }) {
  const against = t.contradictingEvidence;
  const da = t.devilsAdvocate;
  const marketBelief = against.length > 0 || da?.pricedIn;
  const variant = t.variantPerception;
  const action = variant?.recommendedAction || da?.verdict || null;
  const verdictTone = da?.verdict === "proceed" ? "pos" : da?.verdict === "reject" ? "neg" : da?.verdict ? "warn" : "outline";
  return (
    <div>
      <div className="memo-head">
        <span className="title">IC memo · {t.ticker} · {fmt.label(t.direction)}</span>
        <span className="row tiny muted">
          <span>edge <span className="num">{fmt.signed(t.expectedEdge)}</span></span>
          <span>· conf <span className="num">{fmt.score(t.confidence)}</span> → calib <span className="num">{fmt.score(t.calibratedConfidence)}</span></span>
          <span>· regime {fmt.label(t.marketRegime)}</span>
          <span>· hold {fmt.days(t.expectedHoldingPeriodDays)}</span>
          <Badge tone={t.status === "active" ? "pos" : t.status === "invalidated" ? "neg" : "outline"}>{t.status}</Badge>
        </span>
      </div>
      <div className="memo">
        <Sec n={1} title="Market belief" none={!marketBelief}>
          {da?.pricedIn && <div><Badge tone="warn">priced in</Badge> <span className="dim">The devil's advocate judged the setup already reflected in price.</span></div>}
          {against.length > 0 && <ul className="bullets tight" style={{ marginTop: da?.pricedIn ? 6 : 0 }}>{against.slice(0, 4).map((e, i) => <li key={i}>{e.summary} <span className="tiny muted">({e.source}, reliability {fmt.score(e.reliability)})</span></li>)}</ul>}
        </Sec>
        <Sec n={2} title="Our view" none={!t.plainEnglish && !t.entryLogic}>
          {t.plainEnglish && <div className="pre">{t.plainEnglish}</div>}
          {t.entryLogic && <div className="small dim" style={{ marginTop: 4 }}>Entry logic: {t.entryLogic}</div>}
          {t.supportingEvidence.length > 0 && <div className="tiny muted" style={{ marginTop: 4 }}>{t.supportingEvidence.length} supporting · {against.length} contradicting evidence items</div>}
        </Sec>
        <Sec n={3} title="Variant perception" none={!variant}>
          {variant && <>
            <div><span className="num" style={{ fontWeight: 600 }}>{fmt.score(variant.score)}</span> <span className="dim">variant score</span></div>
            <div className="pre" style={{ marginTop: 4 }}>{variant.summary}</div>
          </>}
        </Sec>
        <Sec n={4} title="Catalyst" none={!t.catalyst}>
          <div>{t.catalyst}</div>
          {t.catalystAt && <div className="tiny muted">expected {fmt.dateTime(t.catalystAt)}</div>}
        </Sec>
        <Sec n={5} title="Invalidation" none={!t.invalidationPoint && t.invalidationPrice === null}>
          {t.invalidationPoint && <div>{t.invalidationPoint}</div>}
          <div className="row tiny muted" style={{ marginTop: 4 }}>
            {t.invalidationPrice !== null && <span>price <span className="num">{fmt.price(t.invalidationPrice)}</span></span>}
            {t.targetPrice !== null && <span>· target <span className="num">{fmt.price(t.targetPrice)}</span></span>}
            <span>· max loss <span className="num">{fmt.pct(t.maxAcceptableLossPct, { digits: 1 })}</span></span>
            <span>· up <span className="num">{fmt.pct(t.expectedUpsidePct, { digits: 1 })}</span> / down <span className="num">{fmt.pct(t.expectedDownsidePct, { digits: 1 })}</span></span>
          </div>
          {t.exitConditions.length > 0 && <ul className="bullets tight small" style={{ marginTop: 4 }}>{t.exitConditions.map((c, i) => <li key={i}>{c}</li>)}</ul>}
        </Sec>
        <Sec n={6} title="Recommended action" action none={!action}>
          <div className="row">
            {da?.verdict && <Badge tone={verdictTone}>{fmt.label(da.verdict)}</Badge>}
            <span>{variant?.recommendedAction ?? (da?.verdict ? `Devil's advocate verdict: ${fmt.label(da.verdict)}` : "")}</span>
          </div>
          <div className="tiny muted" style={{ marginTop: 4 }}>{fmt.qty(t.proposedQuantity)} shares · {fmt.money(t.proposedNotional)} · {fmt.label(t.executionMethod.orderType)}{t.executionMethod.limitLogic ? ` · ${t.executionMethod.limitLogic}` : ""} · urgency {t.executionMethod.urgency}</div>
        </Sec>
      </div>
    </div>
  );
}
