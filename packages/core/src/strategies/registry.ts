import type { StrategyFamily } from "../types/index.js";
import type { Strategy, StrategyDescriptor } from "./contract.js";
import { EVENT_STRATEGIES } from "./library/event.js";
import { MEAN_REVERSION_STRATEGIES } from "./library/meanReversion.js";
import { OPTIONS_STRATEGIES } from "./library/options.js";
import { STATISTICAL_STRATEGIES } from "./library/statistical.js";
import { TREND_STRATEGIES } from "./library/trend.js";

/** Every built-in strategy, in family order. Keys are unique (enforced at module load). */
export const STRATEGY_LIBRARY: readonly Strategy[] = Object.freeze([
  ...TREND_STRATEGIES,
  ...MEAN_REVERSION_STRATEGIES,
  ...STATISTICAL_STRATEGIES,
  ...EVENT_STRATEGIES,
  ...OPTIONS_STRATEGIES,
]);

const BY_KEY: ReadonlyMap<string, Strategy> = (() => {
  const m = new Map<string, Strategy>();
  for (const s of STRATEGY_LIBRARY) {
    if (m.has(s.descriptor.key)) throw new Error(`Duplicate strategy key: ${s.descriptor.key}`);
    m.set(s.descriptor.key, s);
  }
  return m;
})();

export function getStrategy(key: string): Strategy | undefined {
  return BY_KEY.get(key);
}

export function listStrategyDescriptors(): StrategyDescriptor[] {
  return STRATEGY_LIBRARY.map((s) => s.descriptor);
}

export function strategiesByFamily(family: StrategyFamily): Strategy[] {
  return STRATEGY_LIBRARY.filter((s) => s.descriptor.family === family);
}

export function strategyFamily(key: string): StrategyFamily | undefined {
  return BY_KEY.get(key)?.descriptor.family;
}
