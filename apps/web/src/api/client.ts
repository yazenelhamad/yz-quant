import type { ApiErrorEnvelope } from "./types";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
  get isUnauthorized() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isStepUpRequired() { return this.status === 428; }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Process-wide hooks the app shell installs. They let the plain fetch wrapper drive
 * UI concerns (login redirect, step-up dialog) without importing React.
 */
export const apiHandlers: {
  getCsrfToken: () => string | null;
  onUnauthorized: () => void;
  /** Resolve true when the user completed step-up and the request may be retried. */
  onStepUpRequired: (reason: string) => Promise<boolean>;
} = {
  getCsrfToken: () => null,
  onUnauthorized: () => {
    if (window.location.pathname !== "/login") {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?next=${next}`);
    }
  },
  onStepUpRequired: async () => false,
};

const BASE = "/api";

/** Paths for which a 401 is a normal answer rather than "session lost". */
const AUTH_PROBE_PATHS = ["/auth/session", "/auth/login", "/auth/mfa/verify", "/auth/step-up"];

async function parseError(res: Response): Promise<ApiError> {
  let envelope: ApiErrorEnvelope | null = null;
  const text = await res.text().catch(() => "");
  try {
    envelope = text ? (JSON.parse(text) as ApiErrorEnvelope) : null;
  } catch {
    envelope = null;
  }
  const code = envelope?.error?.code ?? `http_${res.status}`;
  const message = envelope?.error?.message ?? (text || res.statusText || `Request failed (${res.status})`);
  return new ApiError(res.status, code, message, envelope?.error?.detail);
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Internal: prevents infinite step-up loops. */
  _stepUpRetried?: boolean;
}

export async function api<T>(method: HttpMethod, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = apiHandlers.getCsrfToken();
    if (token) headers["x-csrf-token"] = token;
  }

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Cannot reach the API server.");
  }

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const error = await parseError(res);

  if (error.status === 401 && !AUTH_PROBE_PATHS.some((p) => path.startsWith(p))) {
    apiHandlers.onUnauthorized();
    throw error;
  }

  if (error.status === 428 && !options._stepUpRetried) {
    const ok = await apiHandlers.onStepUpRequired(error.message);
    if (ok) return api<T>(method, path, body, { ...options, _stepUpRetried: true });
    throw new ApiError(428, "step_up_cancelled", "Confirmation cancelled.");
  }

  throw error;
}

export const get = <T>(path: string, options?: RequestOptions) => api<T>("GET", path, undefined, options);
export const post = <T>(path: string, body?: unknown, options?: RequestOptions) => api<T>("POST", path, body, options);
export const put = <T>(path: string, body?: unknown, options?: RequestOptions) => api<T>("PUT", path, body, options);
export const del = <T>(path: string, options?: RequestOptions) => api<T>("DELETE", path, undefined, options);

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
