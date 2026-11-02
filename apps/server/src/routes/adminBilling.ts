/**
 * 计费管理 API（M3，D4 运营面板数据源）：套餐 CRUD、订单管理（确认到账/取消）、
 * 运营统计（余额/消耗排行、应用热度、成本毛利）。
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { membershipPlans, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normalizeCode } from '../lib/redeem.js';
import {
  generateBatch,
  batchSummaries,
  listCodes,
  disableCode,
  type RedeemKind,
  type RedeemStatus,
} from '../lib/redeem.js';
import {
  cancelOrder,
  confirmOrder,
  createPlan,
  deletePlan,
  listOrders,
  listPlans,
  opsStats,
  updatePlan,
  type OrderStatus,
} from '../lib/billing.js';

export const adminBillingRouter = Router();

adminBillingRouter.use('/admin/billing', requireAdmin);
// 显式守卫：/admin/redeem/* 不在上方前缀内，此前仅靠 adminRouter 先挂载的
// 挂载顺序偶然保护（重构挪序即变成未鉴权的造码/列码接口，渗透测试 P2-10）
adminBillingRouter.use('/admin/redeem', requireAdmin);

// ---------- 套餐 ----------

adminBillingRouter.get(
  '/admin/billing/plans',
  h(async (_req, res) => {
    const { listGroups } = await import('../lib/groups.js');
    const gname = new Map(await (await listGroups()).map((g) => [g.id, g.name]));
    res.json({
      plans: await (await listPlans()).map((p) => ({ ...p, groupName: gname.get(p.groupId) ?? `#${p.groupId}` })),
    });
  }),
);

adminBillingRouter.post(
  '/admin/billing/plans',
  h(async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: string;
      groupId?: number;
      durationDays?: number;
      priceCurrency?: 'CNY' | 'USD' | 'POINTS';
      priceFen?: number;
      priceCents?: number;
      pricePoints?: number;
      redeemUrl?: unknown;
      tokenGrant?: number;
      tier?: number;
      appUploadLimit?: number;
    };
    if (!body.name?.trim() || !body.groupId || ![30, 90, 365].includes(Number(body.durationDays))) {
      throw new HttpError(400, 'INVALID_INPUT', '名称、分组和有效期必填');
    }
    if (!Number.isInteger(Number(body.appUploadLimit)) || Number(body.appUploadLimit) < 0) {
      throw new HttpError(400, 'INVALID_INPUT', '可上传应用数量必须是非负整数');
    }
    if (!Number.isInteger(Number(body.tier)) || Number(body.tier) < 0 || Number(body.tier) > 5) {
      throw new HttpError(400, 'INVALID_INPUT', '权益等级必须是 0 到 5 的整数');
    }
    const id = await createPlan({
      name: body.name,
      groupId: Number(body.groupId),
      durationDays: Number(body.durationDays),
      priceCurrency: body.priceCurrency ?? 'CNY',
      priceFen: Number(body.priceFen ?? 0),
      priceCents: Number(body.priceCents ?? 0),
      pricePoints: Number(body.pricePoints ?? 0),
      redeemUrl: body.redeemUrl,
      tokenGrant: Number(body.tokenGrant ?? 0),
      tier: Number(body.tier),
      appUploadLimit: Number(body.appUploadLimit),
    });
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'billing.plan.create', { id, name: body.name });
    res.json({ ok: true, id });
  }),
);

adminBillingRouter.put(
  '/admin/billing/plans/:id',
  h(async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: string;
      durationDays?: number;
      priceCurrency?: 'CNY' | 'USD' | 'POINTS';
      priceFen?: number;
      priceCents?: number;
      pricePoints?: number;
      redeemUrl?: unknown;
      tokenGrant?: number;
      appUploadLimit?: number;
      enabled?: boolean;
    };
    await updatePlan(Number(req.params.id), body);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'billing.plan.update', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

adminBillingRouter.delete(
  '/admin/billing/plans/:id',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const active = (await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.membershipPlanId, id)))[0];
    if (active) throw new HttpError(409, 'PLAN_IN_USE', '仍有生效订阅，先等到期降级或手动处理');
    await deletePlan(id);
    res.json({ ok: true });
  }),
);

// ---------- 订单 ----------

adminBillingRouter.get(
  '/admin/billing/orders',
  h(async (req, res) => {
    const status = (String(req.query.status ?? 'all') as OrderStatus | 'all') || 'all';
    res.json({ orders: await listOrders(status) });
  }),
);

adminBillingRouter.post(
  '/admin/billing/orders/:id/confirm',
  h(async (req, res) => {
    const order = await confirmOrder(String(req.params.id), req.user!.id);
    res.json({ ok: true, order });
  }),
);

adminBillingRouter.post(
  '/admin/billing/orders/:id/cancel',
  h(async (req, res) => {
    await cancelOrder(String(req.params.id), req.user!.id, true);
    res.json({ ok: true });
  }),
);

// ---------- 卡券码（充值码/会员码） ----------

adminBillingRouter.get(
  '/admin/redeem/batches',
  h(async (_req, res) => {
    res.json({ batches: await batchSummaries() });
  }),
);

adminBillingRouter.get(
  '/admin/redeem/codes',
  h(async (req, res) => {
    const status = String(req.query.status ?? 'all') as RedeemStatus | 'all';
    const codes = await listCodes({
      batchId: (req.query.batchId as string | undefined) || undefined,
      status,
      limit: Number(req.query.limit ?? 200),
    });
    res.json({ codes });
  }),
);

adminBillingRouter.post(
  '/admin/redeem/batches',
  h(async (req, res) => {
    const body = (req.body ?? {}) as {
      kind?: RedeemKind;
      count?: number;
      tokens?: number;
      planId?: number;
      expiresInDays?: number | null;
      note?: string;
    };
    const r = await generateBatch({
      kind: (body.kind as RedeemKind) ?? 'tokens',
      count: Number(body.count ?? 1),
      tokens: body.tokens != null ? Number(body.tokens) : null,
      planId: body.planId != null ? Number(body.planId) : null,
      expiresInDays: body.expiresInDays != null ? Number(body.expiresInDays) : null,
      note: body.note,
      byUserId: req.user!.id,
    });
    res.json({ ok: true, batchId: r.batchId, codes: r.codes });
  }),
);

adminBillingRouter.post(
  '/admin/redeem/disable',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { code?: string };
    await disableCode(normalizeCode(String(body.code ?? '')));
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'redeem.disable', { code: body.code });
    res.json({ ok: true });
  }),
);

// ---------- 运营统计（D4） ----------

adminBillingRouter.get(
  '/admin/billing/ops',
  h(async (_req, res) => {
    res.json(await opsStats());
  }),
);
