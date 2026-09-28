import type { ModelRole, ModelUsage, StructuredModelClient, StructuredRequest, StructuredResult } from "../llm/contract.js";

/**
 * FAKE CLIENT — FOR TESTS ONLY.
 *
 * Scripted outputs by agent name. It is explicitly constructed by tests; production code never
 * instantiates it and there is no code path that falls back to it. Every scripted output still goes
 * through the agent's zod schema, so tests exercise the validation path exactly like production.
 */
export type FakeScript = Record<string, unknown | ((req: StructuredRequest<unknown>) => unknown)>;

export interface FakeFailure {
  error: Exclude<StructuredResult<unknown>, { ok: true }>["error"];
  message?: string;
}

export interface FakeClientOptions {
  /** agent name -> output object (or function of the request). */
  outputs?: FakeScript;
  /** agent name -> forced failure. */
  failures?: Record<string, FakeFailure>;
  models?: Partial<Record<ModelRole, string>>;
  usage?: Partial<ModelUsage>;
}

export interface RecordedRequest {
  agent: string;
  promptVersion: string;
  role: ModelRole;
  system: string;
  user: string;
  toolName: string | undefined;
}

export class FakeStructuredClient implements StructuredModelClient {
  readonly configured = true;
  readonly isFake = true as const;
  readonly requests: RecordedRequest[] = [];
  private readonly outputs: FakeScript;
  private readonly failures: Record<string, FakeFailure>;
  private readonly models: Record<ModelRole, string>;
  private readonly usage: ModelUsage;

  constructor(options: FakeClientOptions = {}) {
    this.outputs = options.outputs ?? {};
    this.failures = options.failures ?? {};
    this.models = { slow_brain: "fake-slow-brain", research: "fake-research", fast: "fake-fast", ...options.models };
    this.usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.001, latencyMs: 5, ...options.usage };
  }

  modelFor(role: ModelRole): string {
    return this.models[role];
  }

  script(agent: string, output: unknown): void {
    this.outputs[agent] = output;
  }

  async complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push({ agent: req.agent, promptVersion: req.promptVersion, role: req.role, system: req.system, user: req.user, toolName: req.toolName });
    const modelName = this.modelFor(req.role);
    const failure = this.failures[req.agent];
    if (failure) {
      return { ok: false, error: failure.error, message: failure.message ?? `scripted ${failure.error}`, modelName, usage: { ...this.usage } };
    }
    if (!(req.agent in this.outputs)) {
      return { ok: false, error: "provider_error", message: `FakeStructuredClient: no scripted output for agent "${req.agent}"`, modelName, usage: null };
    }
    const scripted = this.outputs[req.agent];
    const raw = typeof scripted === "function" ? (scripted as (r: StructuredRequest<unknown>) => unknown)(req as StructuredRequest<unknown>) : scripted;
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "validation_failed", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), modelName, usage: { ...this.usage }, raw };
    }
    return { ok: true, output: parsed.data, modelName, modelVersion: `${modelName}-v0`, usage: { ...this.usage }, raw };
  }
}
