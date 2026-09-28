/**
 * Robinhood's consent page only completes the OAuth flow for loopback redirect URIs (the ones
 * native apps such as Claude Code register). A hosted callback lands on robinhood.com/oauth/error.
 * So the platform registers a loopback redirect, lets the browser "fail" to reach 127.0.0.1 with
 * the code in the address bar, and the user pastes that address back. This parses the paste.
 */
export interface PastedRedirect {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

/** Accepts a full URL, a bare query string ("code=…&state=…"), or a bare authorization code. */
export function parsePastedRedirect(input: string): PastedRedirect {
  const raw = input.trim();
  const out: PastedRedirect = { code: null, state: null, error: null, errorDescription: null };
  if (!raw) return out;
  let params: URLSearchParams | null = null;
  try {
    const u = new URL(raw);
    params = u.searchParams;
    if (![...params.keys()].length && u.hash.includes("=")) params = new URLSearchParams(u.hash.replace(/^#/, ""));
  } catch {
    const q = raw.replace(/^[?#]/, "");
    if (q.includes("=")) params = new URLSearchParams(q);
    else if (/^[A-Za-z0-9._~-]{8,512}$/.test(q)) out.code = q;
  }
  if (params) {
    out.code = params.get("code");
    out.state = params.get("state");
    out.error = params.get("error");
    out.errorDescription = params.get("error_description");
  }
  return out;
}
