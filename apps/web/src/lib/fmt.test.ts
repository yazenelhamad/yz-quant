import { describe, expect, it } from "vitest";
import { fmt } from "./fmt";

describe("fmt", () => {
  it("renders missing numbers as an em dash, never zero", () => {
    expect(fmt.money(null)).toBe("—");
    expect(fmt.pct(undefined)).toBe("—");
    expect(fmt.num(Number.NaN)).toBe("—");
  });
  it("formats money with a true minus sign", () => {
    expect(fmt.money(-1234.5)).toBe("−$1,234.50");
    expect(fmt.money(1234.5, { signed: true })).toBe("+$1,234.50");
  });
  it("treats pct fields as fractions", () => {
    expect(fmt.pct(0.0123)).toBe("1.23%");
    expect(fmt.pct(-0.05, { digits: 1 })).toBe("−5.0%");
  });
  it("signs edges", () => {
    expect(fmt.signed(0.49)).toBe("+0.49");
    expect(fmt.signed(-0.2)).toBe("−0.20");
    expect(fmt.signClass(-1)).toBe("neg");
  });
});
