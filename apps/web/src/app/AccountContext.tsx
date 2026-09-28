import { createContext, useContext, useEffect, useMemo } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { useApi } from "../api/hooks";
import type { AccountSummary, AccountsResponse } from "../api/types";
import { ErrorState, Loading } from "../components/States";
import { useUser } from "../auth/SessionProvider";
import { AppShell } from "./AppShell";

export interface AccountCtx {
  accountId: string;
  account: AccountSummary;
  /** Accounts owned by the session user. */
  own: AccountSummary[];
  /** Admin only: everyone else's accounts (read-only). */
  others: AccountSummary[];
  isOwner: boolean;
  /** Route prefix, e.g. "/a/acc_123". */
  base: string;
  refetch: () => void;
}

const Ctx = createContext<AccountCtx | null>(null);

export const LAST_ACCOUNT_KEY = "yz.lastAccountId";

export function rememberAccount(id: string) {
  try { localStorage.setItem(LAST_ACCOUNT_KEY, id); } catch { /* ignore */ }
}
export function lastAccount(): string | null {
  try { return localStorage.getItem(LAST_ACCOUNT_KEY); } catch { return null; }
}

/** Route element for `/a/:accountId`: resolves the account and renders the shell. */
export function AccountLayout() {
  const { accountId = "" } = useParams();
  const user = useUser();
  const q = useApi<AccountsResponse>("/accounts", { refetchInterval: 30_000 });

  const own = q.data?.accounts ?? [];
  const others = useMemo(() => (q.data?.allAccounts ?? []).filter((a) => a.owner.id !== user.id), [q.data, user.id]);
  const account = own.find((a) => a.id === accountId) ?? others.find((a) => a.id === accountId) ?? null;

  useEffect(() => { if (account) rememberAccount(account.id); }, [account]);

  if (q.isPending) return <Loading label="Loading accounts" />;
  if (q.isError && !q.data) return <div className="main"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  if (!account) {
    const fallback = own[0] ?? others[0];
    if (fallback) return <Navigate to={`/a/${fallback.id}/overview`} replace />;
    return <Navigate to="/no-accounts" replace />;
  }

  const value: AccountCtx = {
    accountId: account.id,
    account,
    own,
    others,
    isOwner: account.owner.id === user.id,
    base: `/a/${account.id}`,
    refetch: () => { void q.refetch(); },
  };
  return (
    <Ctx.Provider value={value}>
      <AppShell><Outlet /></AppShell>
    </Ctx.Provider>
  );
}

export function useAccount(): AccountCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount outside AccountLayout");
  return v;
}

/** Path helper for account-scoped API calls. */
export function useScoped() {
  const { accountId } = useAccount();
  return (rest: string) => `/accounts/${encodeURIComponent(accountId)}/${rest}`;
}
