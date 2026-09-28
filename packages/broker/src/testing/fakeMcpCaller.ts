/**
 * Scripted in-process `McpCaller` for tests (and for the API's own tests). Handlers return the
 * `data` payload shaped like docs/robinhood/official-mcp-tools.observed.json output schemas; the
 * fake wraps it in the official `{data, guide}` envelope as structuredContent (or as JSON text).
 */
import type { McpCaller, McpToolDefinition, McpToolResult } from "../robinhood/mcpClient.js";

export type FakeHandler = (args: Record<string, unknown>, call: number) => unknown | Promise<unknown>;

export interface FakeCall {
  name: string;
  args: Record<string, unknown>;
}

export class FakeMcpCaller implements McpCaller {
  readonly calls: FakeCall[] = [];
  closed = 0;
  listToolsCalls = 0;
  /** Deliver results as JSON text content instead of structuredContent. */
  textMode = false;
  private readonly handlers = new Map<string, FakeHandler>();
  private readonly queuedErrors = new Map<string, unknown[]>();
  private readonly queuedToolErrors = new Map<string, string[]>();

  constructor(public tools: McpToolDefinition[]) {}

  on(name: string, handler: FakeHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  /** Next call to `name` throws `error` (transport-level). */
  failNext(name: string, error: unknown): this {
    this.queuedErrors.set(name, [...(this.queuedErrors.get(name) ?? []), error]);
    return this;
  }

  /** Next call to `name` answers with isError=true and this text. */
  toolErrorNext(name: string, text: string): this {
    this.queuedToolErrors.set(name, [...(this.queuedToolErrors.get(name) ?? []), text]);
    return this;
  }

  countOf(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.listToolsCalls += 1;
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.calls.push({ name, args });
    const errs = this.queuedErrors.get(name);
    if (errs && errs.length > 0) throw errs.shift();
    const toolErrs = this.queuedToolErrors.get(name);
    if (toolErrs && toolErrs.length > 0) return { content: [{ type: "text", text: toolErrs.shift() as string }], isError: true };
    const handler = this.handlers.get(name);
    if (!handler) return { content: [{ type: "text", text: `fake: no handler for ${name}` }], isError: true };
    const data = await handler(args, this.countOf(name));
    const envelope = { data, guide: `guide for ${name}` };
    if (this.textMode) return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}
