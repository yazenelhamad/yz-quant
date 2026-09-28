import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { buildRepos } from "../http/app.js";
import { Scheduler } from "./scheduler.js";

let h: DatabaseHandle;
beforeAll(async () => { h = await createDatabase("pglite://memory"); await h.migrate(); });
afterAll(async () => { await h.close(); });

describe("scheduler", () => {
  it("runs per-account jobs concurrently across accounts but serialised per account", async () => {
    const repos = buildRepos(h);
    const scopes = [{ userId: "a", brokerAccountId: "1" }, { userId: "b", brokerAccountId: "2" }];
    const s = new Scheduler(repos, { info() {}, warn() {}, error() {} }, async () => scopes);
    let concurrent = 0; let maxConcurrent = 0; const perScope: Record<string, number> = {};
    const job = {
      name: "cycle", everyMs: 60_000, kind: "per_account" as const,
      run: async ({ scope }: { scope: { userId: string } | null }) => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        perScope[scope!.userId] = (perScope[scope!.userId] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return { ok: true };
      },
    };
    await Promise.all([s.dispatch(job), s.dispatch(job)]); // second dispatch overlaps: per-scope dedupe
    expect(maxConcurrent).toBe(2);
    expect(perScope).toEqual({ a: 1, b: 1 });
    const runs = await repos.jobs.recent(10);
    expect(runs.filter((r) => r.name === "cycle" && r.status === "ok")).toHaveLength(2);
    s.stop();
  });

  it("records failures without throwing", async () => {
    const repos = buildRepos(h);
    const s = new Scheduler(repos, { info() {}, warn() {}, error() {} }, async () => []);
    await s.runOne({ name: "boom", everyMs: 1000, kind: "global", run: async () => { throw new Error("kaboom"); } }, null);
    expect(s.status()["boom:global"]?.ok).toBe(false);
    const runs = await repos.jobs.recent(10);
    expect(runs.find((r) => r.name === "boom")?.error).toBe("kaboom");
    s.stop();
  });
});
