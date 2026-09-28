import type { Repos } from "../http/app.js";
import { hashPassword } from "../auth/password.js";

export interface UserSpec { email: string; displayName: string; role: "admin" | "trader"; password: string }

/**
 * Create or reset the platform's users. Shared by the operator script and the one-time setup route.
 * The platform is designed for exactly two users; creation beyond two is refused unless `allowMore`.
 */
export async function provisionUsers(repos: Repos, specs: UserSpec[], opts: { allowMore?: boolean } = {}): Promise<{ created: string[]; updated: string[]; refused: string[] }> {
  const created: string[] = []; const updated: string[] = []; const refused: string[] = [];
  for (const s of specs) {
    const email = s.email.trim().toLowerCase();
    const hash = await hashPassword(s.password);
    const existing = await repos.users.byEmail(email);
    if (existing) {
      await repos.users.update(existing.id, { passwordHash: hash, displayName: s.displayName, role: s.role, active: true, failedLogins: 0, lockedUntil: null });
      updated.push(email);
      continue;
    }
    if ((await repos.users.count()) >= 2 && !opts.allowMore) { refused.push(email); continue; }
    const u = await repos.users.create({ email, displayName: s.displayName, role: s.role, passwordHash: hash });
    await repos.accounts.create({ userId: u.id, kind: "robinhood_agentic", label: `${s.displayName} — Robinhood Agentic`, accountNumber: `pending-${u.id.slice(0, 8)}`, status: "not_connected", statusDetail: "Connect your Robinhood Agentic account from Settings" });
    created.push(email);
  }
  return { created, updated, refused };
}
