import { useEffect, useState } from "react";

export type MarketSession = "pre" | "regular" | "post" | "closed";

const NY = "America/New_York";
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" });
const tzFmt = new Intl.DateTimeFormat("en-US", { timeZone: NY, timeZoneName: "short" });

export interface ClockReading {
  /** "HH:MM:SS" in New York. */
  time: string;
  /** "EDT" / "EST". */
  tz: string;
  weekday: string;
  /** Estimated from weekday + wall clock only. No holiday calendar. */
  session: MarketSession;
}

/**
 * Session estimate from the New York wall clock and weekday: pre 04:00–09:30, regular 09:30–16:00,
 * post 16:00–20:00, closed otherwise and all weekend. Holidays and early closes are NOT modelled,
 * which is why the UI labels this an estimate.
 */
export function readClock(now = new Date()): ClockReading {
  const parts = partsFmt.formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(get("hour")) % 24;
  const m = Number(get("minute"));
  const weekday = get("weekday");
  const minutes = h * 60 + m;
  const weekend = weekday === "Sat" || weekday === "Sun";
  let session: MarketSession = "closed";
  if (!weekend) {
    if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) session = "pre";
    else if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) session = "regular";
    else if (minutes >= 16 * 60 && minutes < 20 * 60) session = "post";
  }
  const tz = tzFmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "ET";
  return { time: `${String(h).padStart(2, "0")}:${get("minute")}:${get("second")}`, tz, weekday, session };
}

export function useMarketClock(): ClockReading {
  const [c, setC] = useState(() => readClock());
  useEffect(() => {
    const id = window.setInterval(() => setC(readClock()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return c;
}

export const SESSION_LABEL: Record<MarketSession, string> = { pre: "Pre-market", regular: "Regular", post: "After hours", closed: "Closed" };
