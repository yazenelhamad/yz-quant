/**
 * Backtesting engine: pure, deterministic, event-driven simulation of a `Strategy` over a
 * `BacktestDataset`, plus validation procedures (walk-forward, purged K-fold, Monte Carlo,
 * sensitivity, stress, regime attribution) and the strategy promotion pipeline.
 */
export * from "./random.js";
export * from "./data.js";
export * from "./metrics.js";
export * from "./engine.js";
export * from "./validation.js";
export * from "./pipeline.js";
export * from "./synthetic.js";
