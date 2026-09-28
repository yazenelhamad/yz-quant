import type { IsoTimestamp } from "./ids.js";

export type AuditCategory =
  | "auth" | "session" | "settings" | "autonomy" | "broker" | "market_data" | "thesis"
  | "risk" | "order" | "fill" | "reconciliation" | "kill_switch" | "learning" | "admin"
  | "strategy" | "model" | "system";

export interface AuditEvent {
  id?: string;
  at: IsoTimestamp;
  category: AuditCategory;
  action: string;
  userId: string | null;
  brokerAccountId: string | null;
  actorUserId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  modelName: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  tradeId: string | null;
  orderId: string | null;
  result: "ok" | "error" | "rejected" | "info";
  detail: Record<string, unknown>;
  error: string | null;
  ip: string | null;
  sessionId: string | null;
}

export type HealthStatus = "healthy" | "warning" | "critical" | "unknown";

export interface HealthComponent {
  name: string;
  status: HealthStatus;
  detail: string;
  checkedAt: IsoTimestamp;
  metrics?: Record<string, number | string | null>;
}
