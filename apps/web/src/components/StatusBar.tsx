import { Link } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { HealthComponent, HealthResponse, OverviewResponse } from "../api/types";
import { fmt } from "../lib/fmt";
import { freshnessTone, healthTone } from "./StatusPill";

function Item({ k, tone, children, title }: { k: string; tone: string; children: React.ReactNode; title?: string }) {
  return <span className="status-item" title={title}><span className={`status-dot ${tone}`} aria-hidden /><span className="k">{k}</span><span className="v">{children}</span></span>;
}

/**
 * Slim bottom bar: data freshness from /overview, model/learning/scheduler status from /system/health.
 * Every unknown stays "unknown"; a missing model configuration reads "AI models: not configured".
 */
export function StatusBar({ overview, base, refreshedAt }: { overview: OverviewResponse | undefined; base: string; refreshedAt: number | undefined }) {
  const health = useApi<HealthResponse>("/system/health", { refetchInterval: 60_000, staleTime: 30_000 });
  const comp = (name: string): HealthComponent | undefined => health.data?.components.find((c) => c.name === name);
  const models = comp("model_apis");
  const learning = comp("learning");
  const scheduler = comp("scheduler");
  const dq = overview?.dataQuality;
  const modelsText = !health.data ? (health.isPending ? "checking…" : "unknown") : models ? (models.metrics?.configured === 1 ? "configured" : "not configured") : "not reported";
  return (
    <footer className="statusbar" aria-label="System status">
      <Item k="Quotes" tone={freshnessTone(dq?.quotes)}>{dq ? fmt.label(dq.quotes) : "unknown"}</Item>
      <Item k="Bars" tone={freshnessTone(dq?.bars)}>{dq ? fmt.label(dq.bars) : "unknown"}</Item>
      <Item k="Regime" tone={freshnessTone(dq?.regime)}>{dq ? fmt.label(dq.regime) : "unknown"}</Item>
      <span className="topbar-sep" style={{ height: 14 }} />
      <Item k="AI models" tone={models?.status === "healthy" ? "ok" : models ? "neutral" : "neutral"} title={models?.detail}>{modelsText}</Item>
      <Item k="Learning" tone={healthTone(learning?.status)} title={learning?.detail}>{learning ? fmt.label(learning.status) : "unknown"}</Item>
      <Item k="Scheduler" tone={healthTone(scheduler?.status)} title={scheduler?.detail}>{scheduler ? (scheduler.status === "healthy" && typeof scheduler.metrics?.tracked === "number" ? `${scheduler.metrics.tracked} runs tracked` : fmt.label(scheduler.status)) : "unknown"}</Item>
      <span className="spacer" />
      {health.data && <Item k="Overall" tone={healthTone(health.data.overall)}><Link to={`${base}/health`}>{fmt.label(health.data.overall)}</Link></Item>}
      <span className="status-item"><span className="k">Refreshed</span><span className="v">{refreshedAt ? fmt.ago(new Date(refreshedAt).toISOString()) : "—"}</span></span>
    </footer>
  );
}
