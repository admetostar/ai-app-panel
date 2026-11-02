import { lt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { appRuntimeEvents } from '../db/schema.js';
import { registerPurgeTask } from './audit.js';
import { getSettingInt } from './settings.js';

export type AppRuntimeEventLevel = 'info' | 'warn' | 'error';

export interface AppRuntimeEventInput {
  appId: string;
  event: string;
  level: AppRuntimeEventLevel;
  userId?: number | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  details?: Record<string, unknown> | null;
}

function safePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const path = value.split(/[?#]/, 1)[0] ?? '';
  return path.slice(0, 512) || '/';
}

function safeDetails(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const serialized = JSON.stringify(value);
  return serialized.length > 2000 ? `${serialized.slice(0, 1997)}...` : serialized;
}

export async function recordAppRuntimeEvent(input: AppRuntimeEventInput): Promise<void> {
  try {
    await getDb().insert(appRuntimeEvents).values({
      appId: input.appId.slice(0, 191),
      ts: Date.now(),
      level: input.level,
      event: input.event.slice(0, 64),
      userId: input.userId ?? null,
      method: input.method?.slice(0, 16) ?? null,
      path: safePath(input.path),
      statusCode: input.statusCode ?? null,
      durationMs: input.durationMs == null ? null : Math.max(0, Math.trunc(input.durationMs)),
      details: safeDetails(input.details),
    });
  } catch (error) {
    console.error('[app-runtime-events] 写入运行事件失败:', error);
  }
}

registerPurgeTask(async (now) => {
  const retentionDays = getSettingInt('AUDIT_RETENTION_DAYS', 90);
  await getDb()
    .delete(appRuntimeEvents)
    .where(lt(appRuntimeEvents.ts, now - retentionDays * 86_400_000));
});
