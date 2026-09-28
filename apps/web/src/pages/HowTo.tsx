import { useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage, post, put } from "../api/client";
import { useApi, useInvalidate } from "../api/hooks";
import { STRATEGY_STAGE_ORDER, type AccountStrategiesResponse, type BrokerStatus, type OverviewResponse, type StrategyStage } from "../api/types";
import { useAccount, useScoped } from "../app/AccountContext";
import { useSession } from "../auth/SessionProvider";
import { useStepUp } from "../auth/StepUpProvider";
import { Badge } from "../components/Badge";
import { PageHeader } from "../components/Controls";
import { Panel } from "../components/Panel";
import { fmt } from "../lib/fmt";

const stageIdx = (s: StrategyStage): number => STRATEGY_STAGE_ORDER.indexOf(s);
const SHADOW_IDX = STRATEGY_STAGE_ORDER.indexOf("live_shadow");

/**
 * Plain-language guide plus a live checklist. The one-click action below only ever puts the
 * account into SHADOW: simulated fills, no real orders. Going live is a deliberate, separate step.
 */
export function HowToPage() {
  const { account, base, isOwner } = useAccount();
  const { session } = useSession();
  const scoped = useScoped();
  const invalidate = useInvalidate();
  const { ensureFresh } = useStepUp();
  const broker = useApi<BrokerStatus>(scoped("broker/status"), { refetchInterval: 30_000 });
  const strategies = useApi<AccountStrategiesResponse>(scoped("strategies"));
  const overview = useApi<OverviewResponse>(scoped("overview"), { refetchInterval: 30_000 });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const mfa = session?.user.mfaEnabled ?? false;
  const simulated = account.kind === "simulated";
  const connected = simulated || (broker.data?.status ?? account.status) === "connected";
  const autonomy = account.autonomyLevel;
  const shadowOrBetter = autonomy !== "research_only";
  const rows = strategies.data?.strategies ?? [];
  const eligible = rows.filter((s) => !s.globallyDisabled && stageIdx(s.globalStage) >= SHADOW_IDX);
  const active = rows.filter((s) => s.settings.enabled && stageIdx(s.settings.stage) >= SHADOW_IDX);
  const sv = overview.data?.survival ?? null;

  const startShadow = async () => {
    setBusy(true); setResult(null);
    try {
      const ok = await ensureFresh("Enabling shadow trading requires confirmation.");
      if (!ok) throw new Error("Confirmation cancelled.");
      const notes: string[] = [];
      if (autonomy === "research_only") { await post(scoped("autonomy"), { level: "shadow" }); notes.push("autonomy set to Shadow"); }
      let enabled = 0;
      for (const s of eligible) {
        const stage: StrategyStage = stageIdx(s.settings.stage) >= SHADOW_IDX ? s.settings.stage : "live_shadow";
        if (s.settings.enabled && s.settings.stage === stage) continue;
        await put(scoped(`strategies/${s.id}/settings`), { enabled: true, stage });
        enabled += 1;
      }
      notes.push(`${enabled} strateg${enabled === 1 ? "y" : "ies"} enabled in shadow (${eligible.length} eligible)`);
      await invalidate("/accounts");
      setResult(`Done: ${notes.join("; ")}. Candidates appear on Opportunities within a few minutes of market data arriving; simulated fills land in the Trade Journal.`);
    } catch (err) {
      setResult(`Not completed: ${errorMessage(err)}`);
    } finally { setBusy(false); }
  };

  const Step = ({ n, done, title, children }: { n: number; done: boolean | null; title: string; children: React.ReactNode }) => (
    <div className="howto-step">
      <div className={`howto-num ${done === true ? "done" : done === false ? "todo" : ""}`}>{done === true ? "✓" : n}</div>
      <div className="grow">
        <div className="howto-title">{title} {done === true && <Badge tone="pos">done</Badge>}{done === false && <Badge tone="warn">to do</Badge>}</div>
        <div className="small dim">{children}</div>
      </div>
    </div>
  );

  return (
    <>
      <PageHeader title="How to use" sub="From zero to a verified, profitable record in five steps. Nothing here is faked: no data, no fills, no AI output." />
      <div className="stack">
        <Panel title="Your checklist" actions={sv && <Badge tone={sv.mode === "thriving" || sv.mode === "earning" ? "pos" : sv.mode === "probation" ? "accent" : sv.mode === "survival" ? "warn" : "neg"}>mandate: {sv.mode}</Badge>}>
          <div className="stack" style={{ gap: 14 }}>
            <Step n={1} done={mfa} title="Protect the account with MFA">
              Settings → Security → Enrol authenticator. Save the recovery codes. Every sensitive action (connecting the broker, changing autonomy) asks for it again.
              {!mfa && <> <Link to={`${base}/settings`}>Open Settings</Link></>}
            </Step>
            <Step n={2} done={connected} title={simulated ? "Simulated account: no broker needed" : "Connect your Robinhood account"}>
              {simulated ? "This account simulates fills against real quotes; it never touches a broker." : <>
                Settings → Robinhood connection → <strong>Connect Robinhood</strong>. Robinhood opens in a new tab; approve the Agentic Trading request. Robinhood then sends that tab to an address starting with <code className="mono">http://127.0.0.1:</code> which cannot load (Robinhood only allows local addresses): copy the whole address from the address bar, paste it into the <strong>Finish the connection</strong> box in Settings and press Finish connection.
                Market data (quotes, bars, earnings) flows through that connection, so nothing can be analysed before it is made. Then press <strong>Sync now</strong>.
                {!connected && <> <Link to={`${base}/settings`}>Open Settings</Link></>}
              </>}
            </Step>
            <Step n={3} done={shadowOrBetter} title="Turn on shadow trading (simulated, zero risk)">
              Autonomy <strong>Shadow</strong> runs the whole machine, including the risk engine and the AI committee, but fills every order in a simulated book at real quotes. No real order is ever sent. Current level: <Badge tone="outline">{fmt.label(autonomy)}</Badge>.
            </Step>
            <Step n={4} done={rows.length === 0 ? null : active.length > 0} title="Enable strategies in shadow">
              Strategies → expand a row → Enabled on, stage <strong>Live shadow</strong>. {rows.length > 0 && <>{active.length} of {eligible.length} eligible strategies are active now.</>} Each strategy has its own scorecard, fitness verdict and intelligence profile.
            </Step>
            <Step n={5} done={null} title="Let it prove itself, then read the verdict">
              Give it a few weeks of sessions. <Link to={`${base}/opportunities`}>Opportunities</Link> shows what it considers and why it rejects; <Link to={`${base}/journal`}>Trade Journal</Link> shows every simulated fill with its thesis and post-trade review; <Link to={`${base}/analytics`}>Analytics</Link> shows the equity curve, drawdown and expectancy; <Link to={`${base}/overview`}>Overview</Link> shows the <strong>survival mandate</strong>: the account earns full live risk only after 15 closed trades with positive expectancy after costs.
            </Step>
          </div>
          {isOwner && !simulated && (
            <div className="form-actions" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
              <div className="small dim">One click: set autonomy to Shadow and enable every eligible strategy at the Live shadow stage. Simulated only; no real orders.</div>
              <button className="btn primary" disabled={busy || strategies.isPending} onClick={() => void startShadow()}>{busy ? "Working…" : "Start shadow trading"}</button>
            </div>
          )}
          {result && <div className={`banner ${result.startsWith("Done") ? "ok" : "warn"}`} style={{ marginTop: 10 }}><span className="grow">{result}</span></div>}
        </Panel>

        <div className="grid auto">
          <Panel title="How a trade happens">
            <ol className="bullets small" style={{ paddingLeft: 20 }}>
              <li><strong>Data first.</strong> Quotes and bars are pulled from Robinhood and stamped with age. Stale or missing data blocks new entries; it never blocks exits.</li>
              <li><strong>Candidates.</strong> Strategies scan the universe and propose long ideas with an expected edge, upside, downside and holding period.</li>
              <li><strong>Portfolio fit and sizing.</strong> Concentration, correlation, drawdown and fractional Kelly decide the size for <em>this</em> account.</li>
              <li><strong>Thesis and committee.</strong> A deterministic thesis is written; when the AI key is set, the investment committee (regime, quant, structure, fundamentals, news, devil's advocate, portfolio manager) votes. It advises; it cannot trade.</li>
              <li><strong>Net expected value.</strong> The trade must pay for its own spread, slippage and fees and clear the survival hurdle, or it is rejected.</li>
              <li><strong>Fast brain, then risk veto.</strong> The fast brain picks BUY / WAIT / HOLD…; the risk engine has the last word and can only shrink or reject.</li>
              <li><strong>Execution and review.</strong> Orders go to the simulated book (shadow) or Robinhood (live), are monitored and repriced, and every closed trade is reviewed and turned into lessons.</li>
            </ol>
          </Panel>
          <Panel title="Reading the survival mandate">
            <dl className="kv wide small">
              <dt><Badge tone="pos">thriving</Badge></dt><dd>Compounding on every window. Full risk budget.</dd>
              <dt><Badge tone="pos">earning</Badge></dt><dd>Positive realised expectancy and profit factor. Full risk budget.</dd>
              <dt><Badge tone="accent">probation</Badge></dt><dd>Not proven yet (a new account starts here). Live size 75%, hurdle x1.25, half the slots.</dd>
              <dt><Badge tone="warn">survival</Badge></dt><dd>Losing. Live size 40%, hurdle x1.75, two new positions per cycle.</dd>
              <dt><Badge tone="neg">hibernation</Badge></dt><dd>Dead until proven: no live entries, shadow only, until 20 shadow trades show an edge.</dd>
            </dl>
            <p className="small dim">Strategies are judged the same way on your own record: scale, keep, probation, cull (demoted to shadow) or revive (proposed to you). Capital drifts toward what earns, at most five points a day.</p>
          </Panel>
          <Panel title="Going live, when the record earns it">
            <ol className="bullets small" style={{ paddingLeft: 20 }}>
              <li>Read the survival mandate on Overview: wait for <strong>earning</strong> with a positive alpha versus SPY.</li>
              <li>Settings → Risk: confirm the daily/weekly loss limits, max drawdown, position caps and the symbol allow/block lists. These are absolute; the AI cannot loosen them.</li>
              <li>Settings → Autonomy → <strong>Manual approval</strong>: each approved trade waits for your click. Then <strong>Semi-autonomous</strong> (small trades run alone, large ones ask), then <strong>Fully autonomous</strong>.</li>
              <li>The kill switch (Risk page) halts everything instantly and only allows risk-reducing exits. It also fires by itself on loss limits, stale data, broker trouble or reconciliation mismatches.</li>
              <li>Keep MFA on. Sessions expire after 30 minutes idle and 12 hours in total.</li>
            </ol>
          </Panel>
          <Panel title="Where to look each day">
            <ul className="bullets small">
              <li><strong>Overview</strong>: P&amp;L, drawdown, regime, survival mandate, highest-conviction ideas, alerts.</li>
              <li><strong>Opportunities</strong>: everything evaluated today, with every reason for a rejection.</li>
              <li><strong>Positions</strong>: open trades with thesis, invalidation and target; close manually at any time.</li>
              <li><strong>Trade Journal</strong>: the full record of decisions, fills, reviews and lessons.</li>
              <li><strong>Learning</strong>: what the system changed about itself, always within bounds, and why.</li>
              <li><strong>System Health</strong>: data freshness, broker health, model status, job runs. If something is red, entries are already blocked.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
