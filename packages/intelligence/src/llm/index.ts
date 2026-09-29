export * from "./contract.js";
export * from "./jsonSchema.js";
export * from "./pricing.js";
export * from "./anthropicClient.js";
export * from "./notConfiguredClient.js";
export * from "./openRouterClient.js";

import type { StructuredModelClient } from "./contract.js";
import { AnthropicStructuredClient, resolveModelsFromEnv, type AnthropicClientOptions } from "./anthropicClient.js";
import { NotConfiguredClient } from "./notConfiguredClient.js";
import { FallbackStructuredClient, OpenRouterStructuredClient } from "./openRouterClient.js";

export interface CreateModelClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  logger?: AnthropicClientOptions["logger"];
}

/**
 * Builds the production client from the environment. Without ANTHROPIC_API_KEY it returns the
 * NotConfiguredClient (configured=false) — there is no silent fallback to fake answers.
 */
export function createModelClient(env: Record<string, string | undefined>, options: CreateModelClientOptions = {}): StructuredModelClient {
  const base = createAnthropicClient(env, options);
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  return openRouterKey ? withOpenRouter(base, openRouterKey, env.OPENROUTER_MODEL, options.logger) : base;
}

/**
 * Puts an OpenRouter model (free by default) in front of `fallback`: requests go to OpenRouter
 * first and fall back to the Anthropic client whenever it fails or is rate limited.
 */
export function withOpenRouter(fallback: StructuredModelClient, apiKey: string, model: string | undefined, logger?: CreateModelClientOptions["logger"]): StructuredModelClient {
  const primary = new OpenRouterStructuredClient({ apiKey, ...(model?.trim() ? { model: model.trim() } : {}), ...(logger ? { logger } : {}) });
  return new FallbackStructuredClient(primary, fallback, logger ? { logger } : {});
}

/** The Anthropic client alone (or NotConfiguredClient without ANTHROPIC_API_KEY). */
export function createAnthropicClient(env: Record<string, string | undefined>, options: CreateModelClientOptions = {}): StructuredModelClient {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new NotConfiguredClient();
  const timeoutMs = env.MODEL_TIMEOUT_MS ? Number(env.MODEL_TIMEOUT_MS) : undefined;
  return new AnthropicStructuredClient({
    apiKey,
    models: resolveModelsFromEnv(env),
    ...(options.timeoutMs !== undefined || (timeoutMs && Number.isFinite(timeoutMs)) ? { timeoutMs: options.timeoutMs ?? timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
