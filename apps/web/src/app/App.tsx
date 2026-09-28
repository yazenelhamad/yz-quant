import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../api/hooks";
import type { AccountsResponse } from "../api/types";
import { SessionProvider, useSession, useUser } from "../auth/SessionProvider";
import { StepUpProvider } from "../auth/StepUpProvider";
import { ErrorState, Loading } from "../components/States";
import { AccountLayout, lastAccount } from "./AccountContext";
import { LoginPage } from "../pages/Login";
import { NoAccountsPage } from "../pages/NoAccounts";
import { OverviewPage } from "../pages/Overview";
import { OpportunitiesPage } from "../pages/Opportunities";
import { PositionsPage } from "../pages/Positions";
import { PositionDetailPage } from "../pages/PositionDetail";
import { StrategiesPage } from "../pages/Strategies";
import { ResearchPage } from "../pages/Research";
import { BacktestsPage } from "../pages/Backtests";
import { BacktestDetailPage } from "../pages/BacktestDetail";
import { JournalPage } from "../pages/Journal";
import { LearningPage } from "../pages/Learning";
import { RiskPage } from "../pages/Risk";
import { AnalyticsPage } from "../pages/Analytics";
import { SystemHealthPage } from "../pages/SystemHealth";
import { SettingsPage } from "../pages/Settings";
import { ComparisonPage } from "../pages/admin/Comparison";
import { GlobalRiskPage } from "../pages/admin/GlobalRisk";
import { UsersPage } from "../pages/admin/Users";
import { ModelsAgentsPage } from "../pages/admin/ModelsAgents";
import { AuditPage } from "../pages/admin/Audit";
import { JobsPage } from "../pages/admin/Jobs";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, retry: false },
    mutations: { retry: false },
  },
});

function RequireAuth() {
  const { query } = useSession();
  const location = useLocation();
  if (query.isPending) return <Loading label="Checking session" />;
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 401) {
      return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    }
    return <div className="main"><ErrorState error={query.error} onRetry={() => query.refetch()} title="Cannot reach the API" /></div>;
  }
  return <StepUpProvider><Outlet /></StepUpProvider>;
}

function RequireAdmin() {
  const user = useUser();
  if (user.role !== "admin") return <ErrorState error={new Error("Admin pages are only available to the admin role.")} title="Not permitted" />;
  return <Outlet />;
}

/** `/` and `/settings` (OAuth return) → the last-used or first account. */
function RootRedirect({ suffix = "overview" }: { suffix?: string }) {
  const q = useApi<AccountsResponse>("/accounts");
  const location = useLocation();
  if (q.isPending) return <Loading label="Loading accounts" />;
  if (q.isError) return <div className="main"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const all = [...(q.data?.accounts ?? []), ...(q.data?.allAccounts ?? [])];
  const remembered = lastAccount();
  const target = all.find((a) => a.id === remembered) ?? q.data?.accounts[0] ?? all[0];
  if (!target) return <Navigate to="/no-accounts" replace />;
  return <Navigate to={`/a/${target.id}/${suffix}${location.search}`} replace />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route index element={<RootRedirect />} />
              <Route path="/settings" element={<RootRedirect suffix="settings" />} />
              <Route path="/no-accounts" element={<NoAccountsPage />} />
              <Route path="/a/:accountId" element={<AccountLayout />}>
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="overview" element={<OverviewPage />} />
                <Route path="opportunities" element={<OpportunitiesPage />} />
                <Route path="positions" element={<PositionsPage />} />
                <Route path="positions/:symbol" element={<PositionDetailPage />} />
                <Route path="strategies" element={<StrategiesPage />} />
                <Route path="strategies/:strategyId" element={<StrategiesPage />} />
                <Route path="research" element={<ResearchPage />} />
                <Route path="backtests" element={<BacktestsPage />} />
                <Route path="backtests/:backtestId" element={<BacktestDetailPage />} />
                <Route path="journal" element={<JournalPage />} />
                <Route path="learning" element={<LearningPage />} />
                <Route path="risk" element={<RiskPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="health" element={<SystemHealthPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="admin" element={<RequireAdmin />}>
                  <Route index element={<Navigate to="comparison" replace />} />
                  <Route path="comparison" element={<ComparisonPage />} />
                  <Route path="global-risk" element={<GlobalRiskPage />} />
                  <Route path="users" element={<UsersPage />} />
                  <Route path="models" element={<ModelsAgentsPage />} />
                  <Route path="audit" element={<AuditPage />} />
                  <Route path="jobs" element={<JobsPage />} />
                </Route>
                <Route path="*" element={<ErrorState error={new Error("This page does not exist.")} title="Not found" />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
