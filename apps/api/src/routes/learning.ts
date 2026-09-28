import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http/app.js";
import { service } from "../services/registry.js";
import type { LearningService } from "../services/learning/service.js";
import { registerAdminModelRoutes } from "./adminModels.js";
import { registerBacktestRoutes } from "./backtests.js";
import { registerResearchRoutes } from "./research.js";
import { registerStrategyRoutes } from "./strategies.js";
import { registerVariantRoutes } from "./variant.js";

export async function registerLearningViewRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards } = ctx;
  const learning = () => service<LearningService>(ctx, "learning");

  app.get("/api/learning", async (req) => {
    const { user } = guards.requireAuth(req);
    const accounts = user.role === "admin" ? await repos.accounts.listAll() : await repos.accounts.listForUser(user.id);
    return learning().learningView(null, accounts.map((a) => ({ userId: a.userId, brokerAccountId: a.id })));
  });

  app.get("/api/accounts/:accountId/learning", async (req) => {
    const { scope } = await guards.resolveScope(req, (req.params as { accountId: string }).accountId, "read");
    return learning().learningView(scope, [scope]);
  });
}

/** Registers every route of the learning & research plane. */
export async function registerLearningRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await registerLearningViewRoutes(app, ctx);
  await registerStrategyRoutes(app, ctx);
  await registerResearchRoutes(app, ctx);
  await registerBacktestRoutes(app, ctx);
  await registerVariantRoutes(app, ctx);
  await registerAdminModelRoutes(app, ctx);
}
