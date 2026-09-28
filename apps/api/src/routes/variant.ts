import type { FastifyInstance } from "fastify";
import type { AppContext } from "../http/app.js";
import { validation } from "../http/errors.js";
import { service } from "../services/registry.js";
import { pctFieldsToFractions } from "../services/learning/units.js";
import type { ResearchService } from "../services/research/index.js";

const TICKER = /^[A-Za-z.\-]{1,12}$/;

export async function registerVariantRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { guards, audit } = ctx;
  const research = () => service<ResearchService>(ctx, "research");

  app.get("/api/variant/:ticker", async (req) => {
    guards.requireAuth(req);
    const ticker = (req.params as { ticker: string }).ticker;
    if (!TICKER.test(ticker)) throw validation("Invalid ticker");
    const snap = await research().variant(ticker);
    return { ...pctFieldsToFractions(snap), modelsConfigured: research().modelClient.configured };
  });

  app.post("/api/variant/:ticker/run", async (req, reply) => {
    const { user } = guards.requireAuth(req);
    const ticker = (req.params as { ticker: string }).ticker;
    if (!TICKER.test(ticker)) throw validation("Invalid ticker");
    const result = await research().runVariant(ticker, user.id);
    if (!result.ok) {
      reply.status(503);
      return { ok: false, error: { code: result.error, message: result.error === "not_configured" ? "AI models not configured" : result.message, stage: result.stage } };
    }
    await audit.record({ category: "model", action: "variant_run_requested", result: "ok", detail: { ticker: ticker.toUpperCase(), viewId: result.viewId } }, req);
    return { ok: true, viewId: result.viewId, notes: result.notes, view: pctFieldsToFractions(result.view) };
  });
}
