/**
 * Book P&L, one method for every book (the live broker account and the shadow book), so the two
 * are always comparable:
 *
 * - unrealised: open positions marked to live quotes, net of their average cost;
 * - day: positions carried from before today move from the previous close, shares bought today
 *   from their own cost, and positions closed today add their exit against the same base, net of
 *   fees. It depends only on prices and positions, so deposits, withdrawals and restarts never
 *   show up as profit or loss;
 * - total: realised P&L to date plus unrealised.
 *
 * The trading day is the New York session day. A day P&L that needs a previous close the quote
 * feed did not supply is reported as null (unknown), never guessed.
 */
export interface PnlPosition {
  symbol: string;
  quantity: number;
  averageCost: number | null;
  mark: number | null;
  previousClose: number | null;
  /** Shares of `quantity` bought today (the rest were carried from before today). */
  openedTodayQuantity: number;
  /** Average cost of the shares bought today; falls back to averageCost. */
  openedTodayCost?: number | null;
}

export interface PnlExit {
  symbol: string;
  quantity: number;
  exitPrice: number | null;
  /** Previous close when the shares were held from before today, otherwise their entry price. */
  base: number | null;
  fees: number;
}

export interface BookPnlInput {
  positions: readonly PnlPosition[];
  /** Positions (or parts) closed today. */
  exitsToday: readonly PnlExit[];
  /** Realised P&L of every closed trade to date, net of fees. */
  realizedToDate: number;
}

export interface BookPnl {
  unrealized: number;
  day: number | null;
  total: number;
  realized: number;
  /** Symbols whose day P&L could not be computed (no mark or no previous close). */
  missing: string[];
}

function fin(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function bookPnl(input: BookPnlInput): BookPnl {
  let unrealized = 0;
  let day = 0;
  const missing: string[] = [];
  for (const p of input.positions) {
    if (!(p.quantity > 0)) continue;
    if (fin(p.mark) && fin(p.averageCost)) unrealized += (p.mark - p.averageCost) * p.quantity;
    if (!fin(p.mark)) { missing.push(p.symbol); continue; }
    const today = Math.min(Math.max(0, p.openedTodayQuantity), p.quantity);
    const carried = p.quantity - today;
    if (carried > 0) {
      if (!fin(p.previousClose) || !(p.previousClose > 0)) { missing.push(p.symbol); continue; }
      day += (p.mark - p.previousClose) * carried;
    }
    if (today > 0) {
      const cost = fin(p.openedTodayCost) ? p.openedTodayCost : p.averageCost;
      if (!fin(cost)) { missing.push(p.symbol); continue; }
      day += (p.mark - cost) * today;
    }
  }
  for (const e of input.exitsToday) {
    if (!fin(e.exitPrice) || !fin(e.base) || !(e.base > 0) || !(e.quantity > 0)) { missing.push(e.symbol); continue; }
    day += (e.exitPrice - e.base) * e.quantity - (fin(e.fees) ? e.fees : 0);
  }
  const realized = fin(input.realizedToDate) ? input.realizedToDate : 0;
  return {
    unrealized: round2(unrealized),
    day: missing.length > 0 ? null : round2(day),
    total: round2(realized + unrealized),
    realized: round2(realized),
    missing: [...new Set(missing)],
  };
}

/** Day P&L as a fraction of the book's value at the start of the day. */
export function dayPnlPct(day: number | null, bookValue: number | null): number | null {
  if (!fin(day) || !fin(bookValue)) return null;
  const start = bookValue - day;
  return start > 0 ? day / start : null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
