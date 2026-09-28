import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { HttpError, validation } from "../http/errors.js";
import { constantTimeEqual } from "../security/secrets.js";
import { PasswordPolicyError } from "../auth/password.js";
import { provisionUsers } from "../services/provisioning.js";

const SetupSchema = z.object({
  token: z.string().min(8).max(200),
  users: z.array(z.object({ email: z.string().email().max(200), displayName: z.string().min(1).max(80), role: z.enum(["admin", "trader"]), password: z.string().min(1).max(256) })).min(1).max(2),
});

/**
 * One-time first-run setup. This is NOT a signup route: it only works while the users table is
 * empty AND a SETUP_TOKEN was configured by the operator, and it disables itself permanently once
 * the first users exist. It lets a headless deployment (cloud-init) be finished from the browser.
 */
export async function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, env, audit } = ctx;
  const available = async () => !!env.SETUP_TOKEN && (await repos.users.count()) === 0;

  app.get("/api/setup", async () => ({ available: await available() }));

  app.post("/api/setup", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    if (!(await available())) throw new HttpError(410, "setup_closed", "Setup is closed: users already exist or no SETUP_TOKEN is configured");
    const body = SetupSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid setup payload", body.error.flatten());
    if (!constantTimeEqual(body.data.token, env.SETUP_TOKEN!)) {
      await audit.record({ category: "admin", action: "setup_rejected", result: "rejected", ip: req.ip ?? null });
      throw new HttpError(403, "forbidden", "Invalid setup token");
    }
    if (!body.data.users.some((u) => u.role === "admin")) throw validation("At least one user must be an admin");
    try {
      const result = await provisionUsers(repos, body.data.users);
      await audit.record({ category: "admin", action: "setup_completed", result: "ok", ip: req.ip ?? null, detail: { created: result.created } });
      return { ok: true, ...result };
    } catch (e) {
      if (e instanceof PasswordPolicyError) throw validation(e.message);
      throw e;
    }
  });
}
