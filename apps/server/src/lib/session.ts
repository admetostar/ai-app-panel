/**
 * 服务端会话——移植自参考实现 lib/session.js，适配统一 users 表：
 *  - token 随机 32B（base64url），DB 只存 SHA-256；
 *  - cookie httpOnly + sameSite=lax；Secure 在 HTTPS 启用后由 tls 模块置位（W6）；
 *  - 登录状态机：auth_state = password_ok → mfa_pending → full（W4 激活）；
 *  - loadSessionByToken 同时服务 Express 中间件与裸 req（WS upgrade，W5）。
 */
import type { Request, RequestHandler, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AuthState } from '@aap/shared';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { sha256Hex } from './passwords.js';
import { getSetting, getSettingInt } from './settings.js';
import type { SessionUser } from '../types.js';

export const hashToken = sha256Hex;

/** 步升认证有效期（秒）：重验一次因子后 5 分钟内免重验 */
export function stepUpTtlSec(): number {
  return getSettingInt('MFA_STEPUP_TTL', 300);
}

// HTTPS 状态由 tls 模块（W6）在证书启用/移除时调用
let secureCookieOverride: boolean | null = null;
export function setSecureCookie(v: boolean | null): void {
  secureCookieOverride = v;
}

export function sessionTtlSec(): number {
  return getSettingInt('SESSION_TTL', 86400);
}

interface CookieOpts {
  httpOnly: true;
  sameSite: 'lax';
  maxAge: number;
  path: '/';
  domain?: string;
  secure?: true;
}

function cookieOptions(): CookieOpts {
  const opts: CookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: sessionTtlSec() * 1000,
    path: '/',
  };
  const domain = (getSetting('SITE_DOMAIN') ?? '').trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (domain) opts.domain = domain;
  if (secureCookieOverride) opts.secure = true;
  return opts;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

interface SessionJoinRow {
  token_hash: string;
  auth_state: string;
  step_up_until: number | null;
  expires_at: number;
  last_seen_at: number;
  u_id: number;
  kind: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  name: string;
  role: string;
  status: string;
  plan: string;
  mfa_enabled: number;
  must_change_password: number;
  membership_selection_required: number;
}

/**
 * 按会话 token（明文）装载用户；过期/用户禁用即删会话返回 null。
 * 独立成函数以便 WS upgrade（裸 req）复用。
 */
export async function loadSessionByToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = (await getDb()
    .select({
      token_hash: sessions.tokenHash,
      auth_state: sessions.authState,
      step_up_until: sessions.stepUpUntil,
      expires_at: sessions.expiresAt,
      last_seen_at: sessions.lastSeenAt,
      u_id: users.id,
      kind: users.kind,
      username: users.username,
      email: users.email,
      phone: users.phone,
      name: users.name,
      role: users.role,
      status: users.status,
      plan: users.plan,
      mfa_enabled: users.mfaEnabled,
      must_change_password: users.mustChangePassword,
      membership_selection_required: users.membershipSelectionRequired,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash)))[0];
  if (!row) return null;

  if (row.expires_at <= Date.now()) {
    await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  // 用户被禁用/待批准：会话即刻作废（deletion_pending 仍可登录以便撤回注销）
  if (row.status === 'disabled' || row.status === 'pending_approval') {
    await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }

  // lastSeenAt 节流刷新（≥60s 才写，避免每请求写放大）
  if (Date.now() - row.last_seen_at > 60_000) {
    await getDb().update(sessions).set({ lastSeenAt: Date.now() }).where(eq(sessions.tokenHash, tokenHash));
  }

  return {
    id: row.u_id,
    kind: row.kind === 'oidc' ? 'oidc' : 'local',
    subject: row.kind === 'oidc' ? `oidc:${row.email ?? row.u_id}` : `local:${row.username ?? row.u_id}`,
    username: row.username,
    email: row.email,
    phone: row.phone,
    name: row.name || row.username || `用户${row.u_id}`,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status,
    plan: row.plan === 'member' ? 'member' : 'free',
    sessionId: row.token_hash,
    authState: (row.auth_state as AuthState) || 'full',
    stepUpUntil: row.step_up_until ?? null,
    mfaEnabled: row.mfa_enabled,
    mustChangePassword: row.must_change_password,
    membershipSelectionRequired: row.membership_selection_required,
  };
}

/** 创建会话并种 cookie；authState 供 MFA 状态机（W4）。
 *  grantStepUp：登录即授予步升窗口——密码/Passkey/邮箱码本身就是刚验证过的
 *  因子，强制绑 MFA（F3）因此可在登录后立即进行；窗口过期后的敏感操作仍需
 *  重验因子（防被劫持会话静默绑定新 MFA，渗透测试 P2-9）。 */
export async function createSession(
  res: Response,
  user: { id: number },
  opts: { ip?: string | null; userAgent?: string | null; authState?: AuthState; ttlSec?: number; grantStepUp?: boolean },
): Promise<string> {
  const token = generateToken();
  const now = Date.now();
  const ttl = opts.ttlSec ?? sessionTtlSec();
  const expiresAt = now + ttl * 1000;
  const stepUpUntil = opts.grantStepUp ? now + stepUpTtlSec() * 1000 : null;
  await getDb().insert(sessions).values({
    tokenHash: hashToken(token),
    userId: user.id,
    authState: opts.authState ?? 'full',
    stepUpUntil,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: opts.ip ?? null,
    userAgent: (opts.userAgent ?? '').slice(0, 255),
  });
  await getDb().update(users).set({ lastLoginAt: now, lastIp: opts.ip ?? null }).where(eq(users.id, user.id));
  res.cookie(config.sessionCookieName, token, cookieOptions());
  return token;
}

/** 登出 / 踢下线共用：按 token 哈希删行 */
export async function destroySessionByToken(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** 登录状态机推进：password_ok → full（MFA 验证通过） */
export async function upgradeSessionToFull(tokenHash: string): Promise<void> {
  await getDb().update(sessions).set({ authState: 'full' }).where(eq(sessions.tokenHash, tokenHash));
}

/** 敏感操作步升认证：重验一次因子后 5 分钟内免重验（A3） */
export async function markStepUp(tokenHash: string): Promise<number> {
  const ttl = getSettingInt('MFA_STEPUP_TTL', 300);
  const until = Date.now() + ttl * 1000;
  await getDb().update(sessions).set({ stepUpUntil: until }).where(eq(sessions.tokenHash, tokenHash));
  return until;
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  await destroySessionByToken(req.cookies?.[config.sessionCookieName]);
  res.clearCookie(config.sessionCookieName, { path: '/' });
}

/** Express 中间件：装载 req.user（未登录保持 undefined） */
export const sessionMiddleware: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[config.sessionCookieName];
  void loadSessionByToken(token).then((user) => {
    req.user = user ?? undefined;
    next();
  }, next);
};

// ---------- 强制流程门禁（F3/A3：强制改密 / admin 强制绑 MFA） ----------

/** admin 强制绑 MFA 判定：仅本账（local）用户。
 *  OIDC 账号 MFA 委托 IdP（ADR），其 mfaEnabled 默认 false，
 *  纳入判定会把 OIDC 管理员锁死在绑定页（终审 P1-6c），故排除。 */
export function mustEnrollMfaFor(u: { kind: string; role: string; mfaEnabled: boolean }): boolean {
  return u.kind === 'local' && u.role === 'admin' && !u.mfaEnabled;
}

/** 门禁白名单：强制流程自身所需端点 + 状态读取。
 *  匿名可读端点（portal bootstrap/品牌等）不要求登录，但浏览器带会话 cookie
 *  访问时同样放行，否则强制流程页面连品牌信息都拿不到。 */
const FORCE_GATE_ALLOW: RegExp[] = [
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/change-password$/,
  /^\/api\/auth\/mfa(\/|$)/,
  /^\/api\/auth\/step-up(\/|$)/,
  /^\/api\/portal\/bootstrap$/,
];

/**
 * 强制流程门禁：mustChangePassword 或（local admin 且未绑 MFA）的会话，
 * 除白名单端点外一律 403（契约 FORCE_CHANGE_PASSWORD / FORCE_ENROLL_MFA）。
 * 挂在 /api 中间件链（sessionMiddleware 之后、业务路由之前）；req.user 的
 * mustChangePassword/mfaEnabled/role 由 loadSessionByToken 装载。
 */
export const forceFlowGate: RequestHandler = (req, res, next) => {
  const u = req.user;
  if (!u) {
    next();
    return;
  }
  const mustEnroll = mustEnrollMfaFor(u);
  if (!u.mustChangePassword && !mustEnroll) {
    next();
    return;
  }
  const p = (req.originalUrl ?? req.url).split('?')[0]!;
  if (FORCE_GATE_ALLOW.some((re) => re.test(p))) {
    next();
    return;
  }
  if (u.mustChangePassword) {
    res.status(403).json({
      error: { code: 'FORCE_CHANGE_PASSWORD', message: '请先修改密码后再继续操作', action: 'change-password' },
    });
    return;
  }
  res.status(403).json({
    error: { code: 'FORCE_ENROLL_MFA', message: '管理员账号须先绑定多因子认证', action: 'mfa' },
  });
};
