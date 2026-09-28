import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { errorMessage, isApiError } from "../api/client";

export function EmptyState({ title = "No data yet", detail, action }: { title?: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <div className="title">{title}</div>
      {detail && <div>{detail}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const status = isApiError(error) ? error.status : null;
  const heading = title ?? (status === 403 ? "Not permitted" : status === 503 ? "Dependency unavailable" : status === 0 ? "API unreachable" : "Request failed");
  return (
    <div className="state error" role="alert">
      <div className="title">{heading}</div>
      <div>{errorMessage(error)}{status ? <span className="muted"> · HTTP {status}</span> : null}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" aria-busy="true">
      <div className="loading-bar" style={{ maxWidth: 240, margin: "0 auto 8px" }} />
      <span className="muted">{label}<span className="progress-dots" /></span>
    </div>
  );
}

/**
 * Wraps a react-query result: loading → error → empty → children(data).
 * Holds the previous render at reduced opacity while refetching (no skeleton flash).
 */
export function QueryState<T>({ query, children, isEmpty, empty, loadingLabel }: {
  query: UseQueryResult<T, Error>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  loadingLabel?: string;
}) {
  if (query.isPending) return <Loading label={loadingLabel} />;
  if (query.isError && query.data === undefined) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState />}</>;
  return (
    <>
      {query.isError && (
        <div className="banner warn small" role="alert" style={{ marginBottom: 8 }}>
          <span className="grow">Showing last good data from {new Date(query.dataUpdatedAt).toLocaleTimeString()} — refresh failed: {errorMessage(query.error)}</span>
          <button className="btn sm" onClick={() => query.refetch()}>Retry</button>
        </div>
      )}
      <div className={query.isFetching && query.isPlaceholderData ? "stale" : undefined}>{children(data)}</div>
    </>
  );
}
