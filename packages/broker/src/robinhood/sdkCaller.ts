/**
 * Production `McpCaller`: @modelcontextprotocol/sdk Client over Streamable HTTP with a fetch
 * that injects `Authorization: Bearer <fresh token>` on every request. The token comes from
 * the scope's `AccessTokenProvider` (refresh with skew, single-flight); it is never logged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "./oauth.js";
import type { McpCaller, McpCallerFactory, McpToolDefinition, McpToolResult } from "./mcpClient.js";
import type { AccessTokenProvider } from "./tokenProvider.js";

export interface SdkCallerOptions {
  mcpUrl: string;
  tokenProvider: AccessTokenProvider;
  fetch?: FetchLike;
  clientName?: string;
  clientVersion?: string;
}

/** Wraps a fetch so that every request carries a fresh bearer token. */
export function authorizedFetch(base: FetchLike, tokenProvider: AccessTokenProvider): FetchLike {
  return async (url, init) => {
    const token = await tokenProvider.getAccessToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return base(url, { ...init, headers });
  };
}

export function createSdkMcpCallerFactory(opts: SdkCallerOptions): McpCallerFactory {
  const baseFetch: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return async () => {
    const client = new Client({ name: opts.clientName ?? "yz-quant", version: opts.clientVersion ?? "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(opts.mcpUrl), { fetch: authorizedFetch(baseFetch, opts.tokenProvider) });
    await client.connect(transport);
    const caller: McpCaller = {
      async callTool(name, args, callOpts) {
        const r = await client.callTool({ name, arguments: args }, undefined, { timeout: callOpts?.timeoutMs ?? 30_000 });
        const out: McpToolResult = { content: Array.isArray(r.content) ? (r.content as unknown[]) : [] };
        if (r.structuredContent !== undefined) out.structuredContent = r.structuredContent;
        if (r.isError) out.isError = true;
        return out;
      },
      async listTools() {
        const r = await client.listTools();
        return r.tools as unknown as McpToolDefinition[];
      },
      async close() {
        await client.close();
      },
    };
    return caller;
  };
}
