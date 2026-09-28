import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { notFound, validation } from "../http/errors.js";
import { service } from "../services/registry.js";
import { pctFieldsToFractions } from "../services/learning/units.js";
import { backtestResultView, backtestRunView, type ResearchService } from "../services/research/index.js";

const RunSchema = z.object({
  strategyKey: z.string().min(1).max(100),
  versionId: z.string().max(100).nullable().optional(),
  symbols: z.array(z.string().min(1).max(12)).min(1).max(25),
  start: z.string().datetime(),
  end: z.string().datetime(),
  kind: z.enum(["in_sample", "out_of_sample", "walk_forward", "monte_carlo"]).default("in_sample"),
});

export async function registerBacktestRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { guards, audit } = ctx;
  const research = () => service<ResearchService>(ctx, "research");

  app.get("/api/backtests", async (req) => {
    guards.requireAuth(req);
    const q = req.query as { strategyKey?: string; limit?: string };
    const rows = await research().lr.backtests.list({ strategyKey: q.strategyKey, limit: Math.min(200, Number(q.limit ?? 50)) });
    return { backtests: rows.map((r) => pctFieldsToFractions(backtestRunView(r, research().backtests.statusOf(r.id)))) };
  });

  app.get("/api/backtests/:id", async (req) => {
    guards.requireAuth(req);
    const row = await research().lr.backtests.byId((req.params as { id: string }).id);
    if (!row) throw notFound("Backtest not found");
    const v = backtestResultView(row);
    return {
      backtest: pctFieldsToFractions(backtestRunView(row, research().backtests.statusOf(row.id))),
      result: v.result ? pctFieldsToFractions(v.result) : null,
      walkForward: v.walkForward ? pctFieldsToFractions(v.walkForward) : null,
      monteCarlo: v.monteCarlo ? pctFieldsToFractions(v.monteCarlo) : null,
      outOfSample: v.outOfSample ? pctFieldsToFractions(v.outOfSample) : null,
    };
  });

  app.post("/api/backtests", async (req, reply) => {
    const { user } = guards.requireAuth(req);
    const body = RunSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid backtest request", body.error.flatten());
    if (Date.parse(body.data.start) >= Date.parse(body.data.end)) throw validation("start must be before end");
    const r = research();
    if (!r.backtests.strategyFor(body.data.strategyKey)) throw validation(`Unknown strategy ${body.data.strategyKey}`);
    if (body.data.versionId && !(await r.lr.catalog.versionById(body.data.versionId))) throw validation("Unknown strategy version");
    const queued = await r.backtests.enqueue({ strategyKey: body.data.strategyKey, versionId: body.data.versionId ?? null, symbols: body.data.symbols.map((s) => s.toUpperCase()), start: body.data.start, end: body.data.end, kind: body.data.kind, requestedBy: user.id });
    await audit.record({ category: "strategy", action: "backtest_requested", result: "ok", detail: { backtestId: queued.id, ...body.data } }, req);
    reply.status(202);
    return queued;
  });
}
