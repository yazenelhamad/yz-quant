import { describe, expect, it } from "vitest";
import { listPromptVersions, promptVersionFor } from "./registry.js";

describe("prompt registry", () => {
  it("lists a unique versioned prompt and role for every agent", () => {
    const entries = listPromptVersions();
    const agents = entries.map((e) => e.agent);
    expect(new Set(agents).size).toBe(agents.length);
    expect(agents).toEqual(expect.arrayContaining(["market_regime", "quant", "market_structure", "fundamental", "news", "portfolio_manager", "execution", "devils_advocate", "research", "thesis_writer", "post_trade_narrator", "fast_verify"]));
    for (const e of entries) {
      expect(e.promptVersion).toMatch(/^[a-z_]+\.v\d+$/);
      expect(["slow_brain", "research", "fast"]).toContain(e.role);
    }
    expect(promptVersionFor("quant")).toEqual({ agent: "quant", promptVersion: "quant.v1", role: "slow_brain" });
    expect(promptVersionFor("red_team")).toBeNull();
  });
});
