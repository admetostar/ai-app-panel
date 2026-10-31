import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { getDb } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import type { SessionUser } from '../types.js';
import {
  createSession,
  destroySessionByToken,
  forceFlowGate,
  hashToken,
  loadSessionByToken,
  mustEnrollMfaFor,
} from '../lib/session.js';

let dir: string;

/** 最小 Response stub：捕获 cookie 写入 */
function stubRes(): { res: Response; cookie: () => { name: string; value: string } | null } {
  const holder: { cookie: { name: string; value: string } | null } = { cookie: null };
  const res = {
    cookie(name: string, value: string) {
      holder.cookie = { name, value };
    },
    clearCookie() {
      holder.cookie = null;
    },
  } as unknown as Response;
  return { res, cookie: () => holder.cookie };
}

async function insertUser(username: string, status = 'active'): Promise<number> {
  const [info] = await getDb()
    .insert(users)
    .values({ kind: 'local', username, name: username, role: 'user', status, createdAt: Date.now() })
    .returning({ id: users.id });
  return info!.id;
}

beforeAll(async () => {
  ({ dir } = await setupTestDb());
});
afterAll(async () => await teardownTestDb(dir));

describe('session（统一 users 表）', () => {
  it('创建→装载→登出 全链路', async () => {
    const uid = await insertUser('alice');
    const { res, cookie } = stubRes();
    const token = await createSession(res, { id: uid }, { ip: '1.2.3.4', userAgent: 'vitest' });
    expect(cookie()).toMatchObject({ name: 'aap_sid' });

    const u = await loadSessionByToken(token);
    expect(u).not.toBeNull();
    expect(u!.id).toBe(uid);
    expect(u!.kind).toBe('local');
    expect(u!.subject).toBe('local:alice');
    expect(u!.authState).toBe('full');

    await destroySessionByToken(token);
    expect(await loadSessionByToken(token)).toBeNull();
  });

  it('半登录态（password_ok）被原样装载（W4 状态机数据基础）', async () => {
    const uid = await insertUser('bob');
    const { res } = stubRes();
    const token = await createSession(res, { id: uid }, { authState: 'password_ok' });
    expect((await loadSessionByToken(token))!.authState).toBe('password_ok');
  });

  it('过期会话装载即删', async () => {
    const uid = await insertUser('carol');
    const token = 'tok-expired-test';
    const now = Date.now();
    await getDb().insert(sessions).values({
      tokenHash: hashToken(token),
      userId: uid,
      authState: 'full',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now - 1000,
    });
    expect(await loadSessionByToken(token)).toBeNull();
    expect(await getDb().select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)))).toHaveLength(0);
  });

  it('禁用用户会话即刻作废', async () => {
    const uid = await insertUser('dave', 'disabled');
    const { res } = stubRes();
    const token = await createSession(res, { id: uid }, {});
    expect(await loadSessionByToken(token)).toBeNull();
  });

  it('token 只存 SHA-256 哈希', async () => {
    const uid = await insertUser('erin');
    const { res } = stubRes();
    const token = await createSession(res, { id: uid }, {});
    const rows = await getDb().select({ tokenHash: sessions.tokenHash }).from(sessions);
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === hashToken(token))).toBe(true);
  });
});

describe('forceFlowGate / mustEnrollMfaFor（终审 P1-6）', () => {
  /** 以 stub req/res 驱动门禁中间件，捕获 403 契约或 next 放行 */
  function runGate(user: Partial<SessionUser> | null, url: string): {
    status: number;
    code: string | null;
    action: string | null;
    passed: boolean;
  } {
    const out = { status: 200, code: null as string | null, action: null as string | null, passed: false };
    const req = { user, originalUrl: url } as unknown as Request;
    const res = {
      status(s: number) {
        out.status = s;
        return {
          json(b: { error?: { code?: string; action?: string } }) {
            out.code = b.error?.code ?? null;
            out.action = b.error?.action ?? null;
          },
        };
      },
    } as unknown as Response;
    forceFlowGate(req, res, () => {
      out.passed = true;
    });
    return out;
  }

  it('mustEnrollMfaFor：local admin 未绑 → true；OIDC admin（MFA 委托 IdP）→ false', () => {
    expect(mustEnrollMfaFor({ kind: 'local', role: 'admin', mfaEnabled: false })).toBe(true);
    expect(mustEnrollMfaFor({ kind: 'local', role: 'admin', mfaEnabled: true })).toBe(false);
    expect(mustEnrollMfaFor({ kind: 'oidc', role: 'admin', mfaEnabled: false })).toBe(false);
    expect(mustEnrollMfaFor({ kind: 'local', role: 'user', mfaEnabled: false })).toBe(false);
  });

  it('匿名请求与正常会话直接放行', () => {
    expect(runGate(null, '/api/apps').passed).toBe(true);
    expect(runGate({ mustChangePassword: false, kind: 'local', role: 'user', mfaEnabled: false }, '/api/apps').passed).toBe(true);
    expect(runGate({ mustChangePassword: false, kind: 'local', role: 'admin', mfaEnabled: true }, '/api/apps').passed).toBe(true);
  });

  it('mustChangePassword 会话：业务端点 403 FORCE_CHANGE_PASSWORD；白名单放行', () => {
    const u: Partial<SessionUser> = { mustChangePassword: true, kind: 'local', role: 'user', mfaEnabled: false };
    const blocked = runGate(u, '/api/apps');
    expect(blocked.passed).toBe(false);
    expect(blocked.status).toBe(403);
    expect(blocked.code).toBe('FORCE_CHANGE_PASSWORD');
    expect(blocked.action).toBe('change-password');
    // /me 永不被拦（前端靠它拿状态）；改密/登出放行
    expect(runGate(u, '/api/auth/me').passed).toBe(true);
    expect(runGate(u, '/api/auth/change-password').passed).toBe(true);
    expect(runGate(u, '/api/auth/logout').passed).toBe(true);
  });

  it('local admin 未绑 MFA：403 FORCE_ENROLL_MFA；mfa/step-up/bootstrap 白名单放行', () => {
    const u: Partial<SessionUser> = { mustChangePassword: false, kind: 'local', role: 'admin', mfaEnabled: false };
    const blocked = runGate(u, '/api/admin/users?page=1');
    expect(blocked.passed).toBe(false);
    expect(blocked.status).toBe(403);
    expect(blocked.code).toBe('FORCE_ENROLL_MFA');
    expect(blocked.action).toBe('mfa');
    expect(runGate(u, '/api/auth/mfa/totp/enroll').passed).toBe(true);
    expect(runGate(u, '/api/auth/step-up/password').passed).toBe(true);
    expect(runGate(u, '/api/portal/bootstrap').passed).toBe(true);
  });

  it('OIDC admin 不受强制绑定门禁（mfaEnabled 恒默认 false，委托 IdP）', () => {
    expect(runGate({ mustChangePassword: false, kind: 'oidc', role: 'admin', mfaEnabled: false }, '/api/apps').passed).toBe(true);
    // 但 mustChangePassword 对 OIDC 账号同样生效（判据只看这两个标记）
    expect(runGate({ mustChangePassword: true, kind: 'oidc', role: 'admin', mfaEnabled: false }, '/api/apps').code).toBe('FORCE_CHANGE_PASSWORD');
  });
});
