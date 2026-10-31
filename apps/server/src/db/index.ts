import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbExecutor = Db | DbTransaction;

let pool: Pool | null = null;
let db: Db | null = null;

export async function initDb(opts: { url: string; migrationsDir: string; migrationsSchema?: string }): Promise<void> {
  if (db) return;
  const nextPool = new Pool({
    connectionString: opts.url,
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  try {
    await nextPool.query('SELECT 1');
    const nextDb = drizzle(nextPool, { schema });
    await migrate(nextDb, { migrationsFolder: opts.migrationsDir, migrationsSchema: opts.migrationsSchema });
    pool = nextPool;
    db = nextDb;
  } catch (error) {
    await nextPool.end();
    throw error;
  }
}

export function getDb(): Db {
  if (!db) throw new Error('DB not initialized: call initDb() first');
  return db;
}

export async function closeDb(): Promise<void> {
  const currentPool = pool;
  pool = null;
  db = null;
  if (currentPool) await currentPool.end();
}

export { schema };
