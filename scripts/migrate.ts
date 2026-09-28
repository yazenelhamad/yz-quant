import { createDatabase } from "@yz/db";

const url = process.env.DATABASE_URL ?? "pglite://./data/pglite";
const h = await createDatabase(url);
await h.migrate();
console.log(`migrated (${h.kind})`);
await h.close();
