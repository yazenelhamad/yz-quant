import type { ModelRole, StructuredModelClient, StructuredRequest, StructuredResult } from "./contract.js";

export const MODELS_NOT_CONFIGURED_MESSAGE = "AI models: not configured (ANTHROPIC_API_KEY is absent)";

/**
 * Fail-closed client used when no API key is present. Every call returns
 * `{ ok: false, error: "not_configured" }`; callers must surface "AI models: not configured"
 * and carry on with deterministic engines only. It never fabricates output.
 */
export class NotConfiguredClient implements StructuredModelClient {
  readonly configured = false;

  modelFor(_role: ModelRole): null {
    return null;
  }

  async complete<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return { ok: false, error: "not_configured", message: MODELS_NOT_CONFIGURED_MESSAGE, modelName: null, usage: null };
  }
}
