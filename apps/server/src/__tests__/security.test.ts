import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { getDb } from '../db/index.js';
import { ipBans, loginAttempts } from '../db/schema.js';
import {
  accountFailuresInWindow,
  clearMfaFailures,
  consumePowToken,
  failuresInWindow,
  isBanned,
  mfaFailuresInWindow,
  needsPow,
  powDifficulty,
  recordFailure,
  recordMfaFailure,
  recordSuccess,
} from '../lib/security.js';
import { hasLeadingZeroBits, issueChallenge, verifyPow } from '../lib/pow.js';

let dir: string;
const IP = '203.0.113.10';

beforeAll(async () => {
  ({ dir } = await setupTestDb());
});
afterAll(async () => await teardownTestDb(dir));

describe('security（失败计数 + IP 封禁累犯倍增）', () => {
  it('初始无失败、不封禁、不需要 PoW', async () => {
    expect(await failuresInWindow(IP)).toBe(0);
    expect(await isBanned(IP)).toBeNull();
    expect(await needsPow(IP)).toBe(false);
    expect(await powDifficulty(IP)).toBe(16);
  });

  it('失败达阈值后要求 PoW；超过阈值后难度按步进提升', async () => {
    for (let i = 0; i < 5; i++) await recordFailure(IP, 'local:alice', 'bad-password');
    expect(await failuresInWindow(IP)).toBe(5);
    expect(await needsPow(IP)).toBe(true);
    expect(await powDifficulty(IP)).toBe(16); // 达阈值：over=0 → base
    await recordFailure(IP, 'local:alice', 'bad-password'); // 6
    expect(await powDifficulty(IP)).toBe(18); // over=1 → base+step
  });

  it('成功登录不计入失败窗口（窗口滑动，不因成功清零）', async () => {
    await recordSuccess(IP, 'local:alice');
    expect(await failuresInWindow(IP)).toBe(6);
  });

  it('失败达 IP_BAN_THRESHOLD 触发自动封禁（base 时长）', async () => {
    let banned = false;
    for (let i = 0; i < 10 && !banned; i++) {
      banned = (await recordFailure(IP, 'local:alice', 'brute')).banned;
    }
    expect(banned).toBe(true);
    const ban = await isBanned(IP);
    expect(ban).not.toBeNull();
    expect(ban!.repeat_count).toBe(1);
    expect(ban!.banned_until - Date.now()).toBeGreaterThan(3500_000); // base 3600s
  });

  it('累犯封禁时长翻倍（repeat_count +1 → base*2^1）', async () => {
    // 人为使封禁过期（不删行，保住 repeat_count）
    await getDb().update(ipBans).set({ bannedUntil: Date.now() - 1 }).where(eq(ipBans.ip, IP));
    expect(await isBanned(IP)).toBeNull();
    let banned = false;
    for (let i = 0; i < 10 && !banned; i++) {
      banned = (await recordFailure(IP, 'local:alice', 'brute-again')).banned;
    }
    expect(banned).toBe(true);
    const ban = (await isBanned(IP))!;
    expect(ban.repeat_count).toBe(2);
    expect(ban.banned_until - Date.now()).toBeGreaterThan(7000_000); // 3600*2 = 7200s
  });
});

describe('pow challenge/verify（服务端全流程）', () => {
  const IP2 = '203.0.113.99';

  it('签发→解题→换 token→一次性消费', async () => {
    expect(await needsPow(IP2)).toBe(false); // 未失败也可主动走 PoW（注册等场景）
    const ch = await issueChallenge(IP2);
    let nonce = 0;
    for (;; nonce++) {
      const h = createHash('sha256').update(`${ch.seed}:${nonce}`).digest('hex');
      if (hasLeadingZeroBits(h, ch.difficulty)) break;
    }
    const v = await verifyPow(ch.challengeId, String(nonce), IP2);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(await consumePowToken(v.token, IP2)).toBe(true);
    expect(await consumePowToken(v.token, IP2)).toBe(false); // 一次性
  });

  it('挑战读后即删（重放拒绝）、IP 不匹配拒绝、nonce 非法拒绝', async () => {
    const ch = await issueChallenge(IP2);
    expect(await verifyPow(ch.challengeId, '1', '6.6.6.6')).toMatchObject({ ok: false, error: 'IP_MISMATCH' });
    // 上一步已消费该挑战
    expect(await verifyPow(ch.challengeId, '1', IP2)).toMatchObject({ ok: false, error: 'CHALLENGE_NOT_FOUND' });

    const ch2 = await issueChallenge(IP2);
    expect(await verifyPow(ch2.challengeId, 'abc', IP2)).toMatchObject({ ok: false, error: 'INVALID_NONCE' });
    expect((await verifyPow(ch2.challengeId, '0', IP2)).ok).toBe(false); // 解不对
    expect(await verifyPow('no-such', '1', IP2)).toMatchObject({ ok: false, error: 'CHALLENGE_NOT_FOUND' });
  });
});

describe('MFA 账号维度错猜计数（终审 P1-3）', () => {
  const KEY = 'mfa:777';

  it('持久计数（login_attempts）、命名空间隔离、成功清零、不污染 IP 维度', async () => {
    expect(await mfaFailuresInWindow(KEY)).toBe(0);
    for (let i = 0; i < 4; i++) await recordMfaFailure(KEY);
    expect(await mfaFailuresInWindow(KEY)).toBe(4);
    await recordMfaFailure(KEY);
    expect(await mfaFailuresInWindow(KEY)).toBe(5);

    // 计数落在 login_attempts 表（重启不丢），subject 用 mfa:<userId> 命名空间
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.userKey, KEY), eq(loginAttempts.success, false)));
    expect(Number(row?.n ?? 0)).toBe(5);
    // 命名空间隔离：不影响其他账号/其他维度
    expect(await accountFailuresInWindow('mfa:778')).toBe(0);
    expect(await accountFailuresInWindow('local:someone')).toBe(0);

    // 哨兵 ip='mfa-guard'：不污染真实 IP 的失败窗口与 PoW 判定
    expect(await failuresInWindow('198.51.100.7')).toBe(0);
    expect(await needsPow('198.51.100.7')).toBe(false);
    expect(await isBanned('198.51.100.7')).toBeNull();

    // 成功验证清零（防正常用户被误锁）
    await clearMfaFailures(KEY);
    expect(await mfaFailuresInWindow(KEY)).toBe(0);
  });
});
