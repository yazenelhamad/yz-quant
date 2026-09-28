import type { IsoTimestamp } from "./ids.js";

/** Where a datapoint came from. Every important market datapoint carries provenance. */
export interface DataProvenance {
  source: string; // e.g. "robinhood_mcp:get_equity_quotes"
  /** When the venue/provider says the value was observed. */
  observedAt: IsoTimestamp;
  /** When our process received it. */
  receivedAt: IsoTimestamp;
  /** 0..1 subjective reliability of the source for this kind of data. */
  reliability: number;
}

export type Freshness = "fresh" | "aging" | "stale" | "unknown";

export interface DataQuality {
  freshness: Freshness;
  ageSeconds: number | null;
  reliability: number;
  /** True when independent sources disagree materially. */
  contradictory: boolean;
  notes: string[];
}

export interface Quote {
  symbol: string;
  last: number;
  bid: number | null;
  ask: number | null;
  previousClose: number | null;
  lastTradeAt: IsoTimestamp | null;
  /** Session the last print came from. */
  session: "regular" | "pre" | "post" | "overnight" | "unknown";
  instrumentState: "active" | "inactive" | "delisted" | "unlisted" | "unknown";
  provenance: DataProvenance;
}

export type BarInterval =
  | "minute" | "5minute" | "10minute" | "15minute" | "30minute" | "hour" | "4hour"
  | "day" | "week" | "month";

export interface Bar {
  symbol: string;
  interval: BarInterval;
  /** Left-edge labelled start time (UTC). */
  time: IsoTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** True when the provider synthesised the bar to fill a gap. Excluded from feature computation. */
  interpolated: boolean;
  adjusted: "none" | "split" | "all";
  provenance?: DataProvenance;
}

export interface OrderBookLevel { price: number; size: number }
export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  provenance: DataProvenance;
}

export interface Tradability {
  symbol: string;
  tradeable: boolean;
  fractional: boolean;
  extendedHours: boolean;
  allDay: boolean;
  shortable: boolean;
  halted: boolean;
  haltReason: string | null;
  /** Account-type specific rule, e.g. position_closing_only. */
  accountRule: "tradable" | "untradable" | "position_closing_only" | "unknown";
  provenance: DataProvenance;
}

export interface MarketCalendarDay {
  date: string; // YYYY-MM-DD (America/New_York)
  isTradingDay: boolean;
  regularOpen: IsoTimestamp | null;
  regularClose: IsoTimestamp | null;
  earlyClose: boolean;
}

export type MarketSession = "closed" | "pre" | "regular" | "post" | "overnight";
