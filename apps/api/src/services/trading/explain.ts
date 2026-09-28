import type { TradeThesis } from "@yz/core";

export interface ExplainTradeInput {
  id: string;
  symbol: string;
  mode: string;
  state: string;
  entryQuantity: number;
  openQuantity: number;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  realizedPnl: number;
  initialConfidence: number;
  expectedEdge: number;
  expectedDownsidePct: number;
  regimeAtEntry: string;
  openedAt: string | null;
  closedAt: string | null;
  exitReason: string | null;
  maxAdverseExcursionPct: number | null;
  maxFavorableExcursionPct: number | null;
}

export interface ExplainDecisionInput {
  action: string;
  verdict: string;
  reasons: string[];
  approvedQuantity: number;
  requestedQuantity: number;
  decidedAt: string;
  failedClosed?: boolean;
}

const money = (v: number): string => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const pctPts = (v: number, dp = 1): string => `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;

/**
 * Plain-English narrative of a trade for the journal and the trade-detail route. Built only from
 * stored facts (trade row, thesis, risk decisions); never invents numbers.
 */
export function explainTrade(trade: ExplainTradeInput, thesis: TradeThesis | null, decisions: ExplainDecisionInput[]): string {
  const p: string[] = [];
  const modeNote = trade.mode === "shadow" ? " (shadow mode: simulated, no real money)" : "";
  if (thesis) p.push(thesis.plainEnglish.trim());
  else p.push(`${trade.symbol}: no stored thesis is attached to this trade${modeNote}.`);

  const sorted = [...decisions].sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
  const entry = sorted.find((d) => d.action === "enter" || d.action === "add");
  if (entry) {
    const blocking = entry.reasons.filter((r) => !r.startsWith("warning"));
    if (entry.verdict === "approve") p.push(`The risk engine approved the entry of ${entry.approvedQuantity} shares${entry.reasons.some((r) => r.startsWith("requires_approval")) ? " subject to human approval" : ""}.`);
    else if (entry.verdict === "reduce") p.push(`The risk engine cut the entry from ${entry.requestedQuantity} to ${entry.approvedQuantity} shares: ${blocking.join("; ")}.`);
    else p.push(`The risk engine rejected the entry: ${blocking.join("; ") || "no reason recorded"}${entry.failedClosed ? " (failed closed)" : ""}.`);
  }
  const exits = sorted.filter((d) => d.action === "exit" || d.action === "reduce");
  for (const d of exits.slice(-2)) {
    p.push(`A ${d.action} of ${d.approvedQuantity} shares was ${d.verdict === "reject" ? "refused" : "cleared"} by the risk engine on ${d.decidedAt.slice(0, 16).replace("T", " ")} UTC${d.verdict === "reject" ? `: ${d.reasons.filter((r) => !r.startsWith("warning")).join("; ")}` : ""}.`);
  }

  const size = trade.averageEntryPrice !== null ? `${trade.entryQuantity} shares at an average ${money(trade.averageEntryPrice)}` : `${trade.entryQuantity} shares (not yet filled)`;
  switch (trade.state) {
    case "closed": {
      const ret = trade.averageEntryPrice && trade.averageExitPrice ? (trade.averageExitPrice / trade.averageEntryPrice - 1) * 100 : null;
      p.push(`The trade is closed${modeNote}: ${size}, exited at ${trade.averageExitPrice !== null ? money(trade.averageExitPrice) : "n/a"} for a realized P&L of ${money(trade.realizedPnl)}${ret !== null ? ` (${pctPts(ret)})` : ""}. Exit reason: ${trade.exitReason ?? "not recorded"}.`);
      break;
    }
    case "rejected": p.push(`The trade was rejected before any order was filled${modeNote}.`); break;
    case "canceled": p.push(`The trade was canceled before completion${modeNote}.`); break;
    case "waiting_for_entry": p.push(`The trade is waiting for a human approval${modeNote}.`); break;
    case "order_submitted": p.push(`An entry order is working at the broker${modeNote}.`); break;
    default: p.push(`The position is open${modeNote}: ${size}, ${trade.openQuantity} shares still held; state ${trade.state.replace(/_/g, " ")}.`);
  }
  if (trade.maxAdverseExcursionPct !== null || trade.maxFavorableExcursionPct !== null) {
    p.push(`Worst drawdown since entry ${pctPts(trade.maxAdverseExcursionPct ?? 0)}, best run-up ${pctPts(trade.maxFavorableExcursionPct ?? 0)}.`);
  }
  p.push(`Entered in a ${trade.regimeAtEntry.replace(/_/g, " ")} regime with ${(trade.initialConfidence * 100).toFixed(0)}% calibrated confidence and an expected edge of ${trade.expectedEdge >= 0 ? "+" : ""}${trade.expectedEdge.toFixed(2)}; the accepted downside was ${trade.expectedDownsidePct.toFixed(1)}%.`);
  return p.join(" ");
}
