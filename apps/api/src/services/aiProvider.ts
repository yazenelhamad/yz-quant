import { createAnthropicClient, SwitchableModelClient, withOpenRouter, DEFAULT_OPENROUTER_MODEL } from "@yz/intelligence";
import type { AppContext } from "../http/app.js";

export const OPENROUTER_SECRET = "openrouter_api_key";
const AAD = `app_secret:${OPENROUTER_SECRET}`;

type Log = { warn: (meta: Record<string, unknown>, message: string) => void };

export interface AiProviderStatus {
  anthropicConfigured: boolean;
  openRouter: { configured: boolean; source: "admin" | "env" | null; hint: string | null; model: string; updatedAt: string | null };
  activeModel: string | null;
}

/**
 * Owns the one model client every service holds. The OpenRouter key can be set from the admin
 * console: it is sealed with the SecretBox before it is stored, never returned to the browser
 * (only its last four characters), and the client is rebuilt without a restart.
 */
export class AiProviderService {
  readonly client: SwitchableModelClient;
  private source: "admin" | "env" | null = null;
  private hint: string | null = null;
  private updatedAt: string | null = null;

  constructor(private readonly ctx: AppContext, private readonly log: Log) {
    this.client = new SwitchableModelClient(this.anthropic());
    this.rebuild(null);
  }

  private env(): Record<string, string | undefined> {
    return this.ctx.env as unknown as Record<string, string | undefined>;
  }

  private anthropic() {
    return createAnthropicClient(this.env(), { logger: { warn: (message, meta) => this.log.warn(meta ?? {}, message) } });
  }

  private model(): string {
    return this.ctx.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  }

  private rebuild(adminKey: string | null): void {
    const envKey = this.ctx.env.OPENROUTER_API_KEY?.trim() || null;
    const key = adminKey ?? envKey;
    this.source = adminKey ? "admin" : envKey ? "env" : null;
    if (!adminKey) { this.hint = envKey ? envKey.slice(-4) : null; this.updatedAt = null; }
    const base = this.anthropic();
    this.client.set(key ? withOpenRouter(base, key, this.model(), { warn: (message, meta) => this.log.warn(meta ?? {}, message) }) : base);
  }

  /** Loads a key stored from the admin console (it takes precedence over the environment). */
  async load(): Promise<void> {
    const row = await this.ctx.repos.appSecrets.get(OPENROUTER_SECRET);
    if (!row) return;
    try {
      const key = this.ctx.secretBox.open(row.envelope, AAD);
      this.hint = row.hint;
      this.updatedAt = row.updatedAt;
      this.rebuild(key);
    } catch (error) {
      this.log.warn({ error: (error as Error).message }, "stored OpenRouter key could not be opened; ignoring it");
    }
  }

  async setOpenRouterKey(key: string, by: string): Promise<void> {
    const hint = key.slice(-4);
    await this.ctx.repos.appSecrets.set(OPENROUTER_SECRET, this.ctx.secretBox.seal(key, AAD), hint, by);
    this.hint = hint;
    this.updatedAt = new Date().toISOString();
    this.rebuild(key);
  }

  async clearOpenRouterKey(): Promise<void> {
    await this.ctx.repos.appSecrets.clear(OPENROUTER_SECRET);
    this.rebuild(null);
  }

  status(): AiProviderStatus {
    return {
      anthropicConfigured: Boolean(this.ctx.env.ANTHROPIC_API_KEY?.trim()),
      openRouter: { configured: this.source !== null, source: this.source, hint: this.hint, model: this.model(), updatedAt: this.updatedAt },
      activeModel: this.client.modelFor("slow_brain"),
    };
  }
}
