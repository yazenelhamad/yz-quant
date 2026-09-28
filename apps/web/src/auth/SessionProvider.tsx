import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { apiHandlers, get, isApiError, post } from "../api/client";
import type { SessionInfo } from "../api/types";

interface SessionCtx {
  query: UseQueryResult<SessionInfo, Error>;
  session: SessionInfo | null;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const Ctx = createContext<SessionCtx | null>(null);

export const SESSION_KEY = ["api", "/auth/session"] as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery<SessionInfo, Error>({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => get<SessionInfo>("/auth/session", { signal }),
    retry: (count, err) => !(isApiError(err) && err.status < 500) && count < 1,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  // The fetch wrapper reads the CSRF token through a ref so it never closes over stale data.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = query.data?.csrfToken ?? null;
  useEffect(() => {
    apiHandlers.getCsrfToken = () => tokenRef.current;
  }, []);

  const logout = useCallback(async () => {
    try { await post("/auth/logout"); } catch { /* session may already be gone */ }
    qc.clear();
    window.location.assign("/login");
  }, [qc]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: SESSION_KEY }), [qc]);

  return <Ctx.Provider value={{ query, session: query.data ?? null, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

/** Convenience: the authenticated user (throws when used outside an authenticated route). */
export function useUser() {
  const { session } = useSession();
  if (!session) throw new Error("useUser without a session");
  return session.user;
}
