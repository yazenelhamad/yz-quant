import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AutonomyLevelSchema, RiskSettingsSchema } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { conflict, validation } from "../http/errors.js";
import { buildAccountSummary } from "../services/accountSummary.js";

const CreateAccountSchema = z.object({ kind: z.enum(["robinhood_agentic", "simulated"]), label: z.string().min(1).max(80) });
const AutonomySchema = z.object({ level: AutonomyLevelSchema });
const PauseSchema = z.object({ paused: z.boolean(), reason: z.string().max(300).optional() });
const KillSchema = z.object({ active: z.boolean(), note: z.string().max(500).optional() });

export async function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards, audit } = ctx;

  app.get("/api/accounts", async (req) => {
    const { user } = guards.requireAuth(req);
    const mine = await repos.accounts.listForUser(user.id);
    const accounts = await Promise.all(mine.map((a) => buildAccountSummary(repos, a, user)));
    if (user.role !== "admin") return { accounts };
    const all = await repos.accounts.listAll();
    const users = new Map((await repos.users.list()).map((u) => [u.id, u]));
    const allAccounts = await Promise.all(all.map((a) => buildAccountSummary(repos, a, users.get(a.userId))));
    return { accounts, allAccounts };
  });

  app.get("/api/accounts/:accountId", async (req) => {
    const { account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    return buildAccountSummary(repos, account, await repos.users.byId(account.userId));
  });

  app.post("/api/accounts", async (req) => {
    const { user } = guards.requireStepUp(req);
    const body = CreateAccountSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    const existing = await repos.accounts.listForUser(user.id);
    if (body.data.kind === "robinhood_agentic" && existing.some((a) => a.kind === "robinhood_agentic")) {
      throw conflict("You already have a Robinhood Agentic account record; connect it from Settings");
    }
    const account = await repos.accounts.create({
      userId: user.id,
      kind: body.data.kind,
      label: body.data.kind === "simulated" ? `${body.data.label} (SIMULATED)` : body.data.label,
      accountNumber: body.data.kind === "simulated" ? `SIM-${crypto.randomUUID().slice(0, 8)}` : `pending-${crypto.randomUUID().slice(0, 8)}`,
      status: body.data.kind === "simulated" ? "connected" : "not_connected",
      statusDetail: body.data.kind === "simulated" ? "Simulated account for shadow research. No real money." : "Connect your Robinhood Agentic account from Settings",
      agenticAllowed: body.data.kind === "simulated",
      accountType: body.data.kind === "simulated" ? "limited_margin" : "unknown",
    });
    await audit.record({ category: "settings", action: "account_created", result: "ok", brokerAccountId: account.id, detail: { kind: account.kind } }, req);
    return buildAccountSummary(repos, account, user);
  });

  app.post("/api/accounts/:accountId/autonomy", async (req) => {
    guards.requireStepUp(req);
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    const body = AutonomySchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid autonomy level");
    if ((body.data.level === "semi_autonomous" || body.data.level === "fully_autonomous" || body.data.level === "manual_approval") && account.kind === "robinhood_agentic" && account.status !== "connected") {
      throw conflict("Connect the Robinhood account before enabling live autonomy levels");
    }
    await repos.accounts.update(scope, { autonomyLevel: body.data.level });
    await audit.record({ category: "autonomy", action: "autonomy_changed", result: "ok", brokerAccountId: scope.brokerAccountId, detail: { from: account.autonomyLevel, to: body.data.level } }, req);
    const updated = (await repos.accounts.forScope(scope))!;
    return buildAccountSummary(repos, updated, await repos.users.byId(scope.userId));
  });

  app.post("/api/accounts/:accountId/pause", async (req) => {
    const body = PauseSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload");
    if (!body.data.paused) guards.requireStepUp(req); // resuming is the sensitive direction
    const { scope, account } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    await repos.accounts.update(scope, { tradingPaused: body.data.paused, pausedReason: body.data.paused ? (body.data.reason ?? "Paused by user") : null });
    await audit.record({ category: "settings", action: body.data.paused ? "trading_paused" : "trading_resumed", result: "ok", brokerAccountId: scope.brokerAccountId, detail: { reason: body.data.reason ?? null, previous: account.tradingPaused } }, req);
    const updated = (await repos.accounts.forScope(scope))!;
    return buildAccountSummary(repos, updated, await repos.users.byId(scope.userId));
  });

  app.get("/api/accounts/:accountId/risk-settings", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    return repos.riskSettings.get(scope);
  });

  app.put("/api/accounts/:accountId/risk-settings", async (req) => {
    const { user } = guards.requireStepUp(req);
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    const body = RiskSettingsSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid risk settings", body.error.flatten());
    const before = await repos.riskSettings.get(scope);
    const after = await repos.riskSettings.set(scope, body.data, user.id);
    await audit.record({ category: "risk", action: "risk_settings_changed", result: "ok", brokerAccountId: scope.brokerAccountId, detail: { before, after } }, req);
    return after;
  });

  app.get("/api/accounts/:accountId/kill-switch", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const ks = await repos.killSwitches.get(scope);
    return { active: !!ks?.active, reasons: ks?.reasons ?? [], allowRiskReducingExits: ks?.allowRiskReducingExits ?? true, triggeredAt: ks?.triggeredAt ?? null, triggeredBy: ks?.triggeredBy ?? null, note: ks?.note ?? null };
  });

  app.post("/api/accounts/:accountId/kill-switch", async (req) => {
    const body = KillSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload");
    const { user } = body.data.active ? guards.requireAuth(req) : guards.requireStepUp(req);
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    if (body.data.active) {
      await repos.killSwitches.trigger(scope, ["manual"], user.id, body.data.note ?? null, true);
      await audit.record({ category: "kill_switch", action: "triggered", result: "ok", brokerAccountId: scope.brokerAccountId, detail: { reasons: ["manual"], note: body.data.note ?? null } }, req);
    } else {
      await repos.killSwitches.release(scope, user.id);
      await audit.record({ category: "kill_switch", action: "released", result: "ok", brokerAccountId: scope.brokerAccountId }, req);
    }
    const ks = await repos.killSwitches.get(scope);
    return { active: !!ks?.active, reasons: ks?.reasons ?? [], allowRiskReducingExits: ks?.allowRiskReducingExits ?? true, triggeredAt: ks?.triggeredAt ?? null, triggeredBy: ks?.triggeredBy ?? null, note: ks?.note ?? null };
  });
}
