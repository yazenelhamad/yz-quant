import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Database, DatabaseHandle } from "@yz/db";
import {
  AlertsRepository, ApprovalRequestsRepository, AuditRepository, BrokerAccountsRepository, BrokerCredentialsRepository,
  CandidateEvaluationsRepository, ExecutionOutcomesRepository, FillsRepository, GlobalRiskRepository, HealthRepository,
  JobRunsRepository, KillSwitchRepository, LoginAttemptsRepository, OrdersRepository, PortfolioSnapshotsRepository,
  PositionsRepository, ReconciliationsRepository, RejectedTradesRepository, RiskDecisionsRepository, RiskSettingsRepository,
  SessionsRepository, SystemEventsRepository, ThesesRepository, TradesRepository, UsersRepository, MarketRepository, SurvivalRepository,
} from "@yz/db";
import type { Env } from "../config/env.js";
import { decodeMasterKey } from "../config/env.js";
import { SecretBox } from "../security/secrets.js";
import { SessionService } from "../auth/sessions.js";
import { AuditService } from "../services/audit.js";
import { buildGuards, clearSessionCookie, type Guards, SESSION_COOKIE } from "./context.js";
import { HttpError } from "./errors.js";
import { registerAuthRoutes } from "../auth/routes.js";

export interface Repos {
  users: UsersRepository;
  sessions: SessionsRepository;
  loginAttempts: LoginAttemptsRepository;
  accounts: BrokerAccountsRepository;
  credentials: BrokerCredentialsRepository;
  riskSettings: RiskSettingsRepository;
  orders: OrdersRepository;
  fills: FillsRepository;
  positions: PositionsRepository;
  snapshots: PortfolioSnapshotsRepository;
  trades: TradesRepository;
  theses: ThesesRepository;
  riskDecisions: RiskDecisionsRepository;
  rejected: RejectedTradesRepository;
  approvals: ApprovalRequestsRepository;
  executionOutcomes: ExecutionOutcomesRepository;
  candidateEvaluations: CandidateEvaluationsRepository;
  reconciliations: ReconciliationsRepository;
  audit: AuditRepository;
  systemEvents: SystemEventsRepository;
  alerts: AlertsRepository;
  health: HealthRepository;
  globalRisk: GlobalRiskRepository;
  killSwitches: KillSwitchRepository;
  jobs: JobRunsRepository;
  market: MarketRepository;
  survival: SurvivalRepository;
  /** Raw database handle for the few tables without a repository (OAuth states). */
  sessionsDb: () => Database;
}

export function buildRepos(handle: DatabaseHandle): Repos {
  const db = handle.db;
  return {
    users: new UsersRepository(db),
    sessions: new SessionsRepository(db),
    loginAttempts: new LoginAttemptsRepository(db),
    accounts: new BrokerAccountsRepository(db),
    credentials: new BrokerCredentialsRepository(db),
    riskSettings: new RiskSettingsRepository(db),
    orders: new OrdersRepository(db),
    fills: new FillsRepository(db),
    positions: new PositionsRepository(db),
    snapshots: new PortfolioSnapshotsRepository(db),
    trades: new TradesRepository(db),
    theses: new ThesesRepository(db),
    riskDecisions: new RiskDecisionsRepository(db),
    rejected: new RejectedTradesRepository(db),
    approvals: new ApprovalRequestsRepository(db),
    executionOutcomes: new ExecutionOutcomesRepository(db),
    candidateEvaluations: new CandidateEvaluationsRepository(db),
    reconciliations: new ReconciliationsRepository(db),
    audit: new AuditRepository(db),
    systemEvents: new SystemEventsRepository(db),
    alerts: new AlertsRepository(db),
    health: new HealthRepository(db),
    globalRisk: new GlobalRiskRepository(db),
    killSwitches: new KillSwitchRepository(db),
    jobs: new JobRunsRepository(db),
    market: new MarketRepository(db),
    survival: new SurvivalRepository(db),
    sessionsDb: () => db,
  };
}

/** Everything a route module needs. Extended by services registered in main.ts. */
export interface AppContext {
  env: Env;
  dbHandle: DatabaseHandle;
  repos: Repos;
  secretBox: SecretBox;
  sessions: SessionService;
  guards: Guards;
  audit: AuditService;
  /** Extension point: services attached by the composition root (trading, market data, learning...). */
  services: Record<string, unknown>;
}

export type RouteModule = (app: FastifyInstance, ctx: AppContext) => Promise<void> | void;

export function createContext(env: Env, dbHandle: DatabaseHandle, log: { warn: (o: unknown, m?: string) => void }): AppContext {
  const repos = buildRepos(dbHandle);
  const secretBox = SecretBox.fromMasterKey(decodeMasterKey(env.SECRETS_MASTER_KEY), env.SECRETS_MASTER_KEY_VERSION);
  const sessions = new SessionService(repos.sessions, {
    secret: env.SESSION_SECRET,
    absoluteHours: env.SESSION_ABSOLUTE_HOURS,
    inactivityMinutes: env.SESSION_INACTIVITY_MINUTES,
    stepUpMinutes: env.STEP_UP_MINUTES,
  });
  const guards = buildGuards({ sessions, accounts: repos.accounts });
  const audit = new AuditService(repos.audit, log);
  return { env, dbHandle, repos, secretBox, sessions, guards, audit, services: {} };
}

export async function buildApp(ctx: AppContext, routeModules: RouteModule[] = []): Promise<FastifyInstance> {
  const { env } = ctx;
  const app = Fastify({
    logger: { level: env.LOG_LEVEL, redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.access_token", "*.refresh_token"], censor: "[redacted]" } },
    trustProxy: env.NODE_ENV === "production",
    bodyLimit: 1_000_000,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin requests have no Origin header; otherwise it must be the configured app origin.
      if (!origin || origin === env.APP_ORIGIN) cb(null, true);
      else cb(new HttpError(403, "forbidden_origin", "Origin not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token"],
  });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(rateLimit, { global: true, max: env.GLOBAL_RATE_LIMIT_MAX, timeWindow: "1 minute", keyGenerator: (req) => `${req.ip}:${req.auth?.user.id ?? "anon"}` });

  // Session loading: never throws; guards decide.
  app.addHook("onRequest", async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const result = await ctx.sessions.validate(raw);
    if (!result.ok) {
      clearSessionCookie(reply, env.NODE_ENV === "production");
      return;
    }
    const user = await ctx.repos.users.byId(result.session.userId);
    if (!user || !user.active) {
      await ctx.repos.sessions.revoke(result.session.id, "user_missing_or_disabled");
      clearSessionCookie(reply, env.NODE_ENV === "production");
      return;
    }
    req.auth = { user, session: result.session };
    await ctx.sessions.touch(result.session);
  });

  // CSRF + origin check for every non-GET request that carries a session.
  app.addHook("preHandler", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    if (!req.url.startsWith("/api/")) return;
    if (req.url === "/api/auth/login" || req.url === "/api/auth/mfa/verify") return; // pre-session / pre-MFA; protected by SameSite, rate limit and the credential itself
    if (!req.auth) return; // guards will 401
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (origin && origin !== env.APP_ORIGIN && origin !== env.API_ORIGIN) throw new HttpError(403, "forbidden_origin", "Origin mismatch");
    if (!origin && referer && !referer.startsWith(env.APP_ORIGIN) && !referer.startsWith(env.API_ORIGIN)) throw new HttpError(403, "forbidden_origin", "Referer mismatch");
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" || token !== req.auth.session.csrfToken) throw new HttpError(403, "csrf", "Missing or invalid CSRF token");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.status(err.status).send({ error: { code: err.code, message: err.message, detail: err.detail } });
      return;
    }
    const anyErr = err as { statusCode?: number; validation?: unknown; message?: string; name?: string };
    if (anyErr.name === "CrossTenantError" || anyErr.name === "ScopeError") {
      req.log.error({ err }, "tenant isolation violation");
      reply.status(403).send({ error: { code: "forbidden", message: "Forbidden" } });
      return;
    }
    if (anyErr.statusCode === 429) { reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests" } }); return; }
    if (anyErr.statusCode && anyErr.statusCode < 500) { reply.status(anyErr.statusCode).send({ error: { code: "bad_request", message: anyErr.message ?? "Bad request" } }); return; }
    req.log.error({ err }, "unhandled error");
    reply.status(500).send({ error: { code: "internal", message: "Internal error" } });
  });

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: when the dashboard build is being served, client-side routes get index.html.
    const index = (app as unknown as { dashboardIndex?: string }).dashboardIndex;
    if (index && !req.url.startsWith("/api/") && req.method === "GET") { void reply.type("text/html").send(readFileSync(index)); return; }
    reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
  });

  app.get("/api/ping", async () => ({ ok: true, at: new Date().toISOString() }));

  await registerAuthRoutes(app, ctx);
  for (const mod of routeModules) await mod(app, ctx);
  return app;
}
