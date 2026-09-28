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

/** The candidate's levels re-measured from the live entry price (fractions of price). */
export interface EvaluationGeometry {
  referencePrice: number;
  invalidationPrice: number | null;
  targetPrice: number | null;
  /** The structural thesis level when the risk stop sits closer to price than it. */
  structuralInvalidationPrice: number | null;
  upsidePct: number;
  downsidePct: number;
  rewardRisk: number;
  stopSigma: number;
  targetSigma: number | null;
  /** Expected absolute move over the holding horizon (fraction of price). */
  sigmaHorizon: number;
  notes: string[];
}

/** How the win probability was arrived at: breakeven for the geometry plus a bounded signal tilt. */
export interface EvaluationProbability {
  value: number;
  breakeven: number | null;
  tilt: number;
  /** The calibrated signal confidence the tilt was read from. */
  signalConfidence: number;
  /** No-edge outcome split over the horizon (target first / stop first / neither). */
  noEdge: { target: number; stop: number; neither: number };
}

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
  geometry?: EvaluationGeometry | null;
  probability?: EvaluationProbability | null;
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
