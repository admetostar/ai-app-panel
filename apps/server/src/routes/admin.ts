/**
 * 管理后台 API：用户管理、运行时安全策略（settings）、审计查询与系统总览。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express, { Router } from 'express';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { AAP_VERSION, isPasswordValid, PASSWORD_POLICY_MESSAGE } from '@aap/shared';
import { getDb } from '../db/index.js';
import { apps, auditLogs, inviteCodes, llmLedger, membershipPlans, sessions, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { publicUserOf } from './shared.js';
import { getEmailChannel, outboundMailConfigured } from '../lib/verification.js';
import { generatePassword } from '../lib/passwords.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import { listSettingsForAdmin, updateSettingFromAdmin, SETTING_DEFS, getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { stopAllPersistent } from '../lib/sandbox.js';
import {
  createGroup,
  deleteGroup,
  groupMemberIds,
  listGroups,
  parseAppPublishRewardPoints,
  setGroupMembers,
  updateGroup,
} from '../lib/groups.js';
import { defaultAvatarForUser } from '../lib/userAvatar.js';
import { config } from '../config/index.js';
import { ensureInviteCode } from '../lib/invites.js';

export const adminRouter = Router();

const NETWORK_BANDWIDTH_LIMIT_MBPS = 10;
let previousCpuSample: { total: number; idle: number } | null = null;
let previousNetworkSample: { received: number; sent: number; sampledAt: number } | null = null;
let networkReadWarningLogged = false;

function readCpuUsagePercent(): number | null {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, value) => a + value, 0), 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const previous = previousCpuSample;
  previousCpuSample = { total, idle };
  if (!previous || total <= previous.total) return null;
  return Math.max(0, Math.min(100, (1 - (idle - previous.idle) / (total - previous.total)) * 100));
}

async function readNetworkUsage(): Promise<{
  available: boolean;
  receiveMbps: number;
  sendMbps: number;
  percent: number;
  capacityMbps: number;
  reason?: string;
}> {
  const capacityMbps = NETWORK_BANDWIDTH_LIMIT_MBPS;
  if (os.platform() !== 'linux') {
    return {
      available: false,
      receiveMbps: 0,
      sendMbps: 0,
      percent: 0,
      capacityMbps,
      reason: '网络带宽计数器当前仅支持 Linux',
    };
  }
  try {
    const text = await fs.promises.readFile('/proc/net/dev', 'utf8');
    let received = 0;
    let sent = 0;
    for (const line of text.split('\n').slice(2)) {
      const separator = line.indexOf(':');
      if (separator < 0 || line.slice(0, separator).trim() === 'lo') continue;
      const values = line.slice(separator + 1).trim().split(/\s+/).map(Number);
      if (values.length < 9 || values.some((value) => !Number.isFinite(value))) continue;
      received += values[0] ?? 0;
      sent += values[8] ?? 0;
    }
    const sampledAt = Date.now();
    const previous = previousNetworkSample;
    previousNetworkSample = { received, sent, sampledAt };
    if (!previous || sampledAt <= previous.sampledAt) {
      return { available: false, receiveMbps: 0, sendMbps: 0, percent: 0, capacityMbps, reason: '正在采集带宽基准' };
    }
    const elapsedSeconds = (sampledAt - previous.sampledAt) / 1000;
    const receiveMbps = Math.max(0, ((received - previous.received) * 8) / elapsedSeconds / 1_000_000);
    const sendMbps = Math.max(0, ((sent - previous.sent) * 8) / elapsedSeconds / 1_000_000);
    const percent = Math.max(0, Math.min(100, ((receiveMbps + sendMbps) / capacityMbps) * 100));
    return { available: true, receiveMbps, sendMbps, percent, capacityMbps };
  } catch (error) {
    if (!networkReadWarningLogged) {
      console.warn('[admin overview] network counters unavailable:', error);
      networkReadWarningLogged = true;
    }
    return {
      available: false,
      receiveMbps: 0,
      sendMbps: 0,
      percent: 0,
      capacityMbps,
      reason: error instanceof Error ? error.message : '系统网络接口计数器不可用',
    };
  }
}

function normalizeSiteDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return '';
  if (
    domain.length > 253 ||
    isIP(domain) !== 0 ||
    domain.includes('://') ||
    domain.includes('/') ||
    domain.includes(':') ||
    domain.includes('*') ||
    domain.split('.').some((label) => !/^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new HttpError(400, 'INVALID_SETTING', '本站域名必须是有效的主机名，不要包含协议、端口、路径或通配符');
  }
  return domain;
}

adminRouter.use('/admin', requireAdmin);

adminRouter.post(
  '/admin/site-logo',
  express.json({ limit: '8mb' }),
  h(async (req, res) => {
    const body = (req.body ?? {}) as { dataBase64?: unknown };
    const encoded = body.dataBase64;
    const maxBytes = 5 * 1024 * 1024;
    const maxBase64Length = Math.ceil(maxBytes / 3) * 4;
    if (
      typeof encoded !== 'string' ||
      encoded.length === 0 ||
      encoded.length > maxBase64Length ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new HttpError(400, 'INVALID_LOGO', '请上传有效的图片文件（最大 5 MB）');
    }

    const image = Buffer.from(encoded, 'base64');
    if (image.length === 0 || image.length > maxBytes || image.toString('base64') !== encoded) {
      throw new HttpError(400, 'INVALID_LOGO', '请上传有效的图片文件（最大 5 MB）');
    }

    const extension = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'png'
      : image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        ? 'jpg'
        : image.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)
          ? 'gif'
          : image.length >= 12 &&
              image.subarray(0, 4).toString('ascii') === 'RIFF' &&
              image.subarray(8, 12).toString('ascii') === 'WEBP'
            ? 'webp'
            : null;
    if (!extension) {
      throw new HttpError(400, 'UNSUPPORTED_LOGO_FORMAT', 'Logo 仅支持 PNG、JPEG、GIF 或 WebP 图片');
    }

    const filename = `logo-${randomBytes(16).toString('hex')}.${extension}`;
    const logoDir = path.join(config.dataDir, 'admin', 'site-logo');
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(path.join(logoDir, filename), image, { flag: 'wx', mode: 0o644 });

    const logoPath = `/uploads/sitelogo/${filename}`;
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'config.logo.uploaded', {
      bytes: image.length,
      extension,
    });
    res.json({ path: logoPath });
  }),
);

// ---------- 用户管理 ----------

adminRouter.get(
  '/admin/users',
  h(async (_req, res) => {
    const rows = await getDb().select().from(users).orderBy(sql`id`);
    res.json({ users: rows.map(publicUserOf) });
  }),
);

adminRouter.post(
  '/admin/users',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; role?: string; name?: string };
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '') || generatePassword(12);
    if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
      throw new HttpError(400, 'INVALID_USERNAME', '用户名需 3-64 位小写字母/数字/_.-');
    }
    if (!isPasswordValid(password)) throw new HttpError(400, 'INVALID_PASSWORD', PASSWORD_POLICY_MESSAGE);
    if ((await getDb().select({ id: users.id }).from(users).where(eq(users.username, username)))[0]) {
      throw new HttpError(409, 'USERNAME_TAKEN', '用户名已被占用');
    }
    const [created] = await getDb()
      .insert(users)
      .values({
        kind: 'local',
        username,
        name: body.name?.trim() || username,
        role: body.role === 'admin' ? 'admin' : 'user',
        mustChangePassword: true,
        createdAt: Date.now(),
      })
      .returning({ id: users.id });
    if (!created) throw new Error('Failed to create user');
    const uid = created.id;
    await ensureInviteCode(uid);
    await getDb().update(users).set({ avatar: defaultAvatarForUser(uid) }).where(eq(users.id, uid));
    await writeLocalCredentials(uid, password);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.created', { uid, username });
    res.json({ ok: true, id: uid, initialPassword: password });
  }),
);

adminRouter.put(
  '/admin/users/:id',
  h(async (req, res) => {
    const uid = Number(req.params.id);
    const target = (await getDb().select().from(users).where(eq(users.id, uid)))[0];
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = (req.body ?? {}) as { status?: string; role?: string };

    // 角色变更（设为管理员/取消管理员）
    if (body.role !== undefined) {
      const role = body.role === 'admin' || body.role === 'user' ? body.role : null;
      if (!role) throw new HttpError(400, 'INVALID_ROLE', '角色必须是 admin/user');
      if (uid === req.user!.id) throw new HttpError(400, 'CANNOT_MODIFY_SELF_ROLE', '不能修改自己的角色（防自锁）');
      if (target.role === 'admin' && role === 'user') {
        const admins = Number((await getDb().select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin')))[0]?.n ?? 0);
        if (admins <= 1) throw new HttpError(409, 'LAST_ADMIN', '至少保留一名管理员');
      }
      await getDb().update(users).set({ role }).where(eq(users.id, uid));
      // 角色每请求随会话装载读取，变更即时生效，无需踢会话
      await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.role', { uid, role });
    }

    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        throw new HttpError(400, 'INVALID_STATUS', '状态必须是 active/disabled');
      }
      if (body.status === 'active' && target.status === 'pending_approval') {
        await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.approved', { userId: uid });
      }
      // 防自锁：不能禁用自己（参考实现 H 项）
      if (uid === req.user!.id) throw new HttpError(400, 'CANNOT_DISABLE_SELF', '不能禁用自己的账号');
      await getDb().update(users).set({ status: body.status }).where(eq(users.id, uid));
      if (body.status === 'disabled') {
        await getDb().delete(sessions).where(eq(sessions.userId, uid)); // 禁用即踢下线
      }
      await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.status', { uid, status: body.status });
    }
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/admin/users/:id/reset-password',
  h(async (req, res) => {
    const uid = Number(req.params.id);
    const target = (await getDb().select().from(users).where(eq(users.id, uid)))[0];
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = (req.body ?? {}) as { password?: string };
    const password = String(body.password ?? '') || generatePassword(12);
    if (!isPasswordValid(password)) throw new HttpError(400, 'INVALID_PASSWORD', PASSWORD_POLICY_MESSAGE);
    // upsert：OIDC 用户没有本地凭据行，直接 UPDATE 会静默无效（下发的密码登录不上）
    await writeLocalCredentials(uid, password);
    await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, uid));
    await getDb().delete(sessions).where(eq(sessions.userId, uid)); // 重置即全端踢下线
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.password_reset', { uid });
    res.json({ ok: true, password });
  }),
);

adminRouter.delete(
  '/admin/users/:id',
  h(async (req, res) => {
    const uid = Number(req.params.id);
    if (uid === req.user!.id) throw new HttpError(400, 'CANNOT_DELETE_SELF', '不能删除自己的账号');
    const target = (await getDb().select().from(users).where(eq(users.id, uid)))[0];
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    await getDb().delete(users).where(eq(users.id, uid));
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.deleted', { uid });
    res.json({ ok: true });
  }),
);

// ---------- 运行时安全策略（settings；保存即生效） ----------

adminRouter.get(
  '/admin/settings',
  h(async (_req, res) => {
    res.json({
      settings: (await listSettingsForAdmin()).map((s) => ({
        key: s.key,
        value: s.value,
        label: s.def.label,
        type: s.def.type,
        group: s.def.group,
        options: s.def.options,
        choiceLabels: s.def.choiceLabels,
        exclusiveOf: s.def.exclusiveOf,
        desc: s.def.desc,
        secret: Boolean(s.def.secret),
        advanced: Boolean(s.def.advanced),
        defaultsWork: s.def.defaultsWork !== false,
      })),
    });
  }),
);

adminRouter.put(
  '/admin/settings',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const keys = Object.keys(body);
    for (const key of keys) {
      if (!SETTING_DEFS[key]) throw new HttpError(400, 'UNKNOWN_SETTING', `未知配置项: ${key}`);
      if (key === 'SITE_DOMAIN') {
        body[key] = normalizeSiteDomain(String(body[key] ?? ''));
      }
      if (key === 'REGISTRATION_POINTS_GIFT') {
        const points = Number(body[key]);
        if (!Number.isSafeInteger(points) || points < 0 || points > 2_147_483_647) {
          throw new HttpError(400, 'INVALID_SETTING', '注册赠送积分必须是 0 到 2147483647 之间的整数');
        }
      }
      if (key === 'INVITE_REWARD_POINTS') {
        const points = Number(body[key]);
        if (!Number.isSafeInteger(points) || points < 0 || points > 2_147_483_647) {
          throw new HttpError(400, 'INVALID_SETTING', '邀请注册奖励积分必须是 0 到 2147483647 之间的整数');
        }
      }
      await updateSettingFromAdmin(key, String(body[key] ?? ''));
    }
    // 轮换身份签名密钥后，passUser 沙箱 env 里还是旧密钥（spawn 时定格）：
    // 全部停掉，下次访问以新密钥重新拉起
    if (keys.includes('AAP_SIGN_SECRET')) stopAllPersistent();
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'config.update', { keys });
    res.json({ ok: true });
  }),
);

/** 通知通道发信测试（邮件；短信未来接入） */
adminRouter.post(
  '/admin/mail/test',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { to?: string };
    const me = (await getDb().select().from(users).where(eq(users.id, req.user!.id)))[0];
    const to = String(body.to ?? '').trim() || me?.email || getSetting('SMTP_FROM') || getSetting('RESEND_FROM') || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpError(400, 'NO_RECIPIENT', '没有可用收件邮箱：请填写收件地址，或先给管理员账号绑定邮箱');
    }
    if (!outboundMailConfigured()) {
      throw new HttpError(400, 'MAIL_NOT_CONFIGURED', '尚未配置发信通道（当前为日志兜底模式：验证码会打印到服务端日志）');
    }
    await getEmailChannel().send(to, '123456', 'bind');
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.mail.test', { to });
    res.json({ ok: true, to });
  }),
);

// ---------- 用户分组（会员等级/自定义组） ----------

adminRouter.get(
  '/admin/groups',
  h(async (_req, res) => {
    res.json({ groups: await listGroups() });
  }),
);

adminRouter.post(
  '/admin/groups',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; note?: string; appPublishRewardPoints?: unknown };
    if (!body.name?.trim()) throw new HttpError(400, 'INVALID_NAME', '分组名称必填');
    const appPublishRewardPoints =
      body.appPublishRewardPoints === undefined ? 0 : parseAppPublishRewardPoints(body.appPublishRewardPoints);
    const id = await createGroup(body.name, body.note ?? '', appPublishRewardPoints);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.group.create', { id, name: body.name });
    res.json({ ok: true, id });
  }),
);

adminRouter.put(
  '/admin/groups/:id',
  h(async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: string;
      note?: string;
      memberIds?: number[];
      appPublishRewardPoints?: unknown;
    };
    const patch: { name?: string; note?: string; appPublishRewardPoints?: number } = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.note !== undefined) patch.note = body.note;
    if (body.appPublishRewardPoints !== undefined) {
      patch.appPublishRewardPoints = parseAppPublishRewardPoints(body.appPublishRewardPoints);
    }
    await updateGroup(Number(req.params.id), patch);
    if (body.memberIds !== undefined) await setGroupMembers(Number(req.params.id), body.memberIds);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.group.update', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  '/admin/groups/:id',
  h(async (req, res) => {
    await deleteGroup(Number(req.params.id));
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.group.delete', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/groups/:id/members',
  h(async (req, res) => {
    res.json({ memberIds: await groupMemberIds(Number(req.params.id)) });
  }),
);

/** 密钥查看（自研应用验签/接入需要；审计泄露面） */
adminRouter.get(
  '/admin/secrets/:key',
  h(async (req, res) => {
    const key = String(req.params.key);
    const def = SETTING_DEFS[key];
    if (!def || !def.secret) throw new HttpError(404, 'NOT_SECRET', '配置项不存在或不是密钥');
    const value = getSetting(key);
    if (!value) throw new HttpError(404, 'NOT_SET', '该密钥尚未生成');
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'config.secret.revealed', { key });
    res.json({ key, value });
  }),
);

// ---------- 审计查询 ----------

adminRouter.get(
  '/admin/audit',
  h(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const rows = await getDb()
      .select({
        id: auditLogs.id,
        ts: auditLogs.ts,
        actor: auditLogs.actor,
        ip: auditLogs.ip,
        action: auditLogs.action,
        detail: auditLogs.detail,
      })
      .from(auditLogs)
      .orderBy(sql`id DESC`)
      .limit(limit);
    res.json({
      logs: rows.map((r) => ({
        ...r,
        detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
      })),
    });
  }),
);

// ---------- 邀请码 ----------

adminRouter.get(
  '/admin/invites',
  h(async (_req, res) => {
    const rows = await getDb()
      .select({
        code: inviteCodes.code,
        ownerUserId: users.id,
        ownerUsername: users.username,
        ownerEmail: users.email,
        ownerName: users.name,
        enabled: inviteCodes.enabled,
        useCount: inviteCodes.useCount,
        createdAt: inviteCodes.createdAt,
      })
      .from(inviteCodes)
      .innerJoin(users, eq(inviteCodes.ownerUserId, users.id))
      .orderBy(sql`invite_codes.created_at DESC`);
    res.json({ invites: rows });
  }),
);

adminRouter.patch(
  '/admin/invites/:code',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'INVALID_STATUS', '邀请码状态必须是布尔值');
    const code = String(req.params.code ?? '').toUpperCase();
    const [updated] = await getDb()
      .update(inviteCodes)
      .set({ enabled: body.enabled })
      .where(eq(inviteCodes.code, code))
      .returning({ code: inviteCodes.code });
    if (!updated) throw new HttpError(404, 'INVITE_NOT_FOUND', '邀请码不存在');
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.invite.status', {
      code,
      enabled: body.enabled,
    });
    res.json({ ok: true });
  }),
);

// ---------- 首配向导总览（E2-② checklist 状态自动检测） ----------

adminRouter.get(
  '/admin/overview',
  h(async (req, res) => {
    const appCount = Number((await getDb().select({ n: sql<number>`count(*)` }).from(apps))[0]?.n ?? 0);
    const userCount = Number((await getDb().select({ n: sql<number>`count(*)` }).from(users))[0]?.n ?? 0);
    const tokenUsage30d = Number((await getDb()
      .select({ n: sql<number>`coalesce(sum(prompt_tokens + completion_tokens), 0)` })
      .from(llmLedger)
      .where(and(eq(llmLedger.kind, 'usage'), gt(llmLedger.ts, Date.now() - 30 * 86_400_000))))[0]?.n ?? 0);
    const now = Date.now();
    const subscribedRows = await getDb()
      .select({
        planId: users.membershipPlanId,
        count: sql<number>`count(*)`,
      })
      .from(users)
      .where(and(isNotNull(users.membershipPlanId), gt(users.membershipExpiresAt, now)))
      .groupBy(users.membershipPlanId);
    const subscriptionCounts = new Map(subscribedRows.map((row) => [row.planId, Number(row.count)]));
    const plans = await getDb().select({ id: membershipPlans.id, name: membershipPlans.name }).from(membershipPlans);
    const memoryTotal = os.totalmem();
    const memoryUsed = Math.max(0, memoryTotal - os.freemem());
    const network = await readNetworkUsage();
    res.json({
      version: 'ok',
      // 服务版本与运行时长仅管理员可见（匿名 /api/health 已收敛为仅 ok）
      releaseVersion: AAP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      totals: { users: userCount, apps: appCount, tokens30d: tokenUsage30d },
      resources: {
        cpuPercent: readCpuUsagePercent(),
        memory: {
          usedBytes: memoryUsed,
          totalBytes: memoryTotal,
          percent: memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
        },
        network,
      },
      planSubscriptions: plans.map((plan) => ({
        planId: plan.id,
        planName: plan.name,
        subscribers: subscriptionCounts.get(plan.id) ?? 0,
      })),
    });
  }),
);
