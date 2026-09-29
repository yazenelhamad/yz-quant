import type { ModelRole, ModelUsage, StructuredModelClient, StructuredRequest, StructuredResult } from "./contract.js";
import { zodToJsonSchema } from "./jsonSchema.js";
import { DEFAULT_TIMEOUT_MS, DEFAULT_TOOL_NAME } from "./anthropicClient.js";

/**
 * OpenRouter client (OpenAI-compatible Chat Completions). Used to run the committee on a free
 * model: one forced function per request, derived from the agent's zod schema, and the returned
 * arguments are validated with the same zod schema before anything is trusted. It never repairs
 * or invents output; anything malformed is a validation failure.
 */
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.8-27b:free";

export type OpenRouterTransport = (body: Record<string, unknown>, options: { apiKey: string; timeoutMs: number }) => Promise<{ status: number; json: unknown }>;

export interface OpenRouterClientOptions {
  apiKey: string;
  /** One model for every role (free models are not tiered). */
  model?: string;
  timeoutMs?: number;
  transport?: OpenRouterTransport;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

const OUTPUT_INSTRUCTION =
  "OUTPUT CONTRACT: Respond ONLY by calling the provided function exactly once with a JSON object that satisfies its parameters schema. " +
  "Do not write prose outside the function call. If evidence is insufficient, still call the function and express uncertainty through its fields.";

const defaultTransport: OpenRouterTransport = async (body, { apiKey, timeoutMs }) => {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "The Palestinian Quant" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
};

interface ChatResponse {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    error?: { code?: number | string; message?: string };
    message?: { content?: string | null; refusal?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export class OpenRouterStructuredClient implements StructuredModelClient {
  readonly configured = true;
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly transport: OpenRouterTransport;
  private readonly logger: OpenRouterClientOptions["logger"];

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey) throw new Error("OpenRouterStructuredClient requires an apiKey");
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_OPENROUTER_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport ?? defaultTransport;
    this.logger = options.logger;
  }

  modelFor(_role: ModelRole): string {
    return this.model;
  }

  freeOnly(): StructuredModelClient | null {
    return this.model.endsWith(":free") ? this : null;
  }

  async complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.model;
    const toolName = req.toolName ?? DEFAULT_TOOL_NAME;
    let parameters;
    try {
      parameters = zodToJsonSchema(req.schema as unknown as Parameters<typeof zodToJsonSchema>[0]).schema;
    } catch (error) {
      return fail("validation_failed", `Schema for ${req.agent} cannot be converted: ${(error as Error).message}`, model, null);
    }
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 4096,
      messages: [
        { role: "system", content: `${req.system}\n\n${OUTPUT_INSTRUCTION} The function is named "${toolName}".` },
        { role: "user", content: req.user },
      ],
      tools: [{ type: "function", function: { name: toolName, description: `Structured output for agent "${req.agent}" (prompt ${req.promptVersion}). Call exactly once.`, parameters } }],
      tool_choice: { type: "function", function: { name: toolName } },
      // Only route to providers that honour tools and tool_choice; otherwise the call fails and the fallback runs.
      provider: { require_parameters: true },
      usage: { include: true },
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    const started = Date.now();
    let status: number;
    let json: ChatResponse;
    try {
      const res = await this.transport(body, { apiKey: this.apiKey, timeoutMs: this.timeoutMs });
      status = res.status;
      json = (res.json ?? {}) as ChatResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = /timeout|timed out|abort/i.test(message) ? "timeout" : "provider_error";
      this.logger?.warn("openrouter request failed", { agent: req.agent, kind, error: message.slice(0, 300) });
      return fail(kind, `OpenRouter: ${message}`, model, null);
    }
    const latencyMs = Date.now() - started;
    const apiError = json.error ?? json.choices?.[0]?.error;
    if (status === 429 || String(apiError?.code) === "429") return fail("rate_limited", `OpenRouter rate limited: ${apiError?.message ?? status}`, model, null, json);
    if (status < 200 || status >= 300 || apiError) {
      this.logger?.warn("openrouter error", { agent: req.agent, status, error: apiError?.message?.slice(0, 300) });
      return fail("provider_error", `OpenRouter error ${status}: ${apiError?.message ?? "unknown"}`, model, null, json);
    }

    const usage: ModelUsage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      // A ":free" model is free by definition; otherwise take OpenRouter's reported cost, or unknown.
      costUsd: model.endsWith(":free") ? 0 : typeof json.usage?.cost === "number" ? json.usage.cost : null,
      latencyMs,
    };
    const choice = json.choices?.[0];
    const modelVersion = json.model || model;
    if (!choice?.message) return fail("provider_error", "OpenRouter returned no choice", model, usage, json);
    if (choice.message.refusal) return fail("refused", `Model refused: ${choice.message.refusal.slice(0, 200)}`, model, usage, json);
    if (choice.finish_reason === "length") return fail("validation_failed", "Output truncated at max_tokens before a complete function call", model, usage, json);

    const call = choice.message.tool_calls?.find((c) => c.function?.name === toolName) ?? choice.message.tool_calls?.[0];
    const rawArgs = call?.function?.arguments ?? jsonFromContent(choice.message.content);
    if (rawArgs == null) return fail("validation_failed", "Model did not call the structured output function", model, usage, json);
    let input: unknown;
    try {
      input = JSON.parse(rawArgs);
    } catch {
      return fail("validation_failed", "Function arguments are not valid JSON", model, usage, json);
    }
    const parsed = req.schema.safeParse(input);
    if (!parsed.success) {
      this.logger?.warn("structured output failed schema validation", { agent: req.agent, model, issues: parsed.error.issues.slice(0, 5) });
      return fail("validation_failed", `Output failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ")}`, model, usage, json);
    }
    return { ok: true, output: parsed.data, modelName: model, modelVersion, usage, raw: json };
  }
}

/** Some providers answer with a JSON object in the message text instead of a function call. */
function jsonFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const text = (fenced ? fenced[1]! : content).trim();
  return text.startsWith("{") && text.endsWith("}") ? text : null;
}

function fail<T>(kind: Exclude<StructuredResult<unknown>, { ok: true }>["error"], message: string, modelName: string | null, usage: ModelUsage | null, raw?: unknown): StructuredResult<T> {
  return raw === undefined ? { ok: false, error: kind, message, modelName, usage } : { ok: false, error: kind, message, modelName, usage, raw };
}

/**
 * Primary-then-fallback client: every request goes to the primary (the free model) first; if it
 * fails for any reason the same request goes to the fallback (the paid model), so a flaky free
 * model never costs a decision. After a rate limit the primary rests for `cooldownMs` so the
 * fallback is not preceded by a doomed call each time.
 */
export class FallbackStructuredClient implements StructuredModelClient {
  private resumeAt = 0;

  constructor(
    private readonly primary: StructuredModelClient,
    private readonly fallback: StructuredModelClient,
    private readonly options: { cooldownMs?: number; now?: () => number; logger?: OpenRouterClientOptions["logger"] } = {},
  ) {}

  get configured(): boolean {
    return this.primary.configured || this.fallback.configured;
  }

  modelFor(role: ModelRole): string | null {
    return this.primary.configured ? this.primary.modelFor(role) : this.fallback.modelFor(role);
  }

  /** The free primary on its own (no paid fallback), honouring its rate-limit rest. */
  freeOnly(): StructuredModelClient | null {
    const free = this.primary.freeOnly?.() ?? null;
    if (!free) return null;
    const now = this.options.now ?? Date.now;
    return now() >= this.resumeAt ? free : null;
  }

  async complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const now = this.options.now ?? Date.now;
    if (this.primary.configured && now() >= this.resumeAt) {
      const first = await this.primary.complete(req);
      if (first.ok) return first;
      if (first.error === "rate_limited") this.resumeAt = now() + (this.options.cooldownMs ?? 15 * 60_000);
      this.options.logger?.warn("primary model failed, using fallback", { agent: req.agent, error: first.error, message: first.message.slice(0, 200) });
      if (!this.fallback.configured) return first;
    }
    return this.fallback.complete(req);
  }
}

/**
 * Client whose implementation can be replaced at runtime (an admin sets or clears a provider key
 * without a restart). Every service holds this one object.
 */
export class SwitchableModelClient implements StructuredModelClient {
  constructor(private current: StructuredModelClient) {}

  set(next: StructuredModelClient): void {
    this.current = next;
  }

  get configured(): boolean {
    return this.current.configured;
  }

  modelFor(role: ModelRole): string | null {
    return this.current.modelFor(role);
  }

  freeOnly(): StructuredModelClient | null {
    return this.current.freeOnly?.() ?? null;
  }

  complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return this.current.complete(req);
  }
}
