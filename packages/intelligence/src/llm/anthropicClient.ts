import Anthropic from "@anthropic-ai/sdk";
import type { ModelRole, ModelUsage, StructuredModelClient, StructuredRequest, StructuredResult } from "./contract.js";
import { zodToJsonSchema } from "./jsonSchema.js";
import { estimateCostUsd } from "./pricing.js";

/** Default model per role. Overridable via MODEL_SLOW_BRAIN / MODEL_RESEARCH / MODEL_FAST. */
export const DEFAULT_MODELS: Readonly<Record<ModelRole, string>> = {
  slow_brain: "claude-fable-5-1",
  research: "claude-opus-5-5",
  fast: "claude-haiku-4-5-20251001",
};

export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_TOOL_NAME = "emit_result";

/**
 * Models that reject forced `tool_choice: {type: "tool"}` (HTTP 400). For those we send
 * `tool_choice: {type: "auto", disable_parallel_tool_use: true}` plus an explicit system
 * instruction to call the single tool, and treat a missing tool call as a validation failure.
 */
const NO_FORCED_TOOL_CHOICE_PREFIXES = ["claude-fable-5-1", "claude-opus-5-5", "claude-mythos-5-1"];
export function supportsForcedToolChoice(model: string): boolean {
  return !NO_FORCED_TOOL_CHOICE_PREFIXES.some((p) => model.startsWith(p));
}

/** Sampling parameters (temperature) are rejected on the 4.6+ families; only Haiku 4.5 accepts them. */
function acceptsTemperature(model: string): boolean {
  return model.startsWith("claude-haiku-4-5");
}

const OUTPUT_INSTRUCTION =
  "OUTPUT CONTRACT: Respond ONLY by calling the provided tool exactly once with a JSON object that satisfies its input schema. " +
  "Do not write prose outside the tool call. If evidence is insufficient, still call the tool and express uncertainty through its fields.";

export type MessageTransport = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { timeoutMs: number },
) => Promise<Anthropic.Message>;

export interface AnthropicClientOptions {
  apiKey: string;
  /** Role -> model id map. Missing roles fall back to DEFAULT_MODELS. */
  models?: Partial<Record<ModelRole, string>>;
  timeoutMs?: number;
  /** Retries on 429 / 529 / 5xx / connection errors. Default 2. */
  maxRetries?: number;
  /** Base backoff in ms (doubles per attempt). Default 500. */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable transport (tests). Defaults to the real Messages API. */
  transport?: MessageTransport;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export function resolveModelsFromEnv(env: Record<string, string | undefined>): Record<ModelRole, string> {
  return {
    slow_brain: env.MODEL_SLOW_BRAIN?.trim() || DEFAULT_MODELS.slow_brain,
    research: env.MODEL_RESEARCH?.trim() || DEFAULT_MODELS.research,
    fast: env.MODEL_FAST?.trim() || DEFAULT_MODELS.fast,
  };
}

interface RequestOutcome {
  message: Anthropic.Message;
  latencyMs: number;
}

type FailureKind = Exclude<StructuredResult<unknown>, { ok: true }>["error"];

class ProviderFailure extends Error {
  constructor(readonly kind: FailureKind, message: string, readonly raw?: unknown) {
    super(message);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    return status === 529 || (typeof status === "number" && status >= 500);
  }
  return false;
}

function classifyError(error: unknown): ProviderFailure {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderFailure("timeout", `Request timed out: ${error.message}`, error);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderFailure("rate_limited", `Rate limited: ${error.message}`, error);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 529) return new ProviderFailure("rate_limited", `Overloaded: ${error.message}`, error);
    return new ProviderFailure("provider_error", `API error ${status ?? "?"}: ${error.message}`, error);
  }
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
    return new ProviderFailure("timeout", error.message, error);
  }
  return new ProviderFailure("provider_error", error instanceof Error ? error.message : String(error), error);
}

/**
 * Real Messages API client. One forced (or strongly steered) tool per request whose input
 * schema is derived from the agent's zod schema; the returned tool input is validated with the
 * same zod schema before anything is trusted.
 */
export class AnthropicStructuredClient implements StructuredModelClient {
  readonly configured = true;
  private readonly models: Record<ModelRole, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly transport: MessageTransport;
  private readonly logger: AnthropicClientOptions["logger"];

  constructor(options: AnthropicClientOptions) {
    if (!options.apiKey) throw new Error("AnthropicStructuredClient requires an apiKey; use NotConfiguredClient otherwise");
    this.models = { ...DEFAULT_MODELS, ...stripUndefined(options.models ?? {}) };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
    if (options.transport) {
      this.transport = options.transport;
    } else {
      // Retries are handled here (bounded, observable), so the SDK's own retry loop is disabled.
      const sdk = new Anthropic({ apiKey: options.apiKey, maxRetries: 0, timeout: this.timeoutMs });
      this.transport = (params, { timeoutMs }) => sdk.messages.create(params, { timeout: timeoutMs });
    }
  }

  modelFor(role: ModelRole): string {
    return this.models[role];
  }

  async complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.modelFor(req.role);
    const toolName = req.toolName ?? DEFAULT_TOOL_NAME;
    let jsonSchema;
    try {
      jsonSchema = zodToJsonSchema(req.schema as unknown as Parameters<typeof zodToJsonSchema>[0]);
    } catch (error) {
      return failure("validation_failed", `Schema for ${req.agent} cannot be converted: ${(error as Error).message}`, model, null);
    }

    const forced = supportsForcedToolChoice(model);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens ?? 4096,
      system: [
        {
          type: "text",
          text: `${req.system}\n\n${OUTPUT_INSTRUCTION}${forced ? "" : ` The tool is named "${toolName}".`}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: req.user }],
      tools: [
        {
          name: toolName,
          description: `Structured output for agent "${req.agent}" (prompt ${req.promptVersion}). Call exactly once.`,
          input_schema: jsonSchema.schema as unknown as Anthropic.Tool.InputSchema,
          ...(jsonSchema.strictCompatible ? { strict: true } : {}),
        },
      ],
      tool_choice: forced
        ? { type: "tool", name: toolName, disable_parallel_tool_use: true }
        : { type: "auto", disable_parallel_tool_use: true },
      ...(req.temperature !== undefined && acceptsTemperature(model) ? { temperature: req.temperature } : {}),
    };

    let outcome: RequestOutcome;
    try {
      outcome = await this.send(params, req.agent);
    } catch (error) {
      const failureInfo = error instanceof ProviderFailure ? error : classifyError(error);
      return failure(failureInfo.kind, failureInfo.message, model, null, failureInfo.raw);
    }

    const { message, latencyMs } = outcome;
    const usage: ModelUsage = {
      inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      costUsd: estimateCostUsd(model, {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      }),
      latencyMs,
    };
    const modelVersion = message.model || model;

    if (message.stop_reason === "refusal") {
      return failure("refused", `Model refused (${message.stop_details?.category ?? "unspecified"})`, model, usage, message);
    }
    if (message.stop_reason === "max_tokens") {
      return failure("validation_failed", "Output truncated at max_tokens before a complete tool call", model, usage, message);
    }
    const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === toolName);
    if (!toolUse) {
      return failure("validation_failed", "Model did not call the structured output tool", model, usage, message);
    }
    const parsed = req.schema.safeParse(toolUse.input);
    if (!parsed.success) {
      this.logger?.warn("structured output failed schema validation", { agent: req.agent, issues: parsed.error.issues.slice(0, 5) });
      return failure("validation_failed", `Output failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ")}`, model, usage, message);
    }
    return { ok: true, output: parsed.data, modelName: model, modelVersion, usage, raw: message };
  }

  private async send(params: Anthropic.MessageCreateParamsNonStreaming, agent: string): Promise<RequestOutcome> {
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      try {
        const message = await this.transport(params, { timeoutMs: this.timeoutMs });
        return { message, latencyMs: Date.now() - started };
      } catch (error) {
        if (attempt < this.maxRetries && isRetryable(error)) {
          const delay = this.backoffBaseMs * 2 ** attempt;
          this.logger?.warn("model request failed, retrying", { agent, attempt: attempt + 1, delayMs: delay, error: (error as Error).message });
          attempt += 1;
          await this.sleep(delay);
          continue;
        }
        const failed = classifyError(error);
        this.logger?.warn("model request failed", { agent, attempt: attempt + 1, kind: failed.kind, error: failed.message.slice(0, 600) });
        throw failed;
      }
    }
  }
}

function failure<T>(kind: FailureKind, message: string, modelName: string | null, usage: ModelUsage | null, raw?: unknown): StructuredResult<T> {
  return raw === undefined ? { ok: false, error: kind, message, modelName, usage } : { ok: false, error: kind, message, modelName, usage, raw };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
