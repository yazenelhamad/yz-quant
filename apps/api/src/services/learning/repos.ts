import type { Database } from "@yz/db";
import {
  AdaptationProposalsRepository, AgentProfilesRepository, AgentRegistryRepository, BacktestsRepository, CalibrationRepository, ExperimentsRepository,
  LearningDigestsRepository, LearningInputsRepository, ModelProfilesRepository, ModelRegistryRepository, PostTradeReviewsRepository, SignalProfilesRepository,
  StrategyCatalogRepository, StrategyProfilesRepository, StrategySettingsRepository, TradeLessonsRepository, TradeMemoryRepository, VariantRepository,
} from "@yz/db";

/** Repositories used by the learning and research planes (built from the shared database handle). */
export interface LearningRepos {
  reviews: PostTradeReviewsRepository;
  lessons: TradeLessonsRepository;
  memory: TradeMemoryRepository;
  strategyProfiles: StrategyProfilesRepository;
  signalProfiles: SignalProfilesRepository;
  modelProfiles: ModelProfilesRepository;
  agentProfiles: AgentProfilesRepository;
  calibration: CalibrationRepository;
  proposals: AdaptationProposalsRepository;
  digests: LearningDigestsRepository;
  inputs: LearningInputsRepository;
  catalog: StrategyCatalogRepository;
  settings: StrategySettingsRepository;
  backtests: BacktestsRepository;
  experiments: ExperimentsRepository;
  modelRegistry: ModelRegistryRepository;
  agentRegistry: AgentRegistryRepository;
  variant: VariantRepository;
}

export function buildLearningRepos(db: Database): LearningRepos {
  return {
    reviews: new PostTradeReviewsRepository(db),
    lessons: new TradeLessonsRepository(db),
    memory: new TradeMemoryRepository(db),
    strategyProfiles: new StrategyProfilesRepository(db),
    signalProfiles: new SignalProfilesRepository(db),
    modelProfiles: new ModelProfilesRepository(db),
    agentProfiles: new AgentProfilesRepository(db),
    calibration: new CalibrationRepository(db),
    proposals: new AdaptationProposalsRepository(db),
    digests: new LearningDigestsRepository(db),
    inputs: new LearningInputsRepository(db),
    catalog: new StrategyCatalogRepository(db),
    settings: new StrategySettingsRepository(db),
    backtests: new BacktestsRepository(db),
    experiments: new ExperimentsRepository(db),
    modelRegistry: new ModelRegistryRepository(db),
    agentRegistry: new AgentRegistryRepository(db),
    variant: new VariantRepository(db),
  };
}
