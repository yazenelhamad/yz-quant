import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicStructuredClient, supportsForcedToolChoice, type MessageTransport } from "./anthropicClient.js";
import { createModelClient } from "./index.js";
import { NotConfiguredClient } from "./notConfiguredClient.js";
import { estimateCostUsd } from "./pricing.js";

const Schema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });

function message(overrides: Partial<Anthropic.Message> & { input?: unknown; toolName?: string }): Anthropic.Message {
  const { input, toolName, ...rest } = overrides;
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: input === undefined ? [] : [{ type: "tool_use", id: "tu_1", name: toolName ?? "emit_result", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } as Anthropic.Usage,
    ...rest,
  } as Anthropic.Message;
}

function apiError(status: number, msg = "err"): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(status, { error: { type: "x", message: msg } }, msg, new Headers());
}

const request = { agent: "test", promptVersion: "test.v1", role: "fast" as const, system: "sys", user: "hello", schema: Schema };

describe("createModelClient / NotConfiguredClient", () => {
  it("returns a not-configured client without an API key and every call fails closed", async () => {
    const client = createModelClient({});
    expect(client).toBeInstanceOf(NotConfiguredClient);
    expect(client.configured).toBe(false);
    expect(client.modelFor("slow_brain")).toBeNull();
    const result = await client.complete(request);
    expect(result).toMatchObject({ ok: false, error: "not_configured", modelName: null, usage: null });
    expect(result.ok === false && result.message).toContain("AI models: not configured");
  });

  it("returns the real client with env-mapped models when a key exists", () => {
    const client = createModelClient({ ANTHROPIC_API_KEY: "sk-test", MODEL_FAST: "claude-haiku-4-5" });
    expect(client.configured).toBe(true);
    expect(client.modelFor("fast")).toBe("claude-haiku-4-5");
    expect(client.modelFor("slow_brain")).toBe("claude-fable-5-1");
    expect(client.modelFor("research")).toBe("claude-opus-5-5");
  });
});

describe("AnthropicStructuredClient", () => {
  it("sends a forced single tool derived from the zod schema and validates the output", async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const transport: MessageTransport = async (params) => {
      calls.push(params);
      return message({ input: { answer: "yes", score: 0.5 } });
    };
    const client = new AnthropicStructuredClient({ apiKey: "k", transport });
    const result = await client.complete(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({ answer: "yes", score: 0.5 });
    expect(result.modelName).toBe("claude-haiku-4-5-20251001");
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.costUsd).toBe(estimateCostUsd("claude-haiku-4-5-20251001", { inputTokens: 1000, outputTokens: 100 }));
    const params = calls[0]!;
    expect(params.tool_choice).toEqual({ type: "tool", name: "emit_result", disable_parallel_tool_use: true });
    expect(params.tools).toHaveLength(1);
    expect(params.tools![0]).toMatchObject({ name: "emit_result", strict: true, input_schema: { type: "object", required: ["answer", "score"] } });
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).toContain("sys");
  });

  it("uses auto tool choice for models that reject forced tool use", async () => {
    let seen: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const client = new AnthropicStructuredClient({
      apiKey: "k",
      models: { slow_brain: "claude-fable-5-1" },
      transport: async (params) => {
        seen = params;
        return message({ model: "claude-fable-5-1", input: { answer: "a", score: 1 } });
      },
    });
    expect(supportsForcedToolChoice("claude-fable-5-1")).toBe(false);
    expect(supportsForcedToolChoice("claude-haiku-4-5-20251001")).toBe(true);
    const result = await client.complete({ ...request, role: "slow_brain", temperature: 0.2 });
    expect(result.ok).toBe(true);
    expect(seen!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(seen!.temperature).toBeUndefined();
    expect((seen!.system as Array<{ text: string }>)[0]!.text).toContain('"emit_result"');
  });

  it("returns validation_failed and never a partial output when the schema is violated", async () => {
    const client = new AnthropicStructuredClient({ apiKey: "k", transport: async () => message({ input: { answer: "yes", score: 7 } }) });
    const result = await client.complete(request);
    expect(result).toMatchObject({ ok: false, error: "validation_failed" });
    expect("output" in result).toBe(false);
  });

  it("returns validation_failed when no tool call is present or output was truncated", async () => {
    const none = new AnthropicStructuredClient({ apiKey: "k", transport: async () => message({ content: [{ type: "text", text: "prose", citations: null }] }) });
    expect(await none.complete(request)).toMatchObject({ ok: false, error: "validation_failed" });
    const truncated = new AnthropicStructuredClient({ apiKey: "k", transport: async () => message({ input: { answer: "a", score: 0.1 }, stop_reason: "max_tokens" }) });
    expect(await truncated.complete(request)).toMatchObject({ ok: false, error: "validation_failed" });
  });

  it("maps refusal, rate limit, timeout and server errors to result kinds", async () => {
    const refused = new AnthropicStructuredClient({ apiKey: "k", transport: async () => message({ stop_reason: "refusal", input: undefined }) });
    expect(await refused.complete(request)).toMatchObject({ ok: false, error: "refused" });

    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const limited = new AnthropicStructuredClient({ apiKey: "k", sleep, backoffBaseMs: 10, transport: async () => { throw apiError(429, "slow down"); } });
    expect(await limited.complete(request)).toMatchObject({ ok: false, error: "rate_limited" });
    expect(sleeps).toEqual([10, 20]); // max 2 retries with backoff

    const timeout = new AnthropicStructuredClient({ apiKey: "k", sleep, transport: async () => { throw new Anthropic.APIConnectionTimeoutError({ message: "Request timed out." }); } });
    expect(await timeout.complete(request)).toMatchObject({ ok: false, error: "timeout" });

    const server = new AnthropicStructuredClient({ apiKey: "k", sleep, backoffBaseMs: 1, transport: async () => { throw apiError(500, "boom"); } });
    expect(await server.complete(request)).toMatchObject({ ok: false, error: "provider_error" });

    const bad = new AnthropicStructuredClient({ apiKey: "k", sleep, transport: async () => { throw apiError(400, "bad"); } });
    const badResult = await bad.complete(request);
    expect(badResult).toMatchObject({ ok: false, error: "provider_error" });
    expect(sleeps).toHaveLength(4); // 2 for 429 + 2 for 500; 400 and timeout are not retried
  });

  it("recovers when a retry succeeds", async () => {
    let attempt = 0;
    const client = new AnthropicStructuredClient({
      apiKey: "k",
      sleep: async () => {},
      transport: async () => {
        attempt += 1;
        if (attempt === 1) throw apiError(529, "overloaded");
        return message({ input: { answer: "ok", score: 0.3 } });
      },
    });
    const result = await client.complete(request);
    expect(result.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it("leaves cost null for unknown models", async () => {
    const client = new AnthropicStructuredClient({ apiKey: "k", models: { fast: "claude-future-9" }, transport: async () => message({ model: "claude-future-9", input: { answer: "a", score: 0 } }) });
    const result = await client.complete(request);
    expect(result.ok && result.usage.costUsd).toBeNull();
    expect(estimateCostUsd("nope", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
