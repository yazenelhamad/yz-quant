import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  kind: "postgres" | "pglite";
  /** Apply pending migrations from packages/db/migrations. */
  migrate(): Promise<void>;
  close(): Promise<void>;
  /** Lightweight liveness probe. */
  ping(): Promise<boolean>;
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Create a database handle from a URL.
 *  - postgres://... or postgresql://...  → node-postgres pool
 *  - pglite://<dir>                       → embedded Postgres persisted to <dir>
 *  - pglite://memory                      → embedded Postgres in memory (tests)
 */
export async function createDatabase(url: string): Promise<DatabaseHandle> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length);
    let client: PGlite;
    if (target === "memory" || target === "") client = new PGlite();
    else { const dir = path.resolve(target); mkdirSync(dir, { recursive: true }); client = new PGlite(dir); }
    await client.waitReady;
    const db = drizzlePglite(client, { schema });
    return {
      db,
      kind: "pglite",
      migrate: async () => { await migratePglite(db, { migrationsFolder }); },
      close: async () => { await client.close(); },
      ping: async () => { try { await client.query("select 1"); return true; } catch { return false; } },
    };
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema });
    return {
      db,
      kind: "postgres",
      migrate: async () => { await migratePg(db, { migrationsFolder }); },
      close: async () => { await pool.end(); },
      ping: async () => { try { await pool.query("select 1"); return true; } catch { return false; } },
    };
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split(":")[0]}`);
}
