import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FallbackStructuredClient, OpenRouterStructuredClient, SwitchableModelClient, type OpenRouterTransport } from "./openRouterClient.js";
import { NotConfiguredClient } from "./notConfiguredClient.js";
import { createModelClient } from "./index.js";
import type { StructuredModelClient, StructuredRequest, StructuredResult } from "./contract.js";

const schema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });
const req: StructuredRequest<z.infer<typeof schema>> = { agent: "quant", promptVersion: "v1", role: "slow_brain", system: "sys", user: "u", schema };

function reply(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { status: 200, json: { model: "qwen/qwen3.8-27b:free", choices: [{ finish_reason: "tool_calls", message }], usage: { prompt_tokens: 100, completion_tokens: 20 }, ...extra } };
}
const call = (args: unknown) => ({ tool_calls: [{ function: { name: "emit_result", arguments: JSON.stringify(args) } }] });

describe("OpenRouterStructuredClient", () => {
  it("forces the single function, validates its arguments and prices a free model at zero", async () => {
    let sent: Record<string, unknown> = {};
    const transport: OpenRouterTransport = async (body) => { sent = body; return reply(call({ answer: "a", score: 0.4 })); };
    const r = await new OpenRouterStructuredClient({ apiKey: "k", transport }).complete(req);
    expect(r).toMatchObject({ ok: true, output: { answer: "a", score: 0.4 }, modelName: "qwen/qwen3.8-27b:free", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 } });
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "emit_result" } });
    expect(sent.provider).toEqual({ require_parameters: true });
  });

  it("accepts a JSON object in the message text but never trusts it unvalidated", async () => {
    const ok = await new OpenRouterStructuredClient({ apiKey: "k", transport: async () => reply({ content: "```json\n{\"answer\":\"b\",\"score\":1}\n```" }) }).complete(req);
    expect(ok).toMatchObject({ ok: true, output: { answer: "b", score: 1 } });
    const bad = await new OpenRouterStructuredClient({ apiKey: "k", transport: async () => reply(call({ answer: "b", score: 7 })) }).complete(req);
    expect(bad).toMatchObject({ ok: false, error: "validation_failed" });
    const prose = await new OpenRouterStructuredClient({ apiKey: "k", transport: async () => reply({ content: "I think it's bullish" }) }).complete(req);
    expect(prose).toMatchObject({ ok: false, error: "validation_failed" });
  });

  it("classifies rate limits, provider errors, truncation and paid-model cost", async () => {
    const limited = await new OpenRouterStructuredClient({ apiKey: "k", transport: async () => ({ status: 429, json: { error: { code: 429, message: "free-models-per-day" } } }) }).complete(req);
    expect(limited).toMatchObject({ ok: false, error: "rate_limited" });
    const down = await new OpenRouterStructuredClient({ apiKey: "k", transport: async () => ({ status: 502, json: { error: { message: "upstream" } } }) }).complete(req);
    expect(down).toMatchObject({ ok: false, error: "provider_error" });
    const cut = await new OpenRouterStructuredClient({ apiKey: "k", transport: async () => ({ status: 200, json: { choices: [{ finish_reason: "length", message: { content: "{" } }] } }) }).complete(req);
    expect(cut).toMatchObject({ ok: false, error: "validation_failed" });
    const paid = await new OpenRouterStructuredClient({ apiKey: "k", model: "vendor/paid", transport: async () => reply(call({ answer: "a", score: 0 }), { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0021 } }) }).complete(req);
    expect(paid).toMatchObject({ ok: true, usage: { costUsd: 0.0021 } });
  });
});

function stub(name: string, results: Array<StructuredResult<unknown>>): StructuredModelClient & { calls: number } {
  const s = {
    configured: true,
    calls: 0,
    modelFor: () => name,
    complete: async <T>() => { s.calls += 1; return results[Math.min(s.calls - 1, results.length - 1)] as StructuredResult<T>; },
  };
  return s;
}
const okResult = (model: string): StructuredResult<unknown> => ({ ok: true, output: {}, modelName: model, modelVersion: model, usage: null as never, raw: null });
const failResult = (error: "rate_limited" | "validation_failed"): StructuredResult<unknown> => ({ ok: false, error, message: error, modelName: "free", usage: null });

describe("FallbackStructuredClient", () => {
  it("uses the free model first and the paid model only when the free one fails", async () => {
    const free = stub("free", [okResult("free"), failResult("validation_failed"), okResult("free")]);
    const paid = stub("paid", [okResult("paid")]);
    const c = new FallbackStructuredClient(free, paid);
    expect(c.modelFor("fast")).toBe("free");
    expect((await c.complete(req)).ok && paid.calls).toBe(0);
    expect(await c.complete(req)).toMatchObject({ ok: true, modelName: "paid" });
    expect(await c.complete(req)).toMatchObject({ ok: true, modelName: "free" });
  });

  it("rests the free model after a rate limit, then tries it again", async () => {
    let now = 0;
    const free = stub("free", [failResult("rate_limited"), okResult("free")]);
    const paid = stub("paid", [okResult("paid")]);
    const c = new FallbackStructuredClient(free, paid, { cooldownMs: 1000, now: () => now });
    expect(await c.complete(req)).toMatchObject({ modelName: "paid" });
    expect(await c.complete(req)).toMatchObject({ modelName: "paid" });
    expect(free.calls).toBe(1);
    now = 1001;
    expect(await c.complete(req)).toMatchObject({ modelName: "free" });
  });

  it("fails closed when the free model fails and no paid model is configured", async () => {
    const c = new FallbackStructuredClient(stub("free", [failResult("validation_failed")]), new NotConfiguredClient());
    expect(await c.complete(req)).toMatchObject({ ok: false, error: "validation_failed" });
  });
});

describe("createModelClient with OpenRouter", () => {
  it("puts OpenRouter in front of Anthropic only when its key is set, and can be switched at runtime", () => {
    expect(createModelClient({ ANTHROPIC_API_KEY: "a" }).modelFor("slow_brain")).toBe("claude-haiku-4-5-20251001");
    const both = createModelClient({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" });
    expect(both).toBeInstanceOf(FallbackStructuredClient);
    expect(both.modelFor("slow_brain")).toBe("qwen/qwen3.8-27b:free");
    const sw = new SwitchableModelClient(new NotConfiguredClient());
    expect(sw.configured).toBe(false);
    sw.set(both);
    expect(sw.configured).toBe(true);
    expect(sw.modelFor("fast")).toBe("qwen/qwen3.8-27b:free");
  });
});
