import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { loadEnv } from "../config/env.js";
import { buildApp, createContext, type AppContext } from "../http/app.js";
import { registerSetupRoutes } from "./setup.js";
import type { FastifyInstance } from "fastify";

let h: DatabaseHandle; let ctx: AppContext; let app: FastifyInstance;
beforeAll(async () => {
  h = await createDatabase("pglite://memory"); await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), SESSION_SECRET: "test-session-secret-0123456789", DATABASE_URL: "pglite://memory", LOG_LEVEL: "silent", SETUP_TOKEN: "first-run-passphrase-42", GLOBAL_RATE_LIMIT_MAX: "100000" });
  ctx = createContext(env, h, console);
  app = await buildApp(ctx, [registerSetupRoutes]);
});
afterAll(async () => { await app.close(); await h.close(); });

describe("one-time setup", () => {
  const users = [{ email: "a@example.com", displayName: "A", role: "admin", password: "CorrectHorse!Battery9" }, { email: "b@example.com", displayName: "B", role: "trader", password: "CorrectHorse!Battery9" }];
  it("is available only while empty, rejects a bad token, creates the two users once, then closes forever", async () => {
    expect((await app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ available: true });
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { token: "wrong-token-here", users } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/setup", payload: { token: "first-run-passphrase-42", users } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().created).toEqual(["a@example.com", "b@example.com"]);
    expect(await ctx.repos.users.count()).toBe(2);
    expect((await ctx.repos.accounts.listForUser((await ctx.repos.users.byEmail("a@example.com"))!.id)).length).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ available: false });
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { token: "first-run-passphrase-42", users } })).statusCode).toBe(410);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.com", password: "CorrectHorse!Battery9" } });
    expect(login.statusCode).toBe(200);
  });
});
