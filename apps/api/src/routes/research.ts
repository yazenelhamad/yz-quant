import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExperimentRow } from "@yz/db";
import type { AppContext } from "../http/app.js";
import { notFound, validation } from "../http/errors.js";
import { service } from "../services/registry.js";
import type { ResearchService } from "../services/research/index.js";

const CreateSchema = z.object({
  title: z.string().min(3).max(200),
  hypothesis: z.string().min(3).max(4000),
  strategyKey: z.string().max(100).nullable().optional(),
  kind: z.enum(["strategy_proposal", "ablation", "sensitivity", "regime", "overfitting", "mistake_analysis"]).default("strategy_proposal"),
  method: z.string().max(4000).optional(),
  design: z.record(z.unknown()).optional(),
});
const UpdateSchema = z.object({
  status: z.enum(["proposed", "running", "completed", "abandoned"]).optional(),
  conclusion: z.string().max(4000).nullable().optional(),
  recommendation: z.string().max(4000).nullable().optional(),
  results: z.record(z.unknown()).nullable().optional(),
  linkedBacktestIds: z.array(z.string()).max(50).optional(),
});

function parseProposedBy(v: string, users: Map<string, string>) {
  const [kind, id] = v.includes(":") ? (v.split(":", 2) as [string, string]) : ["human", v];
  return { kind, id, displayName: users.get(id) ?? null };
}

export function experimentView(row: ExperimentRow, users: Map<string, string>) {
  const design = (row.design ?? {}) as { method?: string };
  return {
    id: row.id, title: row.title, hypothesis: row.hypothesis, kind: row.kind, strategyKey: row.linkedStrategyId, status: row.status, method: design.method ?? null, design: row.design,
    results: row.results, conclusion: row.conclusion, recommendation: row.recommendation, linkedBacktestIds: row.linkedBacktestIds,
    createdBy: parseProposedBy(row.proposedBy, users), proposedBy: row.proposedBy, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export async function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, guards, audit } = ctx;
  const research = () => service<ResearchService>(ctx, "research");
  const userNames = async () => new Map((await repos.users.list()).map((u) => [u.id, u.displayName]));

  app.get("/api/research/experiments", async (req) => {
    guards.requireAuth(req);
    const users = await userNames();
    return { experiments: (await research().lr.experiments.list(200)).map((r) => experimentView(r, users)) };
  });

  app.post("/api/research/experiments", async (req) => {
    const { user } = guards.requireRole(req, "admin");
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid experiment", body.error.flatten());
    const lr = research().lr;
    if (body.data.strategyKey && !(await lr.catalog.byKey(body.data.strategyKey))) throw validation(`Unknown strategy ${body.data.strategyKey}`);
    const row = await lr.experiments.create({
      title: body.data.title, hypothesis: body.data.hypothesis, kind: body.data.kind, status: "proposed", proposedBy: `human:${user.id}`,
      design: { ...(body.data.design ?? {}), method: body.data.method ?? null }, results: null, conclusion: null, recommendation: null, linkedStrategyId: body.data.strategyKey ?? null, linkedBacktestIds: [],
    });
    await audit.record({ category: "strategy", action: "experiment_created", result: "ok", detail: { experimentId: row.id, title: row.title } }, req);
    return experimentView(row, await userNames());
  });

  app.put("/api/research/experiments/:id", async (req) => {
    guards.requireRole(req, "admin");
    const body = UpdateSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid experiment update", body.error.flatten());
    const lr = research().lr;
    const id = (req.params as { id: string }).id;
    if (!(await lr.experiments.byId(id))) throw notFound("Experiment not found");
    await lr.experiments.update(id, body.data);
    await audit.record({ category: "strategy", action: "experiment_updated", result: "ok", detail: { experimentId: id, patch: body.data } }, req);
    return experimentView((await lr.experiments.byId(id))!, await userNames());
  });
}
