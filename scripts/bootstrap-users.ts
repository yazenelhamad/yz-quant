/**
 * Provision the two authorised users. There is no signup route; this script is the only way
 * to create users. Re-running it lets an operator reset a password.
 *
 * Usage (interactive): npm run bootstrap
 * Usage (non-interactive): BOOTSTRAP_USERS='[{"email":"a@x","displayName":"A","role":"admin","password":"..."},{...}]' npm run bootstrap
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDatabase } from "@yz/db";
import { buildRepos } from "../apps/api/src/http/app.js";
import { provisionUsers, type UserSpec } from "../apps/api/src/services/provisioning.js";

type Spec = UserSpec;

async function collect(): Promise<Spec[]> {
  if (process.env.BOOTSTRAP_USERS) return JSON.parse(process.env.BOOTSTRAP_USERS) as Spec[];
  const rl = createInterface({ input: stdin, output: stdout });
  const specs: Spec[] = [];
  for (const label of ["User A", "User B"]) {
    console.log(`\n${label}`);
    const username = (await rl.question("  username: ")).trim();
    if (!username) break;
    const email = (await rl.question("  email (optional): ")).trim() || null;
    const displayName = (await rl.question("  display name: ")).trim() || username;
    const role = ((await rl.question("  role [admin/trader] (trader): ")).trim() || "trader") as "admin" | "trader";
    const password = await rl.question("  password: ");
    specs.push({ username, email, displayName, role, password });
  }
  rl.close();
  return specs;
}

const url = process.env.DATABASE_URL ?? "pglite://./data/pglite";
const h = await createDatabase(url);
await h.migrate();
const specs = await collect();
if (specs.length === 0) { console.log("nothing to do"); await h.close(); process.exit(0); }
const result = await provisionUsers(buildRepos(h), specs, { allowMore: !!process.env.BOOTSTRAP_ALLOW_MORE });
for (const e of result.created) console.log(`created ${e}`);
for (const e of result.updated) console.log(`updated ${e}`);
for (const e of result.refused) console.error(`refusing to create ${e}: the platform is limited to two users (set BOOTSTRAP_ALLOW_MORE=1 to override)`);
await h.close();
