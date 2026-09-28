import type { Repos } from "../http/app.js";
import { hashPassword } from "../auth/password.js";

export interface UserSpec { username?: string | null; email?: string | null; displayName: string; role: "admin" | "trader"; password: string; brandName?: string | null }

/**
 * Create or reset the platform's users. Shared by the operator script and the one-time setup route.
 * The platform is designed for exactly two users; creation beyond two is refused unless `allowMore`.
 */
export async function provisionUsers(repos: Repos, specs: UserSpec[], opts: { allowMore?: boolean } = {}): Promise<{ created: string[]; updated: string[]; refused: string[] }> {
  const created: string[] = []; const updated: string[] = []; const refused: string[] = [];
  for (const s of specs) {
    const username = s.username?.trim().toLowerCase() || null;
    const email = s.email?.trim().toLowerCase() || null;
    const label = username ?? email ?? "(unnamed)";
    if (!username && !email) { refused.push(label); continue; }
    if (username && !/^[a-z0-9._-]{2,40}$/.test(username)) throw new Error(`invalid username "${username}": use 2–40 letters, digits, dots, dashes or underscores`);
    const hash = await hashPassword(s.password);
    const existing = (username ? await repos.users.byUsername(username) : undefined) ?? (email ? await repos.users.byEmail(email) : undefined);
    if (existing) {
      await repos.users.update(existing.id, { passwordHash: hash, displayName: s.displayName, role: s.role, active: true, failedLogins: 0, lockedUntil: null, ...(username ? { username } : {}), ...(email ? { email } : {}), ...(s.brandName !== undefined ? { brandName: s.brandName } : {}) });
      updated.push(label);
      continue;
    }
    if ((await repos.users.count()) >= 2 && !opts.allowMore) { refused.push(label); continue; }
    const u = await repos.users.create({ username, email, displayName: s.displayName, role: s.role, passwordHash: hash, brandName: s.brandName ?? null });
    await repos.accounts.create({ userId: u.id, kind: "robinhood_agentic", label: `${s.displayName} — Robinhood Agentic`, accountNumber: `pending-${u.id.slice(0, 8)}`, status: "not_connected", statusDetail: "Connect your Robinhood Agentic account from Settings" });
    created.push(label);
  }
  return { created, updated, refused };
}
