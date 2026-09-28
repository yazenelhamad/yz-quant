/**
 * Provision the two authorised users. There is no signup route; this script is the only way
 * to create users. Re-running it lets an operator reset a password.
 *
 * Usage (interactive): npm run bootstrap
 * Usage (non-interactive): BOOTSTRAP_USERS='[{"email":"a@x","displayName":"A","role":"admin","password":"..."},{...}]' npm run bootstrap
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDatabase, UsersRepository, BrokerAccountsRepository } from "@yz/db";
import { hashPassword } from "../apps/api/src/auth/password.js";

interface Spec { email: string; displayName: string; role: "admin" | "trader"; password: string }

async function collect(): Promise<Spec[]> {
  if (process.env.BOOTSTRAP_USERS) return JSON.parse(process.env.BOOTSTRAP_USERS) as Spec[];
  const rl = createInterface({ input: stdin, output: stdout });
  const specs: Spec[] = [];
  for (const label of ["User A", "User B"]) {
    console.log(`\n${label}`);
    const email = (await rl.question("  email: ")).trim();
    if (!email) break;
    const displayName = (await rl.question("  display name: ")).trim() || email;
    const role = ((await rl.question("  role [admin/trader] (trader): ")).trim() || "trader") as "admin" | "trader";
    const password = await rl.question("  password (min 12 chars, 3 character classes): ");
    specs.push({ email, displayName, role, password });
  }
  rl.close();
  return specs;
}

const url = process.env.DATABASE_URL ?? "pglite://./data/pglite";
const h = await createDatabase(url);
await h.migrate();
const users = new UsersRepository(h.db);
const accounts = new BrokerAccountsRepository(h.db);
const specs = await collect();
if (specs.length === 0) { console.log("nothing to do"); await h.close(); process.exit(0); }
const existingCount = await users.count();
if (existingCount + specs.filter(async (s) => !(await users.byEmail(s.email))).length > 2 && !process.env.BOOTSTRAP_ALLOW_MORE) {
  // The platform is designed for exactly two users.
}
for (const s of specs) {
  const hash = await hashPassword(s.password);
  const existing = await users.byEmail(s.email);
  if (existing) {
    await users.update(existing.id, { passwordHash: hash, displayName: s.displayName, role: s.role, active: true, failedLogins: 0, lockedUntil: null });
    console.log(`updated ${s.email}`);
  } else {
    const total = await users.count();
    if (total >= 2 && !process.env.BOOTSTRAP_ALLOW_MORE) {
      console.error(`refusing to create ${s.email}: the platform is limited to two users (set BOOTSTRAP_ALLOW_MORE=1 to override)`);
      continue;
    }
    const u = await users.create({ email: s.email, displayName: s.displayName, role: s.role, passwordHash: hash });
    // A placeholder Robinhood account record so the user can connect from Settings.
    await accounts.create({ userId: u.id, kind: "robinhood_agentic", label: `${s.displayName} — Robinhood Agentic`, accountNumber: `pending-${u.id.slice(0, 8)}`, status: "not_connected", statusDetail: "Connect your Robinhood Agentic account from Settings" });
    console.log(`created ${s.email} (${s.role})`);
  }
}
await h.close();
