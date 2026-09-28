import type { AuditCategory, AuditEvent } from "@yz/core";
import type { AuditRepository } from "@yz/db";
import type { FastifyRequest } from "fastify";
import { redactSecrets } from "../security/secrets.js";

export class AuditService {
  constructor(private readonly repo: AuditRepository, private readonly log: { warn: (o: unknown, msg?: string) => void }) {}

  async record(event: Partial<AuditEvent> & { category: AuditCategory; action: string; result: AuditEvent["result"] }, req?: FastifyRequest): Promise<void> {
    const full: AuditEvent = {
      at: new Date().toISOString(),
      userId: event.userId ?? req?.auth?.user.id ?? null,
      brokerAccountId: event.brokerAccountId ?? null,
      actorUserId: event.actorUserId ?? req?.auth?.user.id ?? null,
      strategyId: event.strategyId ?? null,
      strategyVersionId: event.strategyVersionId ?? null,
      modelName: event.modelName ?? null,
      modelVersion: event.modelVersion ?? null,
      promptVersion: event.promptVersion ?? null,
      tradeId: event.tradeId ?? null,
      orderId: event.orderId ?? null,
      detail: sanitize(event.detail ?? {}),
      error: event.error ? redactSecrets(event.error) : null,
      ip: event.ip ?? req?.ip ?? null,
      sessionId: event.sessionId ?? req?.auth?.session.id ?? null,
      category: event.category,
      action: event.action,
      result: event.result,
    };
    try {
      await this.repo.append(full);
    } catch (err) {
      // Audit failures must never crash the request path, but they are loud.
      this.log.warn({ err, action: full.action }, "audit append failed");
    }
  }
}

const SENSITIVE_KEYS = /token|secret|password|credential|authorization|code_verifier|refresh/i;

export function sanitize(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 6 || value === null || typeof value !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(k)) { out[k] = "[redacted]"; continue; }
    if (typeof v === "string") out[k] = redactSecrets(v).slice(0, 4000);
    else if (Array.isArray(v)) out[k] = v.slice(0, 200).map((x) => (typeof x === "object" && x !== null ? sanitize(x, depth + 1) : x));
    else if (typeof v === "object" && v !== null) out[k] = sanitize(v, depth + 1);
    else out[k] = v;
  }
  return out;
}
