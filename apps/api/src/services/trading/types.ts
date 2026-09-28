import type {
  CandidateFit, EnsembleResult, FastBrainOutput, PortfolioAssessment, RegimeAssessment, RejectionReason, RiskEvaluation, SizingResult, TenantScope, TradeMode, TradeThesis,
} from "@yz/core";
import type { AdapterRegistry, BrokerAdapter } from "@yz/broker";
import type { StructuredModelClient } from "@yz/intelligence";
import type { Repos } from "../../http/app.js";
import type { AuditService } from "../audit.js";
import type { MarketDataService } from "../marketData.js";
import type { ShadowBooks } from "./shadow.js";
import type { CandidateRecord, TradingStore } from "./store.js";

export interface TradingLogger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/** The broker surface the trading cycle needs. `BrokerService` satisfies it. */
export interface BrokerGateway {
  readonly registry: AdapterRegistry;
  adapterFor(scope: TenantScope): Promise<BrokerAdapter | null>;
}

export interface TradingDeps {
  broker: BrokerGateway;
  marketData: MarketDataService;
  modelClient: StructuredModelClient;
  clock?: () => Date;
  log?: TradingLogger;
}

/** Everything the trading modules need at runtime; built once by `createTradingService`. */
export interface TradingRuntime {
  repos: Repos;
  store: TradingStore;
  broker: BrokerGateway;
  marketData: MarketDataService;
  modelClient: StructuredModelClient;
  shadowBooks: ShadowBooks;
  audit: AuditService;
  clock: () => Date;
  log: TradingLogger;
}

export type FinalStatus = "approved" | "rejected" | "waiting" | "shadow" | "needs_approval";

export interface EvaluationSnapshot {
  scope: TenantScope;
  candidate: CandidateRecord;
  ensemble: EnsembleResult;
  regime: RegimeAssessment;
  mode: TradeMode;
  finalStatus: FinalStatus;
  reasons: string[];
  rejectionReasons: RejectionReason[];
  /** Price used for sizing / risk (quote last). */
  price: number | null;
  quantity: number;
  notional: number;
  assessment: PortfolioAssessment | null;
  fit: CandidateFit | null;
  sizing: SizingResult | null;
  fastBrain: FastBrainOutput | null;
  risk: RiskEvaluation | null;
  thesisId: string | null;
  thesis: TradeThesis | null;
  calibratedConfidence: number;
  strategyId: string;
  strategyVersionId: string | null;
  /** Adapter binding the execution will use (verified against the account). */
  accountNumber: string;
  evaluatedAt: string;
  /** True when this evaluation was returned from storage (candidate already evaluated for the scope). */
  replay: boolean;
}

export interface EvaluateOptions {
  /** True when the caller verified the session/job context owns the account (repos.accounts.forScope). */
  identityVerified: boolean;
  /** Live positions already opened (or sent for approval) earlier in the same cycle, for the survival mandate's per-cycle budget. */
  liveEntriesThisCycle?: number;
  /**
   * Evaluate again even though a stored evaluation exists (the cycle decided the stored one is
   * provisional: a cooled-off rejection, or a decision whose trades all ended unfilled). A stored
   * approval/shadow decision with a living trade is still replayed, never redone.
   */
  reevaluate?: boolean;
}
