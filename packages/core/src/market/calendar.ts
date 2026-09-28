import type { MarketCalendarDay, MarketSession } from "../types/market.js";

/**
 * NYSE trading calendar (regular session 09:30–16:00 America/New_York) computed algorithmically:
 * weekends, the nine NYSE holidays (with observed-day rules), Good Friday, and the early closes
 * (day after Thanksgiving, Christmas Eve when a weekday, July 3 when a weekday and July 4 is a weekday).
 * No external data. Deterministic.
 */

function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}
function observed(d: Date): Date {
  const dow = d.getUTCDay();
  if (dow === 6) return new Date(d.getTime() - 86_400_000);
  if (dow === 0) return new Date(d.getTime() + 86_400_000);
  return d;
}
function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}
const key = (d: Date) => d.toISOString().slice(0, 10);

export function nyseHolidays(year: number): Set<string> {
  const s = new Set<string>();
  s.add(key(observed(new Date(Date.UTC(year, 0, 1)))));
  s.add(key(nthWeekday(year, 0, 1, 3)));
  s.add(key(nthWeekday(year, 1, 1, 3)));
  s.add(key(new Date(easter(year).getTime() - 2 * 86_400_000)));
  s.add(key(lastWeekday(year, 4, 1)));
  if (year >= 2022) s.add(key(observed(new Date(Date.UTC(year, 5, 19)))));
  s.add(key(observed(new Date(Date.UTC(year, 6, 4)))));
  s.add(key(nthWeekday(year, 8, 1, 1)));
  s.add(key(nthWeekday(year, 10, 4, 4)));
  s.add(key(observed(new Date(Date.UTC(year, 11, 25)))));
  // New Year's Day observed on Jan 1 of next year falling on Saturday is not observed on Dec 31 by NYSE.
  return s;
}

export function nyseEarlyCloses(year: number): Set<string> {
  const s = new Set<string>();
  const thanks = nthWeekday(year, 10, 4, 4);
  s.add(key(new Date(thanks.getTime() + 86_400_000)));
  const xmasEve = new Date(Date.UTC(year, 11, 24));
  if (xmasEve.getUTCDay() >= 1 && xmasEve.getUTCDay() <= 5) s.add(key(xmasEve));
  const july3 = new Date(Date.UTC(year, 6, 3));
  const july4 = new Date(Date.UTC(year, 6, 4));
  if (july3.getUTCDay() >= 1 && july3.getUTCDay() <= 5 && july4.getUTCDay() >= 1 && july4.getUTCDay() <= 5) s.add(key(july3));
  return s;
}

/** Offset of America/New_York from UTC in minutes for a given instant (handles DST). */
export function newYorkOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), Number(parts["hour"]) % 24, Number(parts["minute"]), Number(parts["second"]));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Calendar date (YYYY-MM-DD) in New York for an instant. */
export function newYorkDate(at: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(at);
}

function nyInstant(date: string, hh: number, mm: number): Date {
  // Build the instant for date hh:mm New York time by iterating on the offset.
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  for (let i = 0; i < 2; i++) {
    const off = newYorkOffsetMinutes(guess);
    guess = new Date(Date.UTC(y, m - 1, d, hh, mm) - off * 60_000);
  }
  return guess;
}

export function marketCalendarDay(date: string): MarketCalendarDay {
  const [y] = date.split("-").map(Number) as [number];
  const d = new Date(`${date}T12:00:00Z`);
  const dow = d.getUTCDay();
  const holiday = nyseHolidays(y).has(date);
  const isTradingDay = dow !== 0 && dow !== 6 && !holiday;
  const early = nyseEarlyCloses(y).has(date);
  return {
    date,
    isTradingDay,
    regularOpen: isTradingDay ? nyInstant(date, 9, 30).toISOString() : null,
    regularClose: isTradingDay ? nyInstant(date, early ? 13 : 16, 0).toISOString() : null,
    earlyClose: isTradingDay && early,
  };
}

export function marketSessionAt(at: Date): MarketSession {
  const date = newYorkDate(at);
  const day = marketCalendarDay(date);
  if (!day.isTradingDay) return "closed";
  const t = at.getTime();
  const pre = nyInstant(date, 4, 0).getTime();
  const open = new Date(day.regularOpen!).getTime();
  const close = new Date(day.regularClose!).getTime();
  const post = nyInstant(date, 20, 0).getTime();
  if (t < pre) return "closed";
  if (t < open) return "pre";
  if (t < close) return "regular";
  if (t < post) return "post";
  return "closed";
}

export function minutesToClose(at: Date): number | null {
  const day = marketCalendarDay(newYorkDate(at));
  if (!day.isTradingDay || !day.regularClose) return null;
  return Math.round((new Date(day.regularClose).getTime() - at.getTime()) / 60_000);
}

/** Previous N trading days (YYYY-MM-DD) strictly before `date`. */
export function previousTradingDays(date: string, n: number): string[] {
  const out: string[] = [];
  let cursor = new Date(`${date}T12:00:00Z`);
  while (out.length < n) {
    cursor = new Date(cursor.getTime() - 86_400_000);
    const k = cursor.toISOString().slice(0, 10);
    if (marketCalendarDay(k).isTradingDay) out.push(k);
  }
  return out;
}

export function isWithinTradingWindow(at: Date, window: { start: string; end: string; timezone: string }): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: window.timezone, hour12: false, hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const cur = (Number(parts["hour"]) % 24) * 60 + Number(parts["minute"]);
  const [sh, sm] = window.start.split(":").map(Number) as [number, number];
  const [eh, em] = window.end.split(":").map(Number) as [number, number];
  return cur >= sh * 60 + sm && cur <= eh * 60 + em;
}
