import type { z } from "zod";

/**
 * Structured model client contract. Every agent in the intelligence package talks to models
 * only through this interface, which returns schema-validated JSON or a typed failure.
 * Implementations: AnthropicStructuredClient (real), NotConfiguredClient (fails closed),
 * FakeStructuredClient (tests only, explicitly labelled).
 */
export type ModelRole = "slow_brain" | "research" | "fast";

export interface StructuredRequest<T> {
  agent: string;
  promptVersion: string;
  role: ModelRole;
  system: string;
  /** Untrusted external content must already be wrapped in data blocks (see defense/). */
  user: string;
  schema: z.ZodType<T>;
  /** Name of the output tool; defaults to "emit_result". */
  toolName?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export type StructuredResult<T> =
  | { ok: true; output: T; modelName: string; modelVersion: string; usage: ModelUsage; raw: unknown }
  | { ok: false; error: "not_configured" | "validation_failed" | "provider_error" | "rate_limited" | "timeout" | "refused"; message: string; modelName: string | null; usage: ModelUsage | null; raw?: unknown };

export interface StructuredModelClient {
  readonly configured: boolean;
  complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /** Model id resolved for a role (for versioning / audit). */
  modelFor(role: ModelRole): string | null;
  /** A view of this client that only uses a free model (no paid fallback), or null when there is none. */
  freeOnly?(): StructuredModelClient | null;
}
