import { describe, expect, it } from "vitest";
import { bookPnl, dayPnlPct } from "./pnl.js";

describe("bookPnl (shared by the live and shadow books)", () => {
  it("marks open positions, splits carried and today's shares for the day, and totals realised + unrealised", () => {
    const r = bookPnl({
      positions: [
        { symbol: "OLD", quantity: 10, averageCost: 100, mark: 105, previousClose: 102, openedTodayQuantity: 0 },
        { symbol: "NEW", quantity: 5, averageCost: 50, mark: 52, previousClose: 49, openedTodayQuantity: 5 },
        // 8 carried at prev close 20, 2 bought today at 21
        { symbol: "MIX", quantity: 10, averageCost: 19, mark: 22, previousClose: 20, openedTodayQuantity: 2, openedTodayCost: 21 },
      ],
      exitsToday: [{ symbol: "SOLD", quantity: 4, exitPrice: 30, base: 31, fees: 0.5 }],
      realizedToDate: -62.14,
    });
    expect(r.unrealized).toBeCloseTo(10 * 5 + 5 * 2 + 10 * 3, 2); // 90
    expect(r.day).toBeCloseTo(10 * 3 + 5 * 2 + (8 * 2 + 2 * 1) + (4 * -1 - 0.5), 2); // 53.5
    expect(r.total).toBeCloseTo(-62.14 + 90, 2);
    expect(r.missing).toEqual([]);
  });

  it("reports an unknown day, never a guessed one, when a previous close or mark is missing", () => {
    const r = bookPnl({ positions: [{ symbol: "X", quantity: 1, averageCost: 10, mark: 11, previousClose: null, openedTodayQuantity: 0 }], exitsToday: [], realizedToDate: 0 });
    expect(r.day).toBeNull();
    expect(r.missing).toEqual(["X"]);
    expect(r.unrealized).toBeCloseTo(1, 2);
    // shares bought today need no previous close
    expect(bookPnl({ positions: [{ symbol: "Y", quantity: 1, averageCost: 10, mark: 11, previousClose: null, openedTodayQuantity: 1 }], exitsToday: [], realizedToDate: 0 }).day).toBeCloseTo(1, 2);
  });

  it("is deposit-proof: cash does not enter it, and the day percentage is against the start-of-day value", () => {
    expect(bookPnl({ positions: [], exitsToday: [], realizedToDate: 0 })).toMatchObject({ unrealized: 0, day: 0, total: 0 });
    expect(dayPnlPct(100, 10_100)).toBeCloseTo(0.01, 6);
    expect(dayPnlPct(null, 10_000)).toBeNull();
  });
});
