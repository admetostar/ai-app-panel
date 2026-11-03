/**
 * 计费闭环（M3，D1–D4）：
 *  - D1 会员订阅：套餐（名称/分组/时长/价格）→ 开通加入分组（可见性随分组），到期自动降级（移出分组、保留数据）
 *  - D2 充值：额度订单按 TOPUP_TOKENS_PER_FEN 折算，确认到账即入账（grantTokens，三触发失效缓存）
 *  - D2a 结算：定时对账（缓存 vs 账本重算，吸收崩溃漂移）+ 到期降级扫描；欠费态 = 缓存余额低于预估，预检闸门直接拦截
 *  - D3 支付渠道：adapter 接口 + manual（人工确认）首发；微信/支付宝/Stripe 后续各写一个 adapter 即可接入
 * 账本与缓存的边界不变：账本 append-only，缓存可重算。
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { MembershipPriceCurrency } from '@aap/shared';
import { getDb, type DbExecutor } from '../db/index.js';
import { apps, llmBalanceCache, llmLedger, llmRoutes, membershipPlans, topupOrders, userGroupMembers, users } from '../db/schema.js';
import { HttpError } from './httpError.js';
import { grantTokens, recomputeBalance } from './llm.js';
import { audit } from './audit.js';

export type OrderKind = 'tokens' | 'membership';
export type OrderStatus = 'pending' | 'paid' | 'cancelled';
const MAX_INTEGER_PRICE = 2_147_483_647;

// ---------- 套餐（D1） ----------

export interface PlanRow {
  id: number;
  name: string;
  groupId: number;
  durationDays: number;
  priceCurrency: MembershipPriceCurrency;
  priceFen: number;
  priceCents: number;
  pricePoints: number;
  redeemUrl: string | null;
  tokenGrant: number;
  tier: number;
  appUploadLimit: number;
  appCloneLimit: number;
  enabled: boolean;
}

async function activeMembershipPlan(
  user: typeof users.$inferSelect,
  executor: DbExecutor,
): Promise<PlanRow | null> {
  if (!user.membershipPlanId || !user.membershipExpiresAt || user.membershipExpiresAt <= Date.now()) return null;
  const row = (await executor.select().from(membershipPlans).where(eq(membershipPlans.id, user.membershipPlanId)))[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    groupId: row.groupId,
    durationDays: row.durationDays,
    priceCurrency: row.priceCurrency,
    priceFen: row.priceFen,
    priceCents: row.priceCents,
    pricePoints: row.pricePoints,
    redeemUrl: row.redeemUrl,
    tokenGrant: row.tokenGrant,
    tier: row.tier,
    appUploadLimit: row.appUploadLimit,
    appCloneLimit: row.appCloneLimit,
    enabled: row.enabled,
  };
}

async function ensureMembershipTierAllowed(
  user: typeof users.$inferSelect,
  targetPlan: PlanRow,
  executor: DbExecutor,
): Promise<PlanRow | null> {
  const currentPlan = await activeMembershipPlan(user, executor);
  if (currentPlan && targetPlan.tier < currentPlan.tier) {
    throw new HttpError(409, 'LOWER_TIER_MEMBERSHIP_ACTIVE', '当前权益包等级更高，请等当前权益包到期后再订阅较低等级的权益包');
  }
  return currentPlan;
}

export async function assertMembershipTierAllowed(userId: number, targetPlan: PlanRow): Promise<void> {
  const db = getDb();
  const user = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
  await ensureMembershipTierAllowed(user, targetPlan, db);
}

export async function listPlans(onlyEnabled = false): Promise<PlanRow[]> {
  const rows = await getDb()
    .select()
    .from(membershipPlans)
    .orderBy(sql`price_fen`);
  return (onlyEnabled ? rows.filter((r) => r.enabled) : rows).map((r) => ({
    id: r.id,
    name: r.name,
    groupId: r.groupId,
    durationDays: r.durationDays,
    priceCurrency: r.priceCurrency,
    priceFen: r.priceFen,
    priceCents: r.priceCents,
    pricePoints: r.pricePoints,
    redeemUrl: r.redeemUrl,
    tokenGrant: r.tokenGrant,
    tier: r.tier,
    appUploadLimit: r.appUploadLimit,
    appCloneLimit: r.appCloneLimit,
    enabled: r.enabled,
  }));
}

export function isFreePlan(plan: Pick<PlanRow, 'priceCurrency' | 'priceFen' | 'priceCents' | 'pricePoints'>): boolean {
  if (plan.priceCurrency === 'POINTS') return plan.pricePoints === 0;
  if (plan.priceCurrency === 'USD') return plan.priceCents === 0;
  if (plan.priceCurrency === 'CNY') return plan.priceFen === 0;
  return false;
}

export async function createPlan(p: {
  name: string;
  groupId: number;
  durationDays: number;
  priceCurrency?: MembershipPriceCurrency;
  priceFen?: number;
  priceCents?: number;
  pricePoints?: number;
  redeemUrl?: unknown;
  tokenGrant?: number;
  tier?: number;
  appUploadLimit?: number;
  appCloneLimit?: number;
}): Promise<number> {
  const priceCurrency = p.priceCurrency ?? 'CNY';
  if (!['CNY', 'USD', 'POINTS'].includes(priceCurrency)) throw new HttpError(400, 'INVALID_CURRENCY', '不支持的套餐计价单位');
  for (const [label, amount] of [['人民币价格', p.priceFen ?? 0], ['美元价格', p.priceCents ?? 0], ['积分价格', p.pricePoints ?? 0]] as const) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_INTEGER_PRICE) {
      throw new HttpError(400, 'INVALID_PRICE', `${label}必须是 0 到 ${MAX_INTEGER_PRICE} 之间的整数`);
    }
  }
  const redeemUrl = normalizeRedeemUrl(p.redeemUrl);
  const [created] = await getDb()
    .insert(membershipPlans)
    .values({
      name: p.name.trim().slice(0, 64),
      groupId: p.groupId,
      durationDays: Math.max(1, p.durationDays),
      priceCurrency,
      priceFen: Math.max(0, p.priceFen ?? 0),
      priceCents: Math.max(0, p.priceCents ?? 0),
      pricePoints: Math.max(0, p.pricePoints ?? 0),
      redeemUrl,
      tokenGrant: Math.max(0, p.tokenGrant ?? 0),
      tier: Math.min(5, Math.max(0, Math.trunc(p.tier ?? 0))),
      appUploadLimit: Math.max(0, p.appUploadLimit ?? 10),
      appCloneLimit: Math.max(0, p.appCloneLimit ?? 0),
      createdAt: Date.now(),
    })
    .returning({ id: membershipPlans.id });
  if (!created) throw new Error('Failed to create membership plan');
  return created.id;
}

export async function updatePlan(id: number, patch: {
  name?: string;
  durationDays?: number;
  priceCurrency?: MembershipPriceCurrency;
  priceFen?: number;
  priceCents?: number;
  pricePoints?: number;
  redeemUrl?: unknown;
  tokenGrant?: number;
  appUploadLimit?: number;
  appCloneLimit?: number;
  enabled?: boolean;
}): Promise<void> {
  const set: Partial<typeof membershipPlans.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 64);
  if (patch.durationDays !== undefined) set.durationDays = Math.max(1, patch.durationDays);
  if (patch.priceCurrency !== undefined) {
    if (!['CNY', 'USD', 'POINTS'].includes(patch.priceCurrency)) throw new HttpError(400, 'INVALID_CURRENCY', '不支持的套餐计价单位');
    set.priceCurrency = patch.priceCurrency;
  }
  if (patch.priceFen !== undefined) set.priceFen = Math.max(0, patch.priceFen);
  if (patch.priceCents !== undefined) set.priceCents = Math.max(0, patch.priceCents);
  if (patch.pricePoints !== undefined) set.pricePoints = Math.max(0, patch.pricePoints);
  if (patch.redeemUrl !== undefined) set.redeemUrl = normalizeRedeemUrl(patch.redeemUrl);
  for (const [label, amount] of [['人民币价格', patch.priceFen], ['美元价格', patch.priceCents], ['积分价格', patch.pricePoints]] as const) {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_INTEGER_PRICE)) {
      throw new HttpError(400, 'INVALID_PRICE', `${label}必须是 0 到 ${MAX_INTEGER_PRICE} 之间的整数`);
    }
  }
  if (patch.tokenGrant !== undefined) set.tokenGrant = Math.max(0, patch.tokenGrant);
  if (patch.appUploadLimit !== undefined) set.appUploadLimit = Math.max(0, patch.appUploadLimit);
  if (patch.appCloneLimit !== undefined) set.appCloneLimit = Math.max(0, patch.appCloneLimit);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  await getDb().update(membershipPlans).set(set).where(eq(membershipPlans.id, id));
}

function normalizeRedeemUrl(value: unknown): string | null {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_REDEEM_URL', '兑换码链接必须是有效的 http 或 https 地址');
  }
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) {
    throw new HttpError(400, 'INVALID_REDEEM_URL', '兑换码链接不能超过 2048 个字符');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, 'INVALID_REDEEM_URL', '兑换码链接必须是有效的 http 或 https 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'INVALID_REDEEM_URL', '兑换码链接必须是有效的 http 或 https 地址');
  }
  return url.toString();
}

export interface AppUploadQuota {
  limit: number;
  used: number;
  remaining: number;
}

export async function getAppUploadQuota(userId: number): Promise<AppUploadQuota> {
  const db = getDb();
  const user = (await db
    .select({ membershipPlanId: users.membershipPlanId, membershipExpiresAt: users.membershipExpiresAt })
    .from(users)
    .where(eq(users.id, userId)))[0];
  const plan = user?.membershipPlanId && user.membershipExpiresAt && user.membershipExpiresAt > Date.now()
    ? (await db.select().from(membershipPlans).where(eq(membershipPlans.id, user.membershipPlanId)))[0]
    : undefined;
  const used = Number((await db
    .select({ count: sql<number>`count(*)` })
    .from(apps)
    .where(and(eq(apps.ownerUserId, userId), ne(apps.kind, 'upstream'), isNull(apps.clonedFromAppId))))[0]?.count ?? 0);
  const limit = plan?.appUploadLimit ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export interface AppCloneQuota {
  limit: number;
  used: number;
  remaining: number;
}

export async function getAppCloneQuota(userId: number): Promise<AppCloneQuota> {
  const db = getDb();
  const user = (await db
    .select({ membershipPlanId: users.membershipPlanId, membershipExpiresAt: users.membershipExpiresAt })
    .from(users)
    .where(eq(users.id, userId)))[0];
  const plan = user?.membershipPlanId && user.membershipExpiresAt && user.membershipExpiresAt > Date.now()
    ? (await db.select().from(membershipPlans).where(eq(membershipPlans.id, user.membershipPlanId)))[0]
    : undefined;
  const used = Number((await db
    .select({ count: sql<number>`count(*)` })
    .from(apps)
    .where(and(eq(apps.ownerUserId, userId), isNotNull(apps.clonedFromAppId))))[0]?.count ?? 0);
  const limit = plan?.appCloneLimit ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export async function assertAppUploadQuota(userId: number): Promise<AppUploadQuota> {
  const quota = await getAppUploadQuota(userId);
  if (quota.remaining <= 0) {
    throw new HttpError(403, 'APP_UPLOAD_LIMIT_REACHED', `当前权益包可创建应用数量已达上限（${quota.used}/${quota.limit}），请删除已有应用或升级权益包`);
  }
  return quota;
}

export async function deletePlan(id: number): Promise<void> {
  await getDb().delete(membershipPlans).where(eq(membershipPlans.id, id));
}

// ---------- 订单（D2/D3） ----------

export function newOrderId(): string {
  return `T${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.toUpperCase();
}

export interface OrderRow {
  id: string;
  userId: number;
  kind: OrderKind;
  planId: number | null;
  tokens: number | null;
  priceCurrency: 'CNY' | 'USD';
  priceFen: number;
  priceCents: number;
  channel: string;
  status: OrderStatus;
  note: string | null;
  createdAt: number;
  paidAt: number | null;
}

export async function listOrders(status: OrderStatus | 'all' = 'all', limit = 100): Promise<OrderRow[]> {
  const base = getDb().select().from(topupOrders);
  const rows =
    status === 'all'
      ? await base.orderBy(sql`id DESC`).limit(limit)
      : await base.where(eq(topupOrders.status, status)).orderBy(sql`id DESC`).limit(limit);
  return rows as OrderRow[];
}

export async function listUserOrders(userId: number, limit = 20): Promise<OrderRow[]> {
  return await getDb()
    .select()
    .from(topupOrders)
    .where(eq(topupOrders.userId, userId))
    .orderBy(sql`id DESC`)
    .limit(limit) as OrderRow[];
}

export interface PaymentAdapter {
  readonly id: string;
  readonly name: string;
  /** 创建支付（manual：返回提示文案；真实渠道：返回支付链接/参数） */
  createPayment(order: OrderRow): { payHint: string; payUrl?: string };
}

/** 首发渠道：人工确认（管理员在运营面板确认到账） */
export const manualAdapter: PaymentAdapter = {
  id: 'manual',
  name: '人工确认',
  createPayment() {
    return { payHint: '请线下完成支付后联系管理员确认到账；确认后权益自动生效。' };
  },
};

export function paymentAdapters(): PaymentAdapter[] {
  return [manualAdapter];
}

/** 用户创建订单（tokens：按 TOPUP_TOKENS_PER_FEN 折算；membership：按套餐价格） */
export async function createOrder(
  userId: number,
  kind: OrderKind,
  opts: { priceFen: number; priceCents?: number; priceCurrency?: 'CNY' | 'USD'; tokens?: number; planId?: number; channel?: string },
  executor?: DbExecutor,
): Promise<OrderRow> {
  const priceCents = opts.priceCents ?? 0;
  if (!['CNY', 'USD'].includes(opts.priceCurrency ?? 'CNY')) throw new HttpError(400, 'INVALID_CURRENCY', '不支持的订单计价单位');
  if (
    !Number.isSafeInteger(opts.priceFen) ||
    opts.priceFen < 0 ||
    opts.priceFen > MAX_INTEGER_PRICE ||
    !Number.isSafeInteger(priceCents) ||
    priceCents < 0 ||
    priceCents > MAX_INTEGER_PRICE
  ) {
    throw new HttpError(400, 'INVALID_PRICE', `订单金额必须是 0 到 ${MAX_INTEGER_PRICE} 之间的整数`);
  }
  const id = newOrderId();
  const db = executor ?? getDb();
  const [order] = await db
    .insert(topupOrders)
    .values({
      id,
      userId,
      kind,
      planId: opts.planId ?? null,
      tokens: opts.tokens ?? null,
      priceCurrency: opts.priceCurrency ?? 'CNY',
      priceFen: Math.max(0, Math.round(opts.priceFen)),
      priceCents,
      channel: opts.channel ?? 'manual',
      status: 'pending',
      createdAt: Date.now(),
    })
    .returning();
  if (!order) throw new Error('Failed to create top-up order');
  if (!executor) await audit(`user:${userId}`, null, 'billing.order.create', {
    id,
    kind,
    priceCurrency: opts.priceCurrency ?? 'CNY',
    priceFen: opts.priceFen,
    priceCents: opts.priceCents ?? 0,
  });
  return order as OrderRow;
}

/** 开通/续费会员：顺延到期 + 入组 + 赠送额度（单事务；部分失败整体回滚） */
export async function activateMembership(userId: number, planId: number, executor?: DbExecutor): Promise<string> {
  const apply = async (tx: DbExecutor): Promise<string> => {
    const planRow = (await tx.select().from(membershipPlans).where(eq(membershipPlans.id, planId)))[0];
    if (!planRow) throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
    const plan: PlanRow = {
      id: planRow.id,
      name: planRow.name,
      groupId: planRow.groupId,
      durationDays: planRow.durationDays,
      priceCurrency: planRow.priceCurrency,
      priceFen: planRow.priceFen,
      priceCents: planRow.priceCents,
      pricePoints: planRow.pricePoints,
      redeemUrl: planRow.redeemUrl,
      tokenGrant: planRow.tokenGrant,
      tier: planRow.tier,
      appUploadLimit: planRow.appUploadLimit,
      appCloneLimit: planRow.appCloneLimit,
      enabled: planRow.enabled,
    };
    const me = (await tx.select().from(users).where(eq(users.id, userId)).for('update'))[0];
    if (!me) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');

    const currentPlan = await ensureMembershipTierAllowed(me, plan, tx);
    const base = currentPlan && currentPlan.tier === plan.tier ? me.membershipExpiresAt! : Date.now();
    const expiresAt = base + plan.durationDays * 86_400_000;
    if (currentPlan && currentPlan.groupId !== plan.groupId) {
      await tx
        .delete(userGroupMembers)
        .where(and(eq(userGroupMembers.groupId, currentPlan.groupId), eq(userGroupMembers.userId, userId)));
    }
    await tx
      .update(users)
      .set({ membershipPlanId: planId, membershipExpiresAt: expiresAt, plan: 'member' })
      .where(eq(users.id, userId));
    await tx
      .insert(userGroupMembers)
      .values({ groupId: plan.groupId, userId, createdAt: Date.now() })
      .onConflictDoNothing();
    if (plan.tokenGrant > 0) {
      await grantTokens(userId, plan.tokenGrant, `功能订阅赠送（${plan.name}）`, 0, tx);
    }
    return plan.name;
  };
  return executor ? apply(executor) : getDb().transaction((tx) => apply(tx));
}

/** 确认到账（D3 manual 确认点；真实渠道 adapter 回调最终也走这里）。
 *  单事务：置 paid 与入账/开通同生共死，杜绝「已收款未入账」的崩溃窗口
 *  （如套餐被删，订单回滚为 pending，可处理后重新确认）。 */
export async function confirmOrder(orderId: string, byUserId: number): Promise<OrderRow> {
  const db = getDb();
  const order = await db.transaction(async (tx) => {
    const order = (await tx.select().from(topupOrders).where(eq(topupOrders.id, orderId)).for('update'))[0] as OrderRow | undefined;
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (order.status !== 'pending') throw new HttpError(400, 'ORDER_STATE', '订单已处理');
    await tx.update(topupOrders).set({ status: 'paid', paidAt: Date.now() }).where(eq(topupOrders.id, orderId));
    if (order.kind === 'tokens' && order.tokens) {
      await grantTokens(order.userId, order.tokens, `充值到账 ${orderId}`, byUserId, tx);
    } else if (order.kind === 'membership' && order.planId) {
      await activateMembership(order.userId, order.planId, tx);
    }
    return order;
  });
  await audit(`admin:${byUserId}`, null, 'billing.order.paid', { orderId, userId: order.userId });
  return (await db.select().from(topupOrders).where(eq(topupOrders.id, orderId)))[0] as OrderRow;
}

export async function cancelOrder(orderId: string, byUserId: number, byAdmin: boolean): Promise<void> {
  const order = (await getDb().select().from(topupOrders).where(eq(topupOrders.id, orderId)))[0] as OrderRow | undefined;
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
  if (!byAdmin && order.userId !== byUserId) throw new HttpError(403, 'FORBIDDEN', '只能取消自己的订单');
  if (order.status !== 'pending') throw new HttpError(400, 'ORDER_STATE', '订单已处理');
  await getDb().update(topupOrders).set({ status: 'cancelled' }).where(eq(topupOrders.id, orderId));
  await audit(`user:${byUserId}`, null, 'billing.order.cancel', { orderId, byAdmin });
}

// ---------- 结算循环（D2a：对账 + 到期降级） ----------

const DAY_MS = 86_400_000;

/** 到期降级：会员到期 → 清订阅字段 + 移出套餐分组（保留数据，可见性随分组收回） */
export async function downgradeExpired(now = Date.now()): Promise<number> {
  const expired = await getDb()
    .select()
    .from(users)
    .where(and(sql`membership_expires_at IS NOT NULL`, sql`membership_expires_at < ${now}`));
  let n = 0;
  for (const u of expired) {
    const plan = u.membershipPlanId
      ? (await getDb().select().from(membershipPlans).where(eq(membershipPlans.id, u.membershipPlanId)))[0]
      : null;
    await getDb()
      .update(users)
      .set({ membershipPlanId: null, membershipExpiresAt: null, plan: 'free' })
      .where(eq(users.id, u.id));
    if (plan) {
      await getDb()
        .delete(userGroupMembers)
        .where(and(eq(userGroupMembers.groupId, plan.groupId), eq(userGroupMembers.userId, u.id)));
    }
    await audit(`user:${u.id}`, null, 'billing.subscription.expired', { planId: u.membershipPlanId });
    n++;
  }
  return n;
}

/** 对账：近期有流水/缓存缺失的用户重算余额（吸收崩溃漂移；打穿为负 = 欠费态被预检拦截） */
export async function reconcileRecent(): Promise<number> {
  const rows = await getDb()
    .select({ userId: llmLedger.userId })
    .from(llmLedger)
    .where(and(sql`user_id IS NOT NULL`, gt(llmLedger.ts, Date.now() - 10 * 60_000)))
    .groupBy(llmLedger.userId);
  let n = 0;
  for (const r of rows) {
    if (r.userId === null) continue;
    await recomputeBalance(r.userId);
    n++;
  }
  return n;
}

let settleTimer: NodeJS.Timeout | null = null;
export async function startBillingLoop(): Promise<void> {
  if (settleTimer) return;
  const run = async () => {
    try {
      const downgraded = await downgradeExpired();
      const reconciled = await reconcileRecent();
      if (downgraded || reconciled) console.log(`[billing] 降级 ${downgraded} 人，对账 ${reconciled} 人`);
    } catch (err) {
      console.error('[billing] 结算失败:', err);
    }
  };
  await run();
  settleTimer = setInterval(run, 60_000);
  settleTimer.unref();
}
export function stopBillingLoop(): void {
  if (settleTimer) clearInterval(settleTimer);
  settleTimer = null;
}

// ---------- 运营统计（D4） ----------

export interface OpsStats {
  balanceTop: Array<{ userId: number; balance: number }>;
  spentTop: Array<{ userId: number; spent: number }>;
  appHot: Array<{ appId: string; calls: number; tokens: number }>;
  revenue30d: number;
  cost30d: number;
}

/** 运营面板：余额/消耗排行、应用热度、收入与成本（30 天窗口；成本按路由 costPer1k 折算） */
export async function opsStats(): Promise<OpsStats> {
  const db = getDb();
  const since = Date.now() - 30 * DAY_MS;

  const balanceTop = await db
    .select({ userId: llmBalanceCache.userId, balance: llmBalanceCache.balance })
    .from(llmBalanceCache)
    .orderBy(sql`balance DESC`)
    .limit(10);

  const spentRows = await db
    .select({ userId: llmLedger.userId, spent: sql<number>`sum(-delta)` })
    .from(llmLedger)
    .where(and(eq(llmLedger.kind, 'usage'), sql`user_id IS NOT NULL`, gt(llmLedger.ts, since)))
    .groupBy(llmLedger.userId)
    .orderBy(sql`sum(-delta) DESC`)
    .limit(10);
  const spentTop = spentRows.map((r) => ({ userId: r.userId ?? 0, spent: Number(r.spent) }));

  const appHotRows = await db
    .select({
      appId: llmLedger.appId,
      calls: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(prompt_tokens + completion_tokens), 0)`,
    })
    .from(llmLedger)
    .where(and(eq(llmLedger.kind, 'usage'), gt(llmLedger.ts, since)))
    .groupBy(llmLedger.appId)
    .orderBy(sql`count(*) DESC`)
    .limit(10);
  const appHot = appHotRows.map((r) => ({ appId: r.appId ?? '—', calls: Number(r.calls), tokens: Number(r.tokens) }));

  // 收入 = 用量按收入倍率折算的扣减；成本 = 用量按路由成本价折算
  const rev = (await db
    .select({ v: sql<number>`coalesce(sum(-delta), 0)` })
    .from(llmLedger)
    .where(and(eq(llmLedger.kind, 'usage'), gt(llmLedger.ts, since))))[0];
  const revenue30d = Number(rev?.v ?? 0);

  const routes = await db.select().from(llmRoutes);
  let cost30d = 0;
  for (const r of routes) {
    const row = (await db
      .select({
        tokens: sql<number>`coalesce(sum(prompt_tokens + completion_tokens), 0)`,
      })
      .from(llmLedger)
      .where(and(eq(llmLedger.kind, 'usage'), eq(llmLedger.model, r.model), gt(llmLedger.ts, since))))[0];
    cost30d += Math.ceil((Number(row?.tokens ?? 0) * r.costPer1k) / 1000);
  }

  return { balanceTop, spentTop, appHot, revenue30d, cost30d };
}
