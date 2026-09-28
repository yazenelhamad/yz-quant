import type { RiskSettings } from "../types/index.js";
import { parseHHMM, zonedParts } from "../portfolio/time.js";

export interface TradingWindowResult {
  inside: boolean;
  /** HH:MM in the configured timezone, or null when it could not be computed. */
  localTime: string | null;
  weekday: number | null;
  reason: string;
}

/**
 * Whether `now` falls inside the configured entry window (inclusive) on a weekday in the
 * configured timezone. Built on Intl only. Malformed configuration => outside (fail closed).
 */
export function isWithinEntryWindow(now: string, hours: RiskSettings["tradingHours"]): TradingWindowResult {
  const start = parseHHMM(hours.start);
  const end = parseHHMM(hours.end);
  if (start === null || end === null) return { inside: false, localTime: null, weekday: null, reason: `malformed trading window ${hours.start}-${hours.end}` };
  const parts = zonedParts(now, hours.timezone);
  if (!parts) return { inside: false, localTime: null, weekday: null, reason: `cannot resolve ${now} in timezone ${hours.timezone}` };
  const localTime = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  if (parts.weekday === 0 || parts.weekday === 6) {
    return { inside: false, localTime, weekday: parts.weekday, reason: `weekend in ${hours.timezone}` };
  }
  if (start > end) return { inside: false, localTime, weekday: parts.weekday, reason: `trading window start ${hours.start} is after end ${hours.end}` };
  const inside = parts.minutesOfDay >= start && parts.minutesOfDay <= end;
  return {
    inside,
    localTime,
    weekday: parts.weekday,
    reason: inside
      ? `${localTime} ${hours.timezone} is inside ${hours.start}-${hours.end}`
      : `${localTime} ${hours.timezone} is outside ${hours.start}-${hours.end}`,
  };
}
