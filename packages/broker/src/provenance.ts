import type { DataProvenance, IsoTimestamp } from "@yz/core";

/** Default reliability per kind of datum. Subjective, but stable so that data-quality logic can compare sources. */
export const RELIABILITY = {
  account: 0.98,
  orders: 0.98,
  quotes: 0.92,
  bars: 0.9,
  depth: 0.85,
  reference: 0.8,
  simulated: 0.5,
} as const;

/** Robinhood MCP provenance. `observedAt` is the venue timestamp when present, else the receipt time. */
export function mcpProvenance(tool: string, receivedAt: IsoTimestamp, observedAt: IsoTimestamp | null | undefined, reliability: number): DataProvenance {
  return {
    source: `robinhood_mcp:${tool}`,
    observedAt: isValidIso(observedAt) ? new Date(observedAt).toISOString() : receivedAt,
    receivedAt,
    reliability,
  };
}

export function simulatedProvenance(at: IsoTimestamp): DataProvenance {
  return { source: "simulated", observedAt: at, receivedAt: at, reliability: RELIABILITY.simulated };
}

export function isValidIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/** Parse an RFC3339 timestamp into canonical ISO-8601 UTC. Null when missing or invalid — never fabricated. */
export function toIso(value: unknown): IsoTimestamp | null {
  return isValidIso(value) ? new Date(value).toISOString() : null;
}
