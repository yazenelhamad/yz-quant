import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../config/env.js";

/**
 * Serve the built dashboard (apps/web/dist) from the API process so a single origin runs the app.
 * Skipped when the build does not exist (development uses the Vite dev server with a proxy).
 */
export async function serveDashboard(app: FastifyInstance, env: Env): Promise<boolean> {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
  if (!existsSync(path.join(dist, "index.html"))) {
    app.log.info({ dist }, "dashboard build not found; serve it with `npm run dev:web` or build with `npm run build -w apps/web`");
    return false;
  }
  await app.register(fastifyStatic, { root: dist, prefix: "/", wildcard: false, index: false, decorateReply: true });
  app.get("/", async (_req, reply) => reply.sendFile("index.html"));
  // The not-found handler in buildApp serves index.html for non-API routes when this is set.
  app.decorate("dashboardIndex", path.join(dist, "index.html"));
  app.log.info({ dist, origin: env.APP_ORIGIN }, "serving dashboard");
  return true;
}
