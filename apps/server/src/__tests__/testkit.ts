import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Pool } from 'pg';
import { closeDb, initDb } from '../db/index.js';
import { getDb } from '../db/index.js';
import { userGroups, users } from '../db/schema.js';
import { seedSettings } from '../lib/settings.js';
import { createSession } from '../lib/session.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle-pg');
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://aap:aap@localhost:5432/ai_app_portal';

export function testPackage(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

function scopedUrl(schema: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

export async function setupTestDb(opts?: { seed?: boolean }): Promise<{ dir: string }> {
  const dir = `aap_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await admin.query(`CREATE SCHEMA "${dir}"`);
  } finally {
    await admin.end();
  }
  await initDb({ url: scopedUrl(dir), migrationsDir: MIGRATIONS_DIR, migrationsSchema: dir });
  if (opts?.seed !== false) await seedSettings();
  return { dir };
}

export async function teardownTestDb(dir: string): Promise<void> {
  await closeDb();
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await admin.query(`DROP SCHEMA "${dir}" CASCADE`);
  } finally {
    await admin.end();
  }
}

export async function sessionCookieFor(userId: number): Promise<string> {
  let token = '';
  await createSession(
    {
      cookie: (_name: string, value: string) => {
        token = value;
      },
    } as never,
    { id: userId },
    { grantStepUp: true },
  );
  return `aap_sid=${token}`;
}

export async function insertTestUser(values: typeof users.$inferInsert): Promise<number> {
  const [user] = await getDb().insert(users).values(values).returning({ id: users.id });
  if (!user) throw new Error('Failed to insert test user');
  return user.id;
}

export async function insertTestGroup(values: typeof userGroups.$inferInsert): Promise<number> {
  const [group] = await getDb().insert(userGroups).values(values).returning({ id: userGroups.id });
  if (!group) throw new Error('Failed to insert test group');
  return group.id;
}
