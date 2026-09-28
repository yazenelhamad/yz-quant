import { createDatabase } from "@yz/db";
import { loadEnv } from "./config/env.js";
import { buildApp, createContext } from "./http/app.js";
import { composeServices, routeModules } from "./compose.js";
import { serveDashboard } from "./http/static.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const dbHandle = await createDatabase(env.DATABASE_URL);
  await dbHandle.migrate();
  const ctx = createContext(env, dbHandle, console);
  const core = await composeServices(ctx, { log: console, scheduler: env.SCHEDULER_ENABLED });
  const app = await buildApp(ctx, routeModules);
  await serveDashboard(app, env);
  app.addHook("onClose", async () => { core.scheduler.stop(); });
  const shutdown = async () => { await app.close(); await dbHandle.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ port: env.PORT, db: dbHandle.kind }, "yz-quant API listening");
}

main().catch((err) => { console.error(err); process.exit(1); });
