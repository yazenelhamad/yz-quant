/**
 * Small price table (USD per million tokens). Unknown models yield `null` cost so a
 * missing entry never silently under-reports spend.
 */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 },
  "claude-fable-5": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 },
  "claude-opus-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  "claude-opus-4-8": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  "claude-sonnet-5": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
  "claude-haiku-4-5-20251001": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function priceFor(model: string): ModelPrice | null {
  return PRICE_TABLE[model] ?? null;
}

/** Returns null for unknown models (never guesses). */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const cost =
    (tokens.inputTokens * price.inputPerM +
      tokens.outputTokens * price.outputPerM +
      (tokens.cacheReadTokens ?? 0) * price.cacheReadPerM +
      (tokens.cacheWriteTokens ?? 0) * price.cacheWritePerM) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
