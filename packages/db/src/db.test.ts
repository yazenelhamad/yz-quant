import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDatabase, type DatabaseHandle } from "./connection.js";
import { BrokerAccountsRepository, OrdersRepository, TradesRepository, UsersRepository, RiskSettingsRepository, InvalidTransitionError } from "./repositories/index.js";
import { CrossTenantError } from "@yz/core";

let h: DatabaseHandle;
beforeAll(async () => { h = await createDatabase("pglite://memory"); await h.migrate(); });
afterAll(async () => { await h.close(); });

describe("database + tenant isolation", () => {
  it("migrates and enforces scope on trading tables", async () => {
    const users = new UsersRepository(h.db);
    const accounts = new BrokerAccountsRepository(h.db);
    const orders = new OrdersRepository(h.db);
    const a = await users.create({ email: "a@example.com", displayName: "A", role: "trader", passwordHash: "x" });
    const b = await users.create({ email: "b@example.com", displayName: "B", role: "trader", passwordHash: "x" });
    const accA = await accounts.create({ userId: a.id, kind: "simulated", label: "A", accountNumber: "SIM-A" });
    const accB = await accounts.create({ userId: b.id, kind: "simulated", label: "B", accountNumber: "SIM-B" });
    const scopeA = { userId: a.id, brokerAccountId: accA.id };
    const scopeB = { userId: b.id, brokerAccountId: accB.id };

    const o = await orders.create(scopeA, { refId: "ref-1", accountNumber: "SIM-A", symbol: "AAPL", side: "buy", type: "limit", quantity: 1, limitPrice: 100, mode: "shadow" });
    expect(await orders.byId(scopeA, o.id)).toBeTruthy();
    expect(await orders.byId(scopeB, o.id)).toBeUndefined();
    expect(await orders.byRefId(scopeB, "ref-1")).toBeUndefined();
    // B cannot resolve A's account
    expect(await accounts.forScope({ userId: b.id, brokerAccountId: accA.id })).toBeUndefined();
    // stamping a row with the wrong scope throws
    await expect(orders.create(scopeB, { userId: a.id, refId: "ref-2", accountNumber: "SIM-A", symbol: "AAPL", side: "buy", type: "market", mode: "shadow" } as never)).rejects.toBeInstanceOf(CrossTenantError);
    // risk settings are per account
    const rs = new RiskSettingsRepository(h.db);
    await rs.set(scopeA, { ...(await rs.get(scopeA)), maxDailyLossPct: 0.005 }, a.id);
    expect((await rs.get(scopeA)).maxDailyLossPct).toBe(0.005);
    expect((await rs.get(scopeB)).maxDailyLossPct).toBe(0.02);
  });

  it("enforces the trade lifecycle state machine", async () => {
    const users = new UsersRepository(h.db);
    const accounts = new BrokerAccountsRepository(h.db);
    const trades = new TradesRepository(h.db);
    const u = await users.create({ email: "c@example.com", displayName: "C", role: "trader", passwordHash: "x" });
    const acc = await accounts.create({ userId: u.id, kind: "simulated", label: "C", accountNumber: "SIM-C" });
    const scope = { userId: u.id, brokerAccountId: acc.id };
    const t = await trades.create(scope, { mode: "shadow", symbol: "MSFT", strategyId: "s", initialConfidence: 0.7, expectedEdge: 0.3, expectedDownsidePct: 3, regimeAtEntry: "bull_trend" });
    await trades.transition(scope, t.id, "analyzing", "test");
    await expect(trades.transition(scope, t.id, "closed", "illegal")).rejects.toBeInstanceOf(InvalidTransitionError);
    await trades.transition(scope, t.id, "approved", "ok");
    expect((await trades.events(scope, t.id)).map((e) => e.toState)).toEqual(["candidate", "analyzing", "approved"]);
  });
});
