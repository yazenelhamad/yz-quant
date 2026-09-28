import { describe, expect, it } from "vitest";
import { DEFAULT_UNIVERSE, selectDiscovered } from "./universe.js";

describe("selectDiscovered", () => {
  it("keeps only valid US instruments not already in the universe, capped per list and overall", () => {
    const lists = [
      { name: "100 Most Popular", items: [{ symbol: "AAPL", objectType: "instrument" }, { symbol: "PLTR", objectType: "instrument" }, { symbol: "BTC-USD", objectType: "currency_pair" }, { symbol: "pltr", objectType: "instrument" }, { symbol: "SOFI", objectType: "instrument" }, { symbol: "", objectType: "instrument" }] },
      { name: "Daily Movers", items: [{ symbol: "RIVN", objectType: "instrument" }, { symbol: "SOFI", objectType: "instrument" }, { symbol: "ES=F", objectType: "futures" }] },
    ];
    expect(selectDiscovered(lists, DEFAULT_UNIVERSE)).toEqual([{ symbol: "PLTR", list: "100 Most Popular" }, { symbol: "SOFI", list: "100 Most Popular" }, { symbol: "RIVN", list: "Daily Movers" }]);
    expect(selectDiscovered(lists, DEFAULT_UNIVERSE, 2)).toHaveLength(2);
    expect(selectDiscovered(lists, DEFAULT_UNIVERSE, 10, 1).map((d) => d.symbol)).toEqual(["PLTR", "RIVN"]);
    expect(selectDiscovered([], DEFAULT_UNIVERSE)).toEqual([]);
  });
});
