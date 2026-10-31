/**
 * M3 计费闭环测试（D1/D2/D2a）：
 * 套餐 → 下单 → 确认到账 → 会员生效入组 + 额度到账 → 到期降级出组；
 * 订单取消；结算对账吸收漂移；欠费态预检 402。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { apps, llmBalanceCache, topupOrders, userGroupMembers, userGroups, users } from '../db/schema.js';
import { seedSettings } from '../lib/settings.js';
import {
  cancelOrder,
  assertPublicAppQuota,
  activateMembership,
  confirmOrder,
  createOrder,
  createPlan,
  downgradeExpired,
  getPublicAppQuota,
  listPlans,
  reconcileRecent,
} from '../lib/billing.js';
import { appendLedger, cachedBalance, precheck, recomputeBalance } from '../lib/llm.js';
import { HttpError } from '../lib/httpError.js';

let dir: string;
let planId = 0;
let groupId = 0;
let userId = 0;

beforeAll(async () => {
  ({ dir } = await setupTestDb());
  await seedSettings();

  const [g] = await getDb().insert(userGroups).values({ name: '会员-高级', createdAt: Date.now() }).returning({ id: userGroups.id });
  groupId = Number(g!.id);
  planId = await createPlan({ name: '高级会员', groupId, durationDays: 30, priceFen: 3000, tokenGrant: 50_000, tier: 3, publicAppLimit: 1 });

  const [u] = await getDb()
    .insert(users)
    .values({ kind: 'local', username: 'billuser', name: 'b', createdAt: Date.now() })
    .returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  await closeDb();
  await teardownTestDb(dir);
});

describe('M3 计费闭环（D1/D2）', () => {
  it('套餐列表保留权益等级', async () => {
    expect(await (await listPlans()).find((plan) => plan.id === planId)?.tier).toBe(3);
  });

  it('订单：创建（manual 渠道）→ 确认到账 → 会员生效入组 + 额度到账', async () => {
    const order = await createOrder(userId, 'membership', { priceFen: 3000, planId });
    expect(order.status).toBe('pending');

    const paid = await confirmOrder(order.id, 1);
    expect(paid.status).toBe('paid');

    const me = (await getDb().select().from(users).where(eq(users.id, userId)))[0];
    expect(me!.membershipPlanId).toBe(planId);
    expect(me!.membershipExpiresAt!).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(me!.plan).toBe('member');

    const inGroup = await getDb()
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId));
    expect(inGroup.map((m) => m.groupId)).toContain(groupId);
    // 开通赠送额度到账
    expect(await cachedBalance(userId)).toBe(50_000);
  });

  it('续费顺延：同套餐再次确认从当前到期时间叠加', async () => {
    const order = await createOrder(userId, 'membership', { priceFen: 3000, planId });
    const before = await (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.membershipExpiresAt!;
    await confirmOrder(order.id, 1);
    const after = await (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.membershipExpiresAt!;
    expect(after - before).toBeGreaterThanOrEqual(29 * 86_400_000);
  });

  it('公开应用额度：按用户当前公开应用数计算剩余名额', async () => {
    await activateMembership(userId, planId);
    await getDb().insert(apps).values({
      id: 'public-quota-test',
      name: '公开额度测试',
      ownerUserId: userId,
      visibility: 'public',
      kind: 'package',
      upstream: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(await getPublicAppQuota(userId)).toEqual({ limit: 1, used: 1, remaining: 0 });
    await expect(assertPublicAppQuota(userId)).rejects.toThrow(/数量已用完/);
    expect((await getPublicAppQuota(userId, 'public-quota-test')).remaining).toBe(1);
  });

  it('取消：pending 可取消，已付不可取消', async () => {
    const o = await createOrder(userId, 'tokens', { priceFen: 1000, tokens: 1000 });
    await cancelOrder(o.id, userId, false);
    await expect(cancelOrder(o.id, userId, false)).rejects.toThrow(/已处理/);
  });

  it('到期降级：清订阅字段 + 移出分组（保留数据）', async () => {
    await getDb()
      .update(users)
      .set({ membershipExpiresAt: Date.now() - 1000 })
      .where(eq(users.id, userId));
    const n = await downgradeExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    const me = (await getDb().select().from(users).where(eq(users.id, userId)))[0];
    expect(me!.membershipPlanId).toBeNull();
    expect(me!.plan).toBe('free');
    const inGroup = await getDb()
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId));
    expect(inGroup.filter((m) => m.groupId === groupId)).toHaveLength(0);
  });
});

describe('M3 结算对账（D2a）', () => {
  it('缓存漂移被重算吸收；欠费态预检 402', async () => {
    const uid = 900;
    await getDb()
      .insert(llmBalanceCache)
      .values({ userId: uid, balance: 999_999, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: llmBalanceCache.userId, set: { balance: 999_999, updatedAt: Date.now() } });
    // 一笔真实用量（账本），缓存未扣 → 漂移
    await appendLedger({
      kind: 'usage',
      delta: -10,
      userId: uid,
      model: 'm',
      promptTokens: 5,
      completionTokens: 5,
      status: 'ok',
      requestId: 't',
    });
    await reconcileRecent();
    // 对账以账本为准：缓存漂移（999999）被纠正为真实余额 -10
    expect(await cachedBalance(uid)).toBe(-10);

    // 打穿为负 → 欠费态：预检直接 402
    await appendLedger({ kind: 'usage', delta: -1_000_000, userId: uid, model: 'm', promptTokens: 1, completionTokens: 1, status: 'ok', requestId: 't2' });
    await recomputeBalance(uid);
    await expect(precheck(uid, 5)).rejects.toBeInstanceOf(HttpError);
    try {
      await precheck(uid, 5);
    } catch (err) {
      expect((err as HttpError).status).toBe(402);
    }
  });
});

// ---------- 卡券码（充值码/会员码） ----------

import { disableCode, generateBatch, normalizeCode, redeem } from '../lib/redeem.js';

describe('M3 卡券码（兑换）', () => {
  it('额度码：生成 → 兑换入账 → 双花拒绝 → 作废拒绝', async () => {
    const uid = 601;
    await getDb()
      .insert(users)
      .values({ kind: 'local', username: 'redeem1', createdAt: Date.now() });
    void uid;
    // 先取真实 user id
    const row = await (await getDb().select().from(users).where(eq(users.username, 'redeem1')))[0]!;
    const before = await cachedBalance(row.id) ?? 0;

    const { batchId, codes } = await generateBatch({ kind: 'tokens', count: 2, tokens: 777, note: 'test', byUserId: 1 });
    expect(codes).toHaveLength(2);
    expect(codes[0]).toMatch(/^AAP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const r = await redeem(row.id, codes[0]!, null);
    expect(r).toMatchObject({ kind: 'tokens', tokens: 777 });
    expect(await cachedBalance(row.id)).toBe(before + 777);

    // 双花（含输入归一化：去掉连字符也应识别同一张）
    await expect(redeem(row.id, codes[0]!.replace(/-/g, ''), null)).rejects.toThrow(/已被使用/);
    // 第二张仍可用
    expect((await redeem(row.id, codes[1]!, null)).kind).toBe('tokens');

    // 作废：未用的第三张码先作废再兑换
    const { codes: c2 } = await generateBatch({ kind: 'tokens', count: 1, tokens: 1, byUserId: 1 });
    await disableCode(normalizeCode(c2[0]!));
    await expect(redeem(row.id, c2[0]!, null)).rejects.toThrow(/作废/);
    void batchId;
  });

  it('会员码：兑换开通套餐并加入分组；过期码拒绝', async () => {
    const [g] = await getDb().insert(userGroups).values({ name: '会员码分组', createdAt: Date.now() }).returning({ id: userGroups.id });
    const gid = g!.id;
    const pid = await createPlan({ name: '月卡', groupId: gid, durationDays: 30, priceFen: 0 });

    const [u] = await getDb()
      .insert(users)
      .values({ kind: 'local', username: 'redeem2', createdAt: Date.now() })
      .returning({ id: users.id });
    const uid = u!.id;
    const { codes } = await generateBatch({ kind: 'membership', count: 1, planId: pid, byUserId: 1 });
    const r = await redeem(uid, codes[0]!, null);
    expect(r).toMatchObject({ kind: 'membership', planName: '月卡' });
    const me = await (await getDb().select().from(users).where(eq(users.id, uid)))[0]!;
    expect(me.membershipExpiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const membership = await getDb()
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, uid));
    const inGroup = membership.map((m) => m.groupId);
    expect(inGroup).toContain(gid);

    // 过期码
    const { codes: exp } = await generateBatch({
      kind: 'tokens',
      count: 1,
      tokens: 1,
      expiresInDays: -1,
      byUserId: 1,
    });
    await expect(redeem(uid, exp[0]!, null)).rejects.toThrow(/过期/);
  });
});

describe('M3 计费事务化回归', () => {
  it('确认到账：入账失败（套餐已删）整体回滚，订单保持 pending、用户状态不变', async () => {
    const before = await (await getDb().select().from(users).where(eq(users.id, userId)))[0]!;
    const order = await createOrder(userId, 'membership', { priceFen: 1000, planId: 999999 });

    await expect(confirmOrder(order.id, 1)).rejects.toThrow();

    const afterOrder = (await getDb()
      .select()
      .from(topupOrders)
      .where(eq(topupOrders.id, order.id)))[0];
    expect(afterOrder?.status).toBe('pending');
    expect(afterOrder?.paidAt).toBeNull();

    const after = await (await getDb().select().from(users).where(eq(users.id, userId)))[0]!;
    expect(after.membershipPlanId).toBe(before.membershipPlanId);
    expect(after.membershipExpiresAt).toBe(before.membershipExpiresAt);
    expect(after.plan).toBe(before.plan);
  });
});
