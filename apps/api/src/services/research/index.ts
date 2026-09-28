import type { StructuredModelClient } from "@yz/intelligence";
import { NotConfiguredClient } from "@yz/intelligence";
import type { AppContext } from "../../http/app.js";
import { buildLearningRepos, type LearningRepos } from "../learning/repos.js";
import { BacktestRunner, type BacktestRunnerOptions } from "./backtests.js";
import { evaluatePromotion, type PromotionEvaluation } from "./promotion.js";
import { runVariant, variantSnapshot, type VariantRunResult } from "./variant.js";

export * from "./backtests.js";
export * from "./promotion.js";
export * from "./variant.js";

export interface ResearchServiceOptions extends BacktestRunnerOptions {
  modelClient?: StructuredModelClient;
}

/** Research plane: backtest queue, promotion evaluation, variant perception runs, experiments. */
export class ResearchService {
  readonly lr: LearningRepos;
  readonly backtests: BacktestRunner;
  readonly modelClient: StructuredModelClient;
  private readonly clock: () => Date;

  constructor(private readonly app: AppContext, options: ResearchServiceOptions = {}) {
    this.lr = buildLearningRepos(app.dbHandle.db);
    this.clock = options.clock ?? (() => new Date());
    this.backtests = new BacktestRunner(app.repos, this.lr, options);
    this.modelClient = options.modelClient ?? (app.services["modelClient"] as StructuredModelClient | undefined) ?? new NotConfiguredClient();
  }

  runBacktestJob(id: string) { return this.backtests.runBacktestJob(id); }
  evaluatePromotion(strategyKey: string, opts?: { humanReviewApproved?: boolean }): Promise<PromotionEvaluation> { return evaluatePromotion(this.lr, strategyKey, opts); }
  runVariant(ticker: string, requestedBy: string): Promise<VariantRunResult> {
    return runVariant({ repos: this.app.repos, lr: this.lr, audit: this.app.audit, modelClient: this.modelClient, clock: this.clock }, ticker, requestedBy);
  }
  variant(ticker: string) { return variantSnapshot(this.lr, ticker); }
}

export function createResearchService(ctx: AppContext, options: ResearchServiceOptions = {}): ResearchService {
  const service = new ResearchService(ctx, options);
  ctx.services["research"] = service;
  return service;
}
