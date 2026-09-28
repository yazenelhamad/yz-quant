import type { AutonomyLevel } from "@yz/core";
import type { BrokerAccountRow, UserRow } from "@yz/db";
import type { Repos } from "../http/app.js";
import { maskAccountNumber } from "../security/secrets.js";

export interface AccountSummary {
  id: string;
  kind: string;
  label: string;
  accountNumberMasked: string;
  agenticAllowed: boolean;
  accountType: string;
  optionsEnabledAtBroker: boolean;
  status: string;
  statusDetail: string | null;
  lastHealthyAt: string | null;
  lastReconciledAt: string | null;
  reconciliationOk: boolean;
  autonomyLevel: AutonomyLevel;
  tradingPaused: boolean;
  pausedReason: string | null;
  portfolio: { asOf: string; totalValue: number; cash: number; buyingPower: number; equityValue: number; dailyPnl: number | null; totalPnl: number | null; drawdownPct: number | null; exposurePct: number | null } | null;
  killSwitchActive: boolean;
  simulated: boolean;
  owner: { id: string; displayName: string };
}

export async function buildAccountSummary(repos: Repos, account: BrokerAccountRow, owner: UserRow | undefined): Promise<AccountSummary> {
  const scope = { userId: account.userId, brokerAccountId: account.id };
  const [snap, ks] = await Promise.all([repos.snapshots.latest(scope), repos.killSwitches.get(scope)]);
  return {
    id: account.id,
    kind: account.kind,
    label: account.label,
    accountNumberMasked: maskAccountNumber(account.accountNumber),
    agenticAllowed: account.agenticAllowed,
    accountType: account.accountType,
    optionsEnabledAtBroker: account.optionsEnabledAtBroker,
    status: account.status,
    statusDetail: account.statusDetail,
    lastHealthyAt: account.lastHealthyAt,
    lastReconciledAt: account.lastReconciledAt,
    reconciliationOk: account.reconciliationOk,
    autonomyLevel: account.autonomyLevel as AutonomyLevel,
    tradingPaused: account.tradingPaused,
    pausedReason: account.pausedReason,
    portfolio: snap ? { asOf: snap.asOf, totalValue: snap.totalValue, cash: snap.cash, buyingPower: snap.buyingPower, equityValue: snap.equityValue, dailyPnl: snap.dailyPnl, totalPnl: snap.totalPnl, drawdownPct: snap.drawdownPct, exposurePct: snap.exposurePct } : null,
    killSwitchActive: !!ks?.active,
    simulated: account.kind === "simulated",
    owner: { id: account.userId, displayName: owner?.displayName ?? "unknown" },
  };
}
