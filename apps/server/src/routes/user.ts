/**
 * 用户中心（A4）：个人资料、邮箱换绑（验证码通道 + 步升认证）、
 * 登录会话列表与踢下线、账单占位（M3）、注销（7 天冷静期可撤回）。
 */
import { Router } from 'express';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { llmLedger, membershipPlans, sessions, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAuth, requireStepUp } from '../lib/auth.js';
import { publicUserOf } from './shared.js';
import { registerPurgeTask } from '../lib/audit.js';
import { getSetting, getSettingBool, getSettingInt } from '../lib/settings.js';
import { issueCode, verifyCode } from '../lib/verification.js';
import { activateMembership, assertMembershipTierAllowed, cancelOrder, createOrder, isFreePlan, listPlans } from '../lib/billing.js';
import { redeem as redeemCodeLib } from '../lib/redeem.js';
import { audit } from '../lib/audit.js';
import { recomputeBalance } from '../lib/llm.js';

export const userRouter = Router();

userRouter.use('/user', requireAuth);
userRouter.use('/user', (req, res, next) => {
  const originalPath = (req.originalUrl ?? '').split('?')[0] ?? '';
  const isMembershipSummaryRequest =
    req.method === 'GET' &&
    (req.path === '/membership' || originalPath.endsWith('/user/membership'));
  if (
    !req.user?.membershipSelectionRequired ||
    req.path === '/membership/select-plan' ||
    isMembershipSummaryRequest
  ) {
    next();
    return;
  }
  res.status(403).json({
    error: { code: 'MEMBERSHIP_SELECTION_REQUIRED', message: '请先选择权益计划', action: 'membership-selection' },
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AVATAR_BYTES = 100 * 1024;

userRouter.get(
  '/user/profile',
  h(async (req, res) => {
    const row = (await getDb().select().from(users).where(eq(users.id, req.user!.id)))[0];
    if (!row) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    res.json({ user: publicUserOf(row) });
  }),
);

userRouter.patch(
  '/user/profile',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; avatar?: string | null };
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = body.name.trim().slice(0, 64);
      if (!name) throw new HttpError(400, 'INVALID_NAME', '昵称不能为空');
      patch.name = name;
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') {
        patch.avatar = null;
      } else {
        // 仅接受 data URI（头像内联存储，限制大小防滥用）
        if (!body.avatar.startsWith('data:image/')) throw new HttpError(400, 'INVALID_AVATAR', '头像必须是图片');
        if (body.avatar.length > MAX_AVATAR_BYTES) throw new HttpError(400, 'AVATAR_TOO_LARGE', '头像图片过大（≤100KB）');
        patch.avatar = body.avatar;
      }
    }
    await getDb().update(users).set(patch).where(eq(users.id, req.user!.id));
    await audit(`user:${req.user!.id}`, req.clientIp ?? null, 'user.profile.update', { keys: Object.keys(patch) });
    const row = (await getDb().select().from(users).where(eq(users.id, req.user!.id)))[0];
    res.json({ user: publicUserOf(row!) });
  }),
);

// ---------- 邮箱换绑（验证码发到新邮箱；敏感操作需步升认证） ----------

userRouter.post(
  '/user/email/change/start',
  requireStepUp,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { newEmail?: string; powToken?: string };
    const newEmail = String(body.newEmail ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail)) throw new HttpError(400, 'INVALID_EMAIL', '邮箱格式不正确');
    const taken = (await getDb().select({ id: users.id }).from(users).where(eq(users.email, newEmail)))[0];
    if (taken && taken.id !== req.user!.id) throw new HttpError(409, 'EMAIL_TAKEN', '邮箱已被其他账号占用');
    const issued = await issueCode('email', newEmail, 'bind', req.clientIp ?? null);
    res.json({ sentTo: issued.sentTo, resendAfterMs: issued.resendAfterMs, viaLogFallback: issued.viaLogFallback });
  }),
);

userRouter.post(
  '/user/email/change/verify',
  requireStepUp,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { newEmail?: string; code?: string };
    const newEmail = String(body.newEmail ?? '').trim().toLowerCase();
    const result = await verifyCode('email', newEmail, 'bind', String(body.code ?? '').trim());
    if (!result.ok) throw new HttpError(400, result.error === 'CODE_MISMATCH' ? 'CODE_MISMATCH' : 'CODE_INVALID', '验证码错误或已过期');
    const taken = (await getDb().select({ id: users.id }).from(users).where(eq(users.email, newEmail)))[0];
    if (taken && taken.id !== req.user!.id) throw new HttpError(409, 'EMAIL_TAKEN', '邮箱已被其他账号占用');
    await getDb().update(users).set({ email: newEmail }).where(eq(users.id, req.user!.id));
    await audit(`user:${req.user!.id}`, req.clientIp ?? null, 'user.email.changed', {});
    res.json({ ok: true });
  }),
);

// ---------- 登录会话列表 / 踢下线 ----------

userRouter.get(
  '/user/sessions',
  h(async (req, res) => {
    const uid = req.user!.id;
    const rows = await getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, uid), gt(sessions.expiresAt, Date.now())))
      .orderBy(sql`last_seen_at DESC`);
    res.json({
      sessions: rows.map((s) => ({
        id: s.tokenHash.slice(0, 12),
        current: s.tokenHash === req.user!.sessionId,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
      })),
    });
  }),
);

userRouter.delete(
  '/user/sessions/:id',
  h(async (req, res) => {
    const uid = req.user!.id;
    const prefix = String(req.params.id ?? '');
    const rows = await getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, uid), gt(sessions.expiresAt, Date.now())));
    const target = rows.find((r) => r.tokenHash.startsWith(prefix));
    if (!target) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在或已过期');
    if (target.tokenHash === req.user!.sessionId) {
      throw new HttpError(400, 'CURRENT_SESSION', '不能踢除当前会话（请用退出登录）');
    }
    await getDb().delete(sessions).where(eq(sessions.id, target.id));
    await audit(`user:${uid}`, req.clientIp ?? null, 'user.session.revoked', { sessionId: prefix });
    res.json({ ok: true });
  }),
);

// ---------- 账单（M3 占位） ----------

userRouter.get(
  '/user/billing',
  h(async (req, res) => {
    const uid = req.user!.id;
    const row = (await getDb().select({ plan: users.plan }).from(users).where(eq(users.id, uid)))[0];
    // M2：余额与用量来自 LLM 网关账本（M3 接充值与结算引擎）
    const balance = await recomputeBalance(uid);
    const usage = await getDb()
      .select()
      .from(llmLedger)
      .where(and(eq(llmLedger.userId, uid), eq(llmLedger.kind, 'usage')))
      .orderBy(sql`id DESC`)
      .limit(10);
    res.json({
      plan: row?.plan ?? 'free',
      tokenBalance: balance,
      showTopupPanel: getSettingBool('SHOW_TOPUP_PANEL', false),
      showOrdersPanel: getSettingBool('SHOW_ORDERS_PANEL', false),
      recentUsage: usage.map((u) => ({
        ts: u.ts,
        model: u.model,
        appId: u.appId,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        delta: u.delta,
      })),
      note: '额度充值与功能订阅订单经管理员确认到账后生效',
    });
  }),
);

// ---------- 会员与充值（M3） ----------

userRouter.get(
  '/user/membership',
  h(async (req, res) => {
    const { getAppUploadQuota, listPlans, listUserOrders } = await import('../lib/billing.js');
    const { listGroups } = await import('../lib/groups.js');
    const uid = req.user!.id;
    const me = (await getDb().select().from(users).where(eq(users.id, uid)))[0];
    const plan = me?.membershipPlanId
      ? (await getDb().select().from(membershipPlans).where(eq(membershipPlans.id, me.membershipPlanId)))[0]
      : undefined;
    const activePlan = plan && me?.membershipExpiresAt && me.membershipExpiresAt > Date.now() ? plan : undefined;
    const groupNames = new Map(await (await listGroups()).map((group) => [group.id, group.name]));
    const uploadQuota = await getAppUploadQuota(uid);
    res.json({
      membership: activePlan && me?.membershipExpiresAt
        ? {
            planName: activePlan.name,
            tier: activePlan.tier,
            groupName: groupNames.get(activePlan.groupId) ?? `#${activePlan.groupId}`,
            expiresAt: me.membershipExpiresAt,
            appUploadLimit: uploadQuota.limit,
            appsUsed: uploadQuota.used,
            remainingUploadApps: uploadQuota.remaining,
          }
        : null,
      tokenBalance: await recomputeBalance(uid),
      pointsBalance: me?.pointsBalance ?? 0,
      plans: await (await listPlans()).map((item) => ({ ...item, groupName: groupNames.get(item.groupId) ?? `#${item.groupId}` })),
      orders: await listUserOrders(uid),
    });
  }),
);

/** 注册后首次权益选择：零价与积分套餐立即开通，人民币/美元套餐创建待确认订单 */
userRouter.post(
  '/user/membership/skip-selection',
  h(async (_req, res) => {
    if ((await listPlans(true)).length > 0) {
      throw new HttpError(409, 'MEMBERSHIP_PLANS_AVAILABLE', '仍有可选择的权益包');
    }
    await getDb()
      .update(users)
      .set({ membershipSelectionRequired: false })
      .where(and(eq(users.id, _req.user!.id), eq(users.membershipSelectionRequired, true)));
    res.json({ ok: true });
  }),
);

userRouter.post(
  '/user/membership/select-plan',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { planId?: number };
    const plan = await (await listPlans(true)).find((item) => item.id === Number(body.planId));
    if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '权益包不存在或已下架');
    await assertMembershipTierAllowed(req.user!.id, plan);

    let orderId: string | null = null;
    await getDb().transaction(async (tx) => {
      const current = (await tx
        .select({ required: users.membershipSelectionRequired, pointsBalance: users.pointsBalance })
        .from(users)
        .where(eq(users.id, req.user!.id))
        .for('update'))[0];
      if (!current?.required) throw new HttpError(409, 'MEMBERSHIP_ALREADY_SELECTED', '权益计划已选择');

      if (plan.priceCurrency === 'POINTS' && plan.pricePoints > 0) {
        if ((current.pointsBalance ?? 0) < plan.pricePoints) {
          throw new HttpError(400, 'INSUFFICIENT_POINTS', '积分不足，无法兑换该权益包');
        }
        await tx
          .update(users)
          .set({ pointsBalance: current.pointsBalance - plan.pricePoints })
          .where(eq(users.id, req.user!.id));
        await activateMembership(req.user!.id, plan.id, tx);
      } else if (isFreePlan(plan)) {
        await activateMembership(req.user!.id, plan.id, tx);
      } else {
        orderId = (await createOrder(
          req.user!.id,
          'membership',
          {
            priceCurrency: plan.priceCurrency === 'USD' ? 'USD' : 'CNY',
            priceFen: plan.priceFen,
            priceCents: plan.priceCents,
            planId: plan.id,
          },
          tx,
        )).id;
      }
      await tx
        .update(users)
        .set({ membershipSelectionRequired: false })
        .where(and(eq(users.id, req.user!.id), eq(users.membershipSelectionRequired, true)));
    });
    if (orderId) {
      await audit(`user:${req.user!.id}`, null, 'billing.order.create', {
        id: orderId,
        kind: 'membership',
        priceCurrency: plan.priceCurrency,
        priceFen: plan.priceFen,
        priceCents: plan.priceCents,
      });
    } else if (plan.priceCurrency === 'POINTS' && plan.pricePoints > 0) {
      await audit(`user:${req.user!.id}`, null, 'billing.membership.points_redeem', {
        planId: plan.id,
        points: plan.pricePoints,
      });
    }
    res.json({
      ok: true,
      activated: orderId === null,
      planName: plan.name,
      orderId,
    });
  }),
);

userRouter.post(
  '/user/membership/subscribe',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { planId?: number };
    const plan = await (await listPlans(true)).find((p) => p.id === Number(body.planId));
    if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在或已下架');
    await assertMembershipTierAllowed(req.user!.id, plan);
    if ((plan.priceCurrency === 'POINTS' && plan.pricePoints > 0) || isFreePlan(plan)) {
      await getDb().transaction(async (tx) => {
        const current = (await tx
          .select({ pointsBalance: users.pointsBalance })
          .from(users)
          .where(eq(users.id, req.user!.id))
          .for('update'))[0];
        if (!current) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
        if (plan.priceCurrency === 'POINTS' && plan.pricePoints > 0) {
          if (current.pointsBalance < plan.pricePoints) {
            throw new HttpError(400, 'INSUFFICIENT_POINTS', '积分不足，无法兑换该权益包');
          }
          await tx
            .update(users)
            .set({ pointsBalance: current.pointsBalance - plan.pricePoints })
            .where(eq(users.id, req.user!.id));
        }
        await activateMembership(req.user!.id, plan.id, tx);
      });
      if (plan.priceCurrency === 'POINTS' && plan.pricePoints > 0) {
        await audit(`user:${req.user!.id}`, null, 'billing.membership.points_redeem', {
          planId: plan.id,
          points: plan.pricePoints,
        });
      }
      res.json({ ok: true, activated: true, planName: plan.name, orderId: null });
      return;
    }
    const order = await createOrder(req.user!.id, 'membership', {
      priceCurrency: plan.priceCurrency === 'USD' ? 'USD' : 'CNY',
      priceFen: plan.priceFen,
      priceCents: plan.priceCents,
      planId: plan.id,
    });
    res.json({
      ok: true,
      activated: false,
      planName: plan.name,
      orderId: order.id,
      priceCurrency: order.priceCurrency,
      priceFen: order.priceFen,
      priceCents: order.priceCents,
    });
  }),
);

/** 额度充值：建订单，tokens 按单价折算 */
userRouter.post(
  '/user/topup',
  h(async (req, res) => {
    const { createOrder } = await import('../lib/billing.js');
    const body = (req.body ?? {}) as { priceFen?: number };
    const priceFen = Math.round(Number(body.priceFen ?? 0));
    const perFen = getSettingInt('TOPUP_TOKENS_PER_FEN', 1000);
    if (priceFen < 100) throw new HttpError(400, 'INVALID_AMOUNT', '最低充值 1.00 元');
    const order = await createOrder(req.user!.id, 'tokens', { priceFen, tokens: priceFen * perFen });
    res.json({ ok: true, orderId: order.id, tokens: order.tokens, priceFen: order.priceFen });
  }),
);

const redeemHits = new Map<number, { start: number; count: number }>();

/** 兑换卡券码（额度/会员）；按用户限速 10/分 防穷举 */
userRouter.post(
  '/user/redeem',
  h(async (req, res) => {
    const uid = req.user!.id;
    const now = Date.now();
    const hit = redeemHits.get(uid);
    if (!hit || now - hit.start >= 60_000) {
      redeemHits.set(uid, { start: now, count: 1 });
    } else {
      hit.count++;
      if (hit.count > 10) throw new HttpError(429, 'TOO_MANY_REQUESTS', '兑换太频繁，请稍后再试');
    }
    const body = (req.body ?? {}) as { code?: string };
    const result = redeemCodeLib(uid, String(body.code ?? ''), req.clientIp ?? null);
    res.json({ ok: true, ...result });
  }),
);

userRouter.post(
  '/user/orders/:id/cancel',
  h(async (req, res) => {
    await cancelOrder(String(req.params.id), req.user!.id, false);
    res.json({ ok: true });
  }),
);

// ---------- 注销（7 天冷静期可撤回 → 数据匿名化） ----------

userRouter.post(
  '/user/delete/request',
  requireStepUp,
  h(async (req, res) => {
    const uid = req.user!.id;
    const now = Date.now();
    await getDb()
      .update(users)
      .set({ status: 'deletion_pending', deletionRequestedAt: now })
      .where(eq(users.id, uid));
    // 踢除其他会话，保留当前（供撤回）
    await getDb()
      .delete(sessions)
      .where(and(eq(sessions.userId, uid), ne(sessions.tokenHash, req.user!.sessionId)));
    await audit(`user:${uid}`, req.clientIp ?? null, 'user.delete.requested', {
      cooldownDays: getSettingInt('DELETION_COOLDOWN_DAYS', 7),
    });
    res.json({ ok: true });
  }),
);

userRouter.post(
  '/user/delete/cancel',
  h(async (req, res) => {
    const uid = req.user!.id;
    const row = (await getDb().select().from(users).where(eq(users.id, uid)))[0];
    if (row?.status === 'deletion_pending') {
      await getDb().update(users).set({ status: 'active', deletionRequestedAt: null }).where(eq(users.id, uid));
      await audit(`user:${uid}`, req.clientIp ?? null, 'user.delete.cancelled', {});
    }
    res.json({ ok: true });
  }),
);

/** 冷静期到期 → 匿名化：删除用户行（级联会话/凭据/MFA），审计保留脱敏记录 */
registerPurgeTask(async (now) => {
  const cooldownMs = getSettingInt('DELETION_COOLDOWN_DAYS', 7) * 86_400_000;
  const due = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.status, 'deletion_pending'), sql`deletion_requested_at < ${now - cooldownMs}`));
  for (const u of due) {
    await getDb().delete(users).where(eq(users.id, u.id));
    await audit(`deleted:${u.id}`, null, 'user.deleted.anonymized', {
      // 脱敏保留：仅留 ID 与时间，不留用户名/邮箱
      registeredAt: u.createdAt,
      deletedAt: now,
    });
  }
});

void getSetting;
