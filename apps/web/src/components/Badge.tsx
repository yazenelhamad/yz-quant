import type { AutonomyLevel, CandidateStatus, OutcomeClassification, StrategyStage, TradeLifecycleState } from "../api/types";
import { fmt } from "../lib/fmt";

export type BadgeTone = "default" | "accent" | "pos" | "neg" | "warn" | "outline" | "sim";

export function Badge({ tone = "default", children, title }: { tone?: BadgeTone; children: React.ReactNode; title?: string }) {
  return <span className={`badge ${tone === "default" ? "" : tone}`} title={title}>{children}</span>;
}

export function StageBadge({ stage }: { stage: StrategyStage }) {
  const tone: BadgeTone = stage === "live" ? "pos" : stage === "limited_live" ? "accent" : stage === "paused" || stage === "retired" ? "warn" : "outline";
  return <Badge tone={tone}>{fmt.label(stage)}</Badge>;
}

export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  research_only: "Nothing is traded. The system only researches, backtests and writes theses.",
  shadow: "Every decision is simulated and journaled as if live, but no order is ever sent to the broker.",
  manual_approval: "The system proposes trades; nothing is sent until you approve each one.",
  semi_autonomous: "Existing positions are managed automatically (reduce, exit, cancel, reprice). New entries below the approval notional are sent automatically; larger ones wait for your approval.",
  fully_autonomous: "Entries and exits are sent without approval, still subject to every risk-engine limit and kill switch.",
};

export function AutonomyBadge({ level }: { level: AutonomyLevel }) {
  const tone: BadgeTone = level === "fully_autonomous" ? "pos" : level === "semi_autonomous" ? "accent" : level === "manual_approval" ? "outline" : "default";
  return <Badge tone={tone} title={AUTONOMY_DESCRIPTIONS[level]}>{fmt.label(level)}</Badge>;
}

export function TradeStateBadge({ state }: { state: TradeLifecycleState }) {
  const tone: BadgeTone =
    state === "closed" ? "default" : state === "rejected" || state === "canceled" ? "neg"
      : state === "monitoring" || state === "filled" ? "pos" : state === "order_submitted" || state === "partially_filled" ? "accent" : "outline";
  return <Badge tone={tone}>{fmt.label(state)}</Badge>;
}

export function CandidateStatusBadge({ status }: { status: CandidateStatus | string }) {
  const tone: BadgeTone = status === "approved" ? "pos" : status === "rejected" ? "neg" : status === "expired" ? "default" : status === "analyzing" ? "accent" : "outline";
  return <Badge tone={tone}>{fmt.label(status)}</Badge>;
}

export const CLASSIFICATION_HELP: Record<OutcomeClassification, string> = {
  good_win: "Won for the reason the thesis expected.",
  bad_win: "Made money, but not because the thesis was right.",
  good_loss: "Lost money on a sound decision; the process was right.",
  bad_thesis: "The reasoning was wrong.",
  bad_timing: "Right idea, entered or exited at the wrong time.",
  bad_execution: "Slippage or fills destroyed the edge.",
  oversized: "Position was too large for the risk taken.",
  unexpected_event: "An event outside the thesis dominated the outcome.",
  model_error: "A model produced a faulty output.",
  data_error: "Bad or stale data drove the decision.",
  regime_change: "The market regime shifted against the strategy.",
};

export function ClassificationBadge({ c }: { c: OutcomeClassification | null | undefined }) {
  if (!c) return <Badge tone="outline">Unreviewed</Badge>;
  const tone: BadgeTone = c === "good_win" ? "pos" : c === "good_loss" ? "accent" : c === "bad_win" ? "warn" : "neg";
  return <Badge tone={tone} title={CLASSIFICATION_HELP[c]}>{fmt.label(c)}</Badge>;
}
