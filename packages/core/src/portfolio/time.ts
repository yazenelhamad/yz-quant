/**
 * Timezone helpers built only on the Intl API (no libraries, no Date.now()).
 * Everything takes an explicit ISO timestamp.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  /** Minutes since local midnight. */
  minutesOfDay: number;
  /** YYYY-MM-DD in the requested timezone. */
  dateKey: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `iso` in `timeZone`; null when the timestamp or the zone is invalid. */
export function zonedParts(iso: string, timeZone: string): ZonedParts | null {
  if (!isValidIso(iso) || !isValidTimeZone(timeZone)) return null;
  const parts = getFormatter(timeZone).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekday = WEEKDAYS[get("weekday")];
  if (![year, month, day, hour, minute, second].every(Number.isFinite) || weekday === undefined) return null;
  return {
    year, month, day, hour, minute, second, weekday,
    minutesOfDay: hour * 60 + minute,
    dateKey: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
  };
}

/** Parses "HH:MM" into minutes since midnight; null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** Shifts a YYYY-MM-DD key by `days` (calendar arithmetic, timezone-free). */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error(`Invalid date key ${dateKey}`);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}
