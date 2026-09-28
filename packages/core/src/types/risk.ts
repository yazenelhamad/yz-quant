import { z } from "zod";
import type { IsoTimestamp, TenantScope } from "./ids.js";

export const AutonomyLevelSchema = z.enum([
  "research_only",
  "shadow",
  "manual_approval",
  "semi_autonomous",
  "fully_autonomous",
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/** Per-account, user-configurable limits. Never shared between users. */
export const RiskSettingsSchema = z.object({
  maxCapitalDeployedPct: z.number().min(0).max(1).default(0.6),
  maxPositionPct: z.number().min(0).max(1).default(0.1),
  maxSectorPct: z.number().min(0).max(1).default(0.3),
  maxCorrelatedExposurePct: z.number().min(0).max(1).default(0.4),
  maxPortfolioBeta: z.number().min(0).max(5).default(1.3),
  maxDailyLossPct: z.number().min(0).max(1).default(0.02),
  maxWeeklyLossPct: z.number().min(0).max(1).default(0.05),
  maxDrawdownPct: z.number().min(0).max(1).default(0.1),
  maxSimultaneousPositions: z.number().int().min(0).max(200).default(12),
  maxOptionsExposurePct: z.number().min(0).max(1).default(0),
  maxLossPerTradePct: z.number().min(0).max(1).default(0.01),
  minLiquidityAdv: z.number().min(0).default(1_000_000), // min average dollar volume
  minConfidence: z.number().min(0).max(1).default(0.6),
  minExpectedEdge: z.number().min(0).max(1).default(0.15),
  maxSpreadBps: z.number().min(0).default(25),
  maxAnnualizedVolatility: z.number().min(0).default(0.9),
  /** Notional above which semi-autonomous mode requires approval. */
  semiAutoApprovalNotional: z.number().min(0).default(2_000),
  tradingHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/).default("09:35"),
    end: z.string().regex(/^\d{2}:\d{2}$/).default("15:50"),
    timezone: z.string().default("America/New_York"),
    allowExtendedHours: z.boolean().default(false),
  }).default({}),
  restrictedSymbols: z.array(z.string()).default([]),
  allowedSymbols: z.array(z.string()).nullable().default(null),
  optionsEnabled: z.boolean().default(false),
  /** Fractional Kelly cap: sizing never exceeds this fraction of full Kelly. */
  kellyFraction: z.number().min(0).max(0.5).default(0.25),
});
export type RiskSettings = z.infer<typeof RiskSettingsSchema>;
export const DEFAULT_RISK_SETTINGS: RiskSettings = RiskSettingsSchema.parse({});

export type KillSwitchReason =
  | "daily_loss_limit"
  | "weekly_loss_limit"
  | "drawdown_limit"
  | "market_data_failure"
  | "broker_unreliable"
  | "reconciliation_failed"
  | "position_mismatch"
  | "abnormal_ai_output"
  | "repeated_execution_failures"
  | "database_error"
  | "unexpected_position"
  | "emergency_volatility"
  | "manual"
  | "admin_global";

export interface KillSwitchState {
  /** Null scope = global. */
  scope: TenantScope | null;
  active: boolean;
  reasons: KillSwitchReason[];
  /** Risk-reducing exits remain allowed while active. */
  allowRiskReducingExits: boolean;
  triggeredAt: IsoTimestamp | null;
  triggeredBy: string | null;
  note: string | null;
}

export interface GlobalRiskState {
  liveExecutionDisabled: boolean;
  forceShadowMode: boolean;
  pausedUsers: string[];
  disabledStrategyIds: string[];
  globalKillSwitch: KillSwitchState;
  updatedAt: IsoTimestamp;
  updatedBy: string | null;
}

export type RiskVerdict = "approve" | "reduce" | "reject";

export interface RiskCheck {
  code: string;
  passed: boolean;
  severity: "info" | "warning" | "blocking";
  detail: string;
  observed?: number | string | null;
  limit?: number | string | null;
}

export interface RiskDecision {
  id: string;
  scope: TenantScope;
  candidateId: string | null;
  tradeId: string | null;
  symbol: string;
  action: string;
  verdict: RiskVerdict;
  /** Final approved quantity (may be smaller than requested). Zero when rejected. */
  approvedQuantity: number;
  approvedNotional: number;
  requestedQuantity: number;
  checks: RiskCheck[];
  reasons: string[];
  riskEngineVersion: string;
  decidedAt: IsoTimestamp;
  /** True when the engine failed closed because of an internal error or missing input. */
  failedClosed: boolean;
}
