import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { getSettingInt } from './settings.js';

export type AuditDetail = Record<string, unknown> | string | null | undefined;

export async function audit(
  actor: string,
  ip: string | null | undefined,
  action: string,
  detail?: AuditDetail,
): Promise<void> {
  try {
    await getDb().insert(auditLogs).values({
      ts: Date.now(),
      actor,
      ip: ip ?? null,
      action,
      detail: detail === undefined || detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    });
  } catch (err) {
    console.error('[audit] 写入失败:', err);
  }
}

const DAY_MS = 86_400_000;
const BATCH = 5000;
const PURGE_TARGETS = [
  ['audit_logs', 'ts'],
  ['login_attempts', 'created_at'],
  ['sessions', 'expires_at'],
  ['pow_challenges', 'expires_at'],
  ['pow_tokens', 'expires_at'],
  ['ip_bans', 'banned_until'],
] as const;

async function purgeBatched(table: string, column: string, olderThan: number): Promise<number> {
  let total = 0;
  for (;;) {
    const tableName = sql.raw(`"${table}"`);
    const columnName = sql.raw(`"${column}"`);
    const result = await getDb().execute(sql`
      WITH deleted AS (
        DELETE FROM ${tableName}
        WHERE ctid IN (
          SELECT ctid FROM ${tableName}
          WHERE ${columnName} < ${olderThan}
          LIMIT ${BATCH}
        )
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `);
    const changes = Number(result.rows[0]?.count ?? 0);
    total += changes;
    if (changes < BATCH) return total;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const extraPurges: Array<(now: number) => void | Promise<void>> = [];
export function registerPurgeTask(fn: (now: number) => void | Promise<void>): void {
  extraPurges.push(fn);
}

export async function purgeExpired(now = Date.now()): Promise<void> {
  try {
    const retentionDays = getSettingInt('AUDIT_RETENTION_DAYS', 90);
    const cutoffs = [
      now - retentionDays * DAY_MS,
      now - retentionDays * DAY_MS,
      now - 7 * DAY_MS,
      now,
      now,
      now - 30 * DAY_MS,
    ];
    for (let i = 0; i < PURGE_TARGETS.length; i++) {
      const [table, column] = PURGE_TARGETS[i]!;
      await purgeBatched(table, column, cutoffs[i]!);
    }
    for (const fn of extraPurges) await fn(now);
  } catch (err) {
    console.error('[audit] 清理失败:', err);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startPurgeLoop(): void {
  if (timer) return;
  void purgeExpired();
  timer = setInterval(() => void purgeExpired(), 3600_000);
  timer.unref();
}

export function stopPurgeLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
