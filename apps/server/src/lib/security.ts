import type { Request } from 'express';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { ipBans, loginAttempts, powTokens } from '../db/schema.js';
import { getSettingInt, getSettingBool } from './settings.js';
import { audit } from './audit.js';

export function getClientIp(req: Request): string {
  return ((req.ip as string | undefined) || req.socket?.remoteAddress || '')
    .replace(/^::ffff:/, '') || 'unknown';
}

interface BanRow {
  ip: string;
  banned_until: number;
  repeat_count: number;
  created_at: number;
}

export interface FailureResult {
  banned: boolean;
  failures: number;
  bannedUntil?: number;
}

async function failuresBy(column: 'ip' | 'userKey', value: string): Promise<number> {
  const window = getSettingInt('LOGIN_FAIL_WINDOW', 600);
  const field = column === 'ip' ? loginAttempts.ip : loginAttempts.userKey;
  const row = (await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(field, value), eq(loginAttempts.success, false), gt(loginAttempts.createdAt, Date.now() - window * 1000))))[0];
  return Number(row?.count ?? 0);
}

export async function failuresInWindow(ip: string): Promise<number> {
  return await failuresBy('ip', ip);
}

export async function accountFailuresInWindow(userKey: string): Promise<number> {
  return await failuresBy('userKey', userKey);
}

export async function isBanned(ip: string): Promise<BanRow | null> {
  const row = (await getDb()
    .select({
      ip: ipBans.ip,
      banned_until: ipBans.bannedUntil,
      repeat_count: ipBans.repeatCount,
      created_at: ipBans.createdAt,
    })
    .from(ipBans)
    .where(eq(ipBans.ip, ip)))[0];
  return row && row.banned_until > Date.now() ? row : null;
}

export async function recordFailure(ip: string, subject: string | null, reason?: string): Promise<FailureResult> {
  await getDb().insert(loginAttempts).values({
    ip,
    userKey: subject ?? '',
    success: false,
    reason: reason ?? null,
    createdAt: Date.now(),
  });

  const threshold = getSettingInt('IP_BAN_THRESHOLD', 10);
  const fails = await failuresInWindow(ip);
  const existing = (await getDb().select().from(ipBans).where(eq(ipBans.ip, ip)))[0];
  if (fails >= threshold && (!existing || existing.bannedUntil <= Date.now())) {
    const base = getSettingInt('IP_BAN_BASE_SECONDS', 3600);
    const max = getSettingInt('IP_BAN_MAX_SECONDS', 86400);
    const mult = getSettingInt('IP_BAN_MULTIPLIER', 2);
    const repeat = existing ? existing.repeatCount : 0;
    const duration = Math.min(base * Math.pow(mult, repeat), max);
    const until = Date.now() + duration * 1000;
    await getDb()
      .insert(ipBans)
      .values({ ip, bannedUntil: until, repeatCount: 1, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: ipBans.ip,
        set: {
          bannedUntil: until,
          repeatCount: sql`${ipBans.repeatCount} + 1`,
        },
      });
    void audit(subject ?? ip, ip, 'ip.ban.auto', { reason, failures: fails, banned_until: until, duration_sec: duration });
    return { banned: true, failures: fails, bannedUntil: until };
  }
  return { banned: false, failures: fails };
}

export async function recordSuccess(ip: string, subject: string | null): Promise<void> {
  await getDb().insert(loginAttempts).values({
    ip,
    userKey: subject ?? '',
    success: true,
    reason: null,
    createdAt: Date.now(),
  });
}

export async function recordMfaFailure(userKey: string): Promise<void> {
  await getDb().insert(loginAttempts).values({
    ip: 'mfa-guard',
    userKey,
    success: false,
    reason: 'totp-mismatch',
    createdAt: Date.now(),
  });
}

export async function mfaFailuresInWindow(userKey: string): Promise<number> {
  return await accountFailuresInWindow(userKey);
}

export async function clearMfaFailures(userKey: string): Promise<void> {
  await getDb()
    .delete(loginAttempts)
    .where(and(eq(loginAttempts.userKey, userKey), eq(loginAttempts.success, false)));
}

export async function issuePowToken(ip: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const ttl = getSettingInt('POW_TOKEN_TTL', 300);
  await getDb().insert(powTokens).values({ token, ip, createdAt: now, expiresAt: now + ttl * 1000 });
  return token;
}

export async function consumePowToken(token: string, ip: string): Promise<boolean> {
  const [row] = await getDb()
    .delete(powTokens)
    .where(eq(powTokens.token, token))
    .returning({ expiresAt: powTokens.expiresAt, ip: powTokens.ip });
  return Boolean(row && row.expiresAt > Date.now() && row.ip === ip);
}

export async function needsPow(ip: string, userKey?: string | null): Promise<boolean> {
  if (!getSettingBool('POW_ENABLED', true)) return false;
  const threshold = getSettingInt('LOGIN_FAIL_THRESHOLD', 5);
  if ((await failuresInWindow(ip)) >= threshold) return true;
  return Boolean(userKey && (await accountFailuresInWindow(userKey)) >= threshold);
}

export async function powDifficulty(ip: string): Promise<number> {
  const base = getSettingInt('POW_DIFFICULTY_BASE', 16);
  const step = getSettingInt('POW_DIFFICULTY_STEP', 2);
  const max = getSettingInt('POW_DIFFICULTY_MAX', 24);
  const over = Math.max(0, (await failuresInWindow(ip)) - getSettingInt('LOGIN_FAIL_THRESHOLD', 5));
  return Math.min(base + over * step, max);
}
