import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("127.0.0.1"),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  API_ORIGIN: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1).default("pglite://./data/pglite"),
  SECRETS_MASTER_KEY: z.string().min(1, "SECRETS_MASTER_KEY is required (openssl rand -base64 32)"),
  /** Version stamped on new envelopes; bump after scripts/rotate-secrets.ts. */
  SECRETS_MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET is required (openssl rand -base64 32)"),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().positive().default(12),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().positive().default(30),
  STEP_UP_MINUTES: z.coerce.number().positive().default(10),
  ROBINHOOD_MCP_URL: z.string().url().default("https://agent.robinhood.com/mcp/trading"),
  ROBINHOOD_OAUTH_REGISTER_URL: z.string().url().default("https://agent.robinhood.com/oauth/trading/register"),
  ROBINHOOD_OAUTH_AUTHORIZE_URL: z.string().url().default("https://robinhood.com/oauth"),
  ROBINHOOD_OAUTH_TOKEN_URL: z.string().url().default("https://api.robinhood.com/oauth2/token/"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  MODEL_SLOW_BRAIN: z.string().default("claude-fable-5-1"),
  MODEL_RESEARCH: z.string().default("claude-opus-5-5"),
  MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),
  POLYGON_API_KEY: z.string().optional().default(""),
  /** Scheduler on/off (tests disable it). */
  SCHEDULER_ENABLED: z.coerce.boolean().default(true),
  LOG_LEVEL: z.string().default("info"),
  /** One-time setup token for headless deployments; the /setup page works only while no users exist. */
  SETUP_TOKEN: z.string().optional().default(""),
  /** Requests per minute allowed on login/MFA/step-up routes per IP. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    if (!env.APP_ORIGIN.startsWith("https://") || !env.API_ORIGIN.startsWith("https://")) {
      throw new Error("In production APP_ORIGIN and API_ORIGIN must be https:// origins");
    }
    if (env.DATABASE_URL.startsWith("pglite://")) {
      throw new Error("In production DATABASE_URL must point at a PostgreSQL server");
    }
  }
  return env;
}

export function decodeMasterKey(value: string): Buffer {
  const buf = Buffer.from(value, "base64");
  if (buf.length !== 32) throw new Error("SECRETS_MASTER_KEY must decode to exactly 32 bytes (openssl rand -base64 32)");
  return buf;
}
