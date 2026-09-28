import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { createDatabase, type DatabaseHandle } from "@yz/db";
import { loadEnv } from "../config/env.js";
import { buildApp, createContext, type AppContext } from "../http/app.js";
import { hashPassword } from "./password.js";
import type { FastifyInstance } from "fastify";

const KEY = Buffer.alloc(32, 7).toString("base64");
let h: DatabaseHandle;
let ctx: AppContext;
let app: FastifyInstance;
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let accA: string;
let accB: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const set = res.headers["set-cookie"];
  const arr = Array.isArray(set) ? set : [set];
  const c = arr.find((x) => typeof x === "string" && x.startsWith("yz_session=")) as string | undefined;
  if (!c) return "";
  return c.split(";")[0]!;
}

beforeAll(async () => {
  h = await createDatabase("pglite://memory");
  await h.migrate();
  const env = loadEnv({ NODE_ENV: "test", SECRETS_MASTER_KEY: KEY, SESSION_SECRET: "test-session-secret-0123456789", SCHEDULER_ENABLED: "false", DATABASE_URL: "pglite://memory", SESSION_INACTIVITY_MINUTES: "30", AUTH_RATE_LIMIT_MAX: "1000", GLOBAL_RATE_LIMIT_MAX: "100000" });
  ctx = createContext(env, h, console);
  app = await buildApp(ctx, [
    async (a, c) => {
      a.get("/api/accounts/:id/probe", async (req) => {
        const { scope, actingAsAdmin } = await c.guards.resolveScope(req, (req.params as { id: string }).id, "read");
        return { scope, actingAsAdmin };
      });
      a.post("/api/accounts/:id/probe", async (req) => {
        const { scope } = await c.guards.resolveScope(req, (req.params as { id: string }).id, "write");
        return { scope };
      });
      a.post("/api/stepup-only", async (req) => { c.guards.requireStepUp(req); return { ok: true }; });
    },
  ]);
  const ua = await ctx.repos.users.create({ email: "a@example.com", displayName: "A", role: "admin", passwordHash: await hashPassword("CorrectHorse!Battery9") });
  const ub = await ctx.repos.users.create({ email: "b@example.com", displayName: "B", role: "trader", passwordHash: await hashPassword("CorrectHorse!Battery9") });
  userA = ua; userB = ub;
  accA = (await ctx.repos.accounts.create({ userId: ua.id, kind: "simulated", label: "A", accountNumber: "SIM-A" })).id;
  accB = (await ctx.repos.accounts.create({ userId: ub.id, kind: "simulated", label: "B", accountNumber: "SIM-B" })).id;
});
afterAll(async () => { await app.close(); await h.close(); });

async function login(email: string, password = "CorrectHorse!Battery9") {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  return { res, cookie: cookieOf(res) };
}

describe("authentication", () => {
  it("rejects bad credentials and locks after repeated failures", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.com", password: "nope-nope-nope" } });
    expect(bad.statusCode).toBe(401);
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "locked@example.com", password: "x" } });
    const lockedRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "locked@example.com", password: "x" } });
    expect(lockedRes.statusCode).toBe(423);
  });

  it("issues a session cookie, exposes csrf token, enforces csrf on writes", async () => {
    const { res, cookie } = await login("b@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mfaRequired: false });
    expect(cookie).toMatch(/^yz_session=/);
    const s = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
    expect(s.statusCode).toBe(200);
    const csrf = s.json().csrfToken as string;
    const noCsrf = await app.inject({ method: "POST", url: `/api/accounts/${accB}/probe`, headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({ method: "POST", url: `/api/accounts/${accB}/probe`, headers: { cookie, "x-csrf-token": csrf } });
    expect(withCsrf.statusCode).toBe(200);
    expect(withCsrf.json().scope).toEqual({ userId: userB.id, brokerAccountId: accB });
  });

  it("scope resolution: trader cannot touch another user's account; admin may read but not write", async () => {
    const b = await login("b@example.com");
    const sb = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: b.cookie } });
    const csrfB = sb.json().csrfToken as string;
    expect((await app.inject({ method: "GET", url: `/api/accounts/${accA}/probe`, headers: { cookie: b.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/accounts/${accA}/probe`, headers: { cookie: b.cookie, "x-csrf-token": csrfB } })).statusCode).toBe(403);
    const a = await login("a@example.com");
    const sa = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: a.cookie } });
    const csrfA = sa.json().csrfToken as string;
    const read = await app.inject({ method: "GET", url: `/api/accounts/${accB}/probe`, headers: { cookie: a.cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ scope: { userId: userB.id, brokerAccountId: accB }, actingAsAdmin: true });
    expect((await app.inject({ method: "POST", url: `/api/accounts/${accB}/probe`, headers: { cookie: a.cookie, "x-csrf-token": csrfA } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/accounts/does-not-exist/probe`, headers: { cookie: a.cookie } })).statusCode).toBe(404);
  });

  it("requires step-up for sensitive actions, MFA enrol/confirm/verify flow works, sessions rotate", async () => {
    const a = await login("a@example.com");
    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: a.cookie } });
    const csrf = session.json().csrfToken as string;
    const h1 = { cookie: a.cookie, "x-csrf-token": csrf };
    expect((await app.inject({ method: "POST", url: "/api/stepup-only", headers: h1 })).statusCode).toBe(428);
    const badStep = await app.inject({ method: "POST", url: "/api/auth/step-up", headers: h1, payload: { password: "wrong-wrong-wrong" } });
    expect(badStep.statusCode).toBe(401);
    const step = await app.inject({ method: "POST", url: "/api/auth/step-up", headers: h1, payload: { password: "CorrectHorse!Battery9" } });
    expect(step.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/stepup-only", headers: h1 })).statusCode).toBe(200);

    const enroll = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll", headers: h1 });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret as string;
    expect(enroll.json().qrDataUrl).toMatch(/^data:image\/png/);
    const confirm = await app.inject({ method: "POST", url: "/api/auth/mfa/confirm", headers: h1, payload: { code: authenticator.generate(secret) } });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);
    const rotated = cookieOf(confirm);
    expect(rotated).not.toBe(a.cookie);
    // old cookie is revoked
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: a.cookie } })).statusCode).toBe(401);

    // Fresh login now requires MFA before protected routes work
    const again = await login("a@example.com");
    expect(again.res.json()).toEqual({ ok: true, mfaRequired: true });
    const pre = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: again.cookie } });
    const csrf2 = pre.json().csrfToken as string;
    expect((await app.inject({ method: "GET", url: `/api/accounts/${accA}/probe`, headers: { cookie: again.cookie } })).statusCode).toBe(401);
    const badMfa = await app.inject({ method: "POST", url: "/api/auth/mfa/verify", headers: { cookie: again.cookie, "x-csrf-token": csrf2 }, payload: { code: "000000" } });
    expect(badMfa.statusCode).toBe(401);
    const okMfa = await app.inject({ method: "POST", url: "/api/auth/mfa/verify", headers: { cookie: again.cookie, "x-csrf-token": csrf2 }, payload: { code: authenticator.generate(secret) } });
    expect(okMfa.statusCode).toBe(200);
    const verified = cookieOf(okMfa);
    expect((await app.inject({ method: "GET", url: `/api/accounts/${accA}/probe`, headers: { cookie: verified } })).statusCode).toBe(200);
    // recovery code path
    const third = await login("a@example.com");
    const pre3 = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: third.cookie } });
    const rc = (confirm.json().recoveryCodes as string[])[0]!;
    const okRc = await app.inject({ method: "POST", url: "/api/auth/mfa/verify", headers: { cookie: third.cookie, "x-csrf-token": pre3.json().csrfToken }, payload: { code: rc } });
    expect(okRc.statusCode).toBe(200);
    const reuse = await login("a@example.com");
    const pre4 = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: reuse.cookie } });
    const reused = await app.inject({ method: "POST", url: "/api/auth/mfa/verify", headers: { cookie: reuse.cookie, "x-csrf-token": pre4.json().csrfToken }, payload: { code: rc } });
    expect(reused.statusCode).toBe(401);
  });

  it("enforces inactivity timeout and tampered cookies", async () => {
    const b = await login("b@example.com");
    const tampered = b.cookie.slice(0, -3) + "abc";
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: tampered } })).statusCode).toBe(401);
    // Simulate 31 minutes idle by rewinding lastSeenAt.
    const sessionId = b.cookie.replace("yz_session=", "").split(".")[0]!;
    const latest = (await ctx.repos.sessions.byId(sessionId))!;
    await ctx.repos.sessions.touch(latest.id, new Date(Date.now() - 31 * 60_000).toISOString());
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: b.cookie } })).statusCode).toBe(401);
    expect((await ctx.repos.sessions.byId(latest.id))?.revokedReason).toBe("inactivity");
  });

  it("logs auth events to the audit log", async () => {
    const rows = await ctx.repos.audit.recent({ category: "auth", limit: 500 });
    const actions = new Set(rows.map((r) => r.action));
    expect(actions.has("login")).toBe(true);
    expect(actions.has("mfa_enabled")).toBe(true);
    expect(actions.has("step_up")).toBe(true);
    expect(rows.every((r) => JSON.stringify(r.detail).includes("CorrectHorse") === false)).toBe(true);
  });
});
