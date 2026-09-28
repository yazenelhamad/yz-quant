import type { FastifyInstance } from "fastify";
import type { SurvivalState } from "@yz/core";
import type { AppContext } from "../http/app.js";
import { service } from "../services/registry.js";
import { loadSurvival, refreshSurvival, stateFromRow, strategyFitnessForScope } from "../services/survival/service.js";
import type { TradingService } from "../services/trading/index.js";

/**
 * Survival mandate ("earn or die") for one account: the current state, its history and the
 * Darwinian fitness of every enabled strategy. Read is scoped; refresh is a write.
 */
export async function registerSurvivalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;
  const trading = () => service<TradingService>(ctx, "trading");

  const view = async (scope: { userId: string; brokerAccountId: string }, state: SurvivalState | null, now: Date) => {
    const [historyRows, fitness] = await Promise.all([repos.survival.history(scope, 60), strategyFitnessForScope(repos, scope, now)]);
    const history = historyRows.map((r) => ({ computedAt: r.computedAt, mode: r.mode, fitnessScore: r.fitnessScore, riskMultiplier: r.riskMultiplier, runwayDays: r.runwayDays, alphaPct: r.alphaPct })).reverse();
    return { state, history, strategies: fitness.fitness, allocations: fitness.allocations };
  };

  app.get("/api/accounts/:accountId/survival", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    const now = new Date();
    let state = stateFromRow(await repos.survival.latest(scope));
    if (!state) {
      // First look at this account: compute it from the account context (scoped), never invent a mode.
      const acct = await trading().accountContext(scope).catch(() => null);
      state = acct ? acct.survival : null;
    }
    return view(scope, state, now);
  });

  app.post("/api/accounts/:accountId/survival/refresh", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "write");
    const now = new Date();
    const acct = await trading().accountContext(scope);
    if (!acct) return view(scope, null, now);
    const state = await refreshSurvival(trading().runtime, { scope, settings: acct.settings, now, portfolio: acct.portfolio });
    return view(scope, state, now);
  });

  // Keep the imported helper referenced for callers that need a cheap read-or-refresh.
  void loadSurvival;
}
