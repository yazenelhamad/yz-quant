import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelIntelligenceProfile } from "@yz/core";
import { listPromptVersions, type ModelRole } from "@yz/intelligence";
import type { AppContext } from "../http/app.js";
import { validation } from "../http/errors.js";
import { service } from "../services/registry.js";
import type { LearningService } from "../services/learning/service.js";
import type { ResearchService } from "../services/research/index.js";

const ModelsPut = z.object({ models: z.array(z.object({ name: z.string().min(1), enabled: z.boolean().optional(), routingWeight: z.number().min(0).max(2).optional() })).max(50) });
const AgentsPut = z.object({ agents: z.array(z.object({ name: z.string().min(1), enabled: z.boolean().optional(), influenceWeight: z.number().min(0).max(2).optional() })).max(50) });

export const AGENT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  market_regime: "Classifies the market regime and which strategy families it favours.",
  quant: "Reads the quantitative signals and features for a candidate.",
  market_structure: "Assesses liquidity, positioning and microstructure.",
  fundamental: "Assesses earnings quality, valuation and revisions.",
  news: "Interprets news as data: what changed, is it genuinely new, is it priced in.",
  portfolio_manager: "Per-user portfolio fit and sizing view (never a risk decision).",
  execution: "Order type, urgency and staging advice.",
  devils_advocate: "Argues against the trade; can recommend reject or wait.",
  research: "Proposes experiments and strategy changes for the validation pipeline.",
  thesis_writer: "Writes the structured trade thesis.",
  post_trade_narrator: "Narrates the deterministic post-trade review.",
  fast_verify: "Advisory verification of unusual fast-brain situations.",
});

export async function registerAdminModelRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { env, guards, audit } = ctx;
  const learning = () => service<LearningService>(ctx, "learning");
  const modelClient = () => { try { return service<ResearchService>(ctx, "research").modelClient; } catch { return null; } };
  const roleModels = (): Record<ModelRole, string> => ({ slow_brain: env.MODEL_SLOW_BRAIN, research: env.MODEL_RESEARCH, fast: env.MODEL_FAST });

  const ensureModels = async () => {
    const lr = learning().lr;
    const existing = await lr.modelRegistry.all();
    for (const [role, name] of Object.entries(roleModels())) {
      if (!existing.some((m) => m.name === name && m.role === role)) await lr.modelRegistry.upsert({ name, version: name, provider: "anthropic", role, enabled: true, routingWeight: 1, costPerMTokIn: null, costPerMTokOut: null });
    }
    return lr.modelRegistry.all();
  };
  const ensureAgents = async () => {
    const lr = learning().lr;
    const existing = new Set((await lr.agentRegistry.all()).map((a) => a.name));
    for (const e of listPromptVersions()) {
      if (!existing.has(e.agent)) await lr.agentRegistry.upsert({ name: e.agent, description: AGENT_DESCRIPTIONS[e.agent] ?? e.agent, enabled: true, influenceWeight: 1, promptVersion: e.promptVersion, modelRole: e.role });
    }
    return lr.agentRegistry.all();
  };

  const modelsView = async () => {
    const rows = await ensureModels();
    const configured = learning().modelsConfigured || (modelClient()?.configured ?? false);
    const profiles = (await learning().lr.modelProfiles.all()).map((r) => r.profile as ModelIntelligenceProfile);
    return {
      configured,
      note: configured ? null : "AI models: not configured (ANTHROPIC_API_KEY is absent)",
      models: rows.map((m) => {
        const p = profiles.find((x) => x.modelName === m.name);
        return { name: m.name, provider: m.provider, version: m.version, role: m.role, enabled: m.enabled, configured, routingWeight: m.routingWeight, costPer1kTokensUsd: m.costPerMTokIn == null ? null : m.costPerMTokIn / 1000, latencyMsP50: p?.latencyMsP50 ?? null, failureRate: p?.failureRate ?? null, accuracy: p?.accuracy ?? null, valueAdded: p?.valueAdded ?? null };
      }),
    };
  };
  const agentsView = async () => {
    const rows = await ensureAgents();
    const models = roleModels();
    return { agents: rows.map((a) => ({ name: a.name, description: a.description, enabled: a.enabled, influenceWeight: a.influenceWeight, model: models[a.modelRole as ModelRole] ?? a.modelRole, modelRole: a.modelRole, promptVersion: a.promptVersion })) };
  };

  app.get("/api/admin/models", async (req) => { guards.requireRole(req, "admin"); return modelsView(); });
  app.put("/api/admin/models", async (req) => {
    guards.requireRole(req, "admin");
    const body = ModelsPut.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    await ensureModels();
    const lr = learning().lr;
    for (const m of body.data.models) {
      const n = await lr.modelRegistry.update(m.name, { ...(m.enabled !== undefined ? { enabled: m.enabled } : {}), ...(m.routingWeight !== undefined ? { routingWeight: m.routingWeight } : {}) });
      if (n === 0) throw validation(`Unknown model ${m.name}`);
    }
    await audit.record({ category: "model", action: "model_registry_changed", result: "ok", detail: { models: body.data.models } }, req);
    return modelsView();
  });

  app.get("/api/admin/agents", async (req) => { guards.requireRole(req, "admin"); return agentsView(); });
  app.put("/api/admin/agents", async (req) => {
    guards.requireRole(req, "admin");
    const body = AgentsPut.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload", body.error.flatten());
    await ensureAgents();
    const lr = learning().lr;
    for (const a of body.data.agents) {
      const n = await lr.agentRegistry.update(a.name, { ...(a.enabled !== undefined ? { enabled: a.enabled } : {}), ...(a.influenceWeight !== undefined ? { influenceWeight: a.influenceWeight } : {}) });
      if (n === 0) throw validation(`Unknown agent ${a.name}`);
    }
    await audit.record({ category: "model", action: "agent_registry_changed", result: "ok", detail: { agents: body.data.agents } }, req);
    return agentsView();
  });
}
