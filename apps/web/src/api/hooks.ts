import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api, get, type HttpMethod, isApiError } from "./client";

/**
 * Generic query hook: the query key IS the path, so invalidation is a prefix match on
 * the URL. Every page reads through this so loading/error handling stays uniform.
 */
export function useApi<T>(
  path: string | null,
  options: Omit<UseQueryOptions<T, Error, T, readonly string[]>, "queryKey" | "queryFn"> = {},
) {
  return useQuery<T, Error, T, readonly string[]>({
    queryKey: ["api", path ?? "__disabled__"] as const,
    queryFn: ({ signal }) => get<T>(path as string, { signal }),
    enabled: path !== null && (options.enabled ?? true),
    placeholderData: (prev) => prev,
    retry: (count, err) => {
      if (isApiError(err) && (err.status < 500 || err.status === 503)) return false;
      return count < 1;
    },
    staleTime: 10_000,
    ...options,
  });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: string[]) => {
    if (prefixes.length === 0) return qc.invalidateQueries({ queryKey: ["api"] });
    return Promise.all(
      prefixes.map((prefix) =>
        qc.invalidateQueries({
          predicate: (q) => {
            const key = q.queryKey as readonly unknown[];
            return key[0] === "api" && typeof key[1] === "string" && key[1].startsWith(prefix);
          },
        }),
      ),
    );
  };
}

export interface ApiMutationArgs<B> { method?: HttpMethod; path: string; body?: B }

/** Mutation hook that takes {method, path, body} so one hook covers a page's writes. */
export function useApiMutation<T, B = unknown>(opts: { invalidate?: string[]; onSuccess?: (data: T) => void } = {}) {
  const invalidate = useInvalidate();
  return useMutation<T, Error, ApiMutationArgs<B>>({
    mutationFn: ({ method = "POST", path, body }) => api<T>(method, path, body),
    onSuccess: async (data) => {
      if (opts.invalidate) await invalidate(...opts.invalidate);
      opts.onSuccess?.(data);
    },
  });
}

export const paths = {
  session: "/auth/session",
  accounts: "/accounts",
  account: (id: string) => `/accounts/${encodeURIComponent(id)}`,
  scoped: (id: string, rest: string) => `/accounts/${encodeURIComponent(id)}/${rest}`,
};
