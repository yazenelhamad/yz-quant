/**
 * Re-encrypt every secret envelope (broker credentials, MFA secrets) under a new master key.
 * Usage: SECRETS_MASTER_KEY=<old> SECRETS_MASTER_KEY_NEXT=<new> npx tsx scripts/rotate-secrets.ts
 * Afterwards set SECRETS_MASTER_KEY=<new> and restart the API.
 */
import { eq } from "drizzle-orm";
import { createDatabase, brokerCredentials, users } from "@yz/db";
import { SecretBox } from "../apps/api/src/security/secrets.js";
import { decodeMasterKey } from "../apps/api/src/config/env.js";

const oldKey = process.env.SECRETS_MASTER_KEY;
const nextKey = process.env.SECRETS_MASTER_KEY_NEXT;
if (!oldKey || !nextKey) { console.error("SECRETS_MASTER_KEY and SECRETS_MASTER_KEY_NEXT are required"); process.exit(1); }
const box = new SecretBox([{ version: 1, key: decodeMasterKey(oldKey) }, { version: 2, key: decodeMasterKey(nextKey) }], 2);
const h = await createDatabase(process.env.DATABASE_URL ?? "pglite://./data/pglite");
let n = 0;
for (const row of await h.db.select().from(brokerCredentials)) {
  const aad = `${row.userId}:${row.brokerAccountId}`;
  await h.db.update(brokerCredentials).set({ credentialEnc: box.rotate(row.credentialEnc, aad), keyVersion: 2 }).where(eq(brokerCredentials.id, row.id));
  n++;
}
for (const u of await h.db.select().from(users)) {
  if (!u.mfaSecretEnc) continue;
  await h.db.update(users).set({ mfaSecretEnc: box.rotate(u.mfaSecretEnc, u.id) }).where(eq(users.id, u.id));
  n++;
}
console.log(`rotated ${n} envelopes to key version 2. Now set SECRETS_MASTER_KEY to the new value.`);
await h.close();
