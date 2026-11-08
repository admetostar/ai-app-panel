/**
 * LLM 网关核心（C1–C6）。
 * C/D 边界铁律（PRD）：账本只有一份（llm_ledger，append-only 只记不判）；
 * 余额只有一处（llm_balance_cache，读流水重算）。C 是请求路径上的记录者与
 * 预检者，结算（M3 D2a）在请求路径外异步校正，打穿 → 欠费态 + 失效缓存。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../db/index.js';
import { llmAppTokens, llmBalanceCache, llmLedger, llmRoutes, llmUpstreams, apps } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './cryptoSecrets.js';
import { HttpError } from './httpError.js';
import { getSetting, getSettingInt } from './settings.js';
import { appHasLlmCapability } from '../gateway/registry.js';

// ---------- 网关凭据（C2） ----------

/** 应用凭据默认限流（请求/分） */
export function llmPerMinuteDefault(): number {
  return getSettingInt('RATE_LLM_PER_MIN', 60) || 60;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AppTokenRow {
  id: number;
  tokenHash: string;
  appId: string;
  name: string;
  enabled: boolean;
  perMinuteLimit: number | null;
  auto: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function createAppToken(
  appId: string,
  name: string,
  perMinuteLimit: number | null,
  opts?: { auto?: boolean },
): Promise<string> {
  const token = `aapk_${randomBytes(24).toString('base64url')}`;
  const auto = opts?.auto === true;
  await getDb()
    .insert(llmAppTokens)
    .values({
      tokenHash: hashToken(token),
      appId,
      name: name.slice(0, 64),
      perMinuteLimit,
      auto,
      // 自动签发的凭据：明文加密保管，供运行时（M4 沙箱）按 appId 注入，不再人工下发
      tokenEnc: auto ? encryptSecret(token) : null,
      createdAt: Date.now(),
    });
  return token;
}

/** 已为应用自动签发的网关凭据（解密明文）；无则 null。M4 运行时启动注入用 */
export async function getAppLlmProvision(appId: string): Promise<{ token: string; perMinuteLimit: number | null } | null> {
  const row = (await getDb()
    .select()
    .from(llmAppTokens)
    .where(and(eq(llmAppTokens.appId, appId), eq(llmAppTokens.auto, true), eq(llmAppTokens.enabled, true))))[0];
  if (!row?.tokenEnc) return null;
  try {
    return { token: decryptSecret(row.tokenEnc), perMinuteLimit: row.perMinuteLimit };
  } catch {
    return null;
  }
}

/**
 * 网关侧 llm 能力闸（审计 F1）：AAP_TOKEN 是运行时凭据、对全部包签发
 * （egress 出站 / 身份归因都依赖它），因此「花模型余额」必须单独闸——
 * /api/aap/llm/chat 与 /v1 直连两侧按同一判定：manifest.capabilities 声明
 * llm 才放行。无 manifestJson 的应用（管理员手建 HTML/反代应用 + 手动凭据）
 * 无声明面，沿用旧行为放行；应用删除时凭据在删除路由连带吊销（app.delete）。
 */
export async function appLlmAllowed(appId: string): Promise<boolean> {
  const row = (await getDb()
    .select({ manifestJson: apps.manifestJson })
    .from(apps)
    .where(eq(apps.id, appId)))[0];
  // 应用行不存在：管理员手动签发的虚拟凭据（外部集成等用途，appId 可不对应
  // 已上传应用）沿用旧行为放行；已删除应用的凭据随删除路由连带吊销，不会走到这
  if (!row) return true;
  if (!row.manifestJson) return true;
  return appHasLlmCapability(row);
}

/** 自动签发运行时凭据（幂等；重复上传复用）。对全部包签发（AAP_TOKEN 同时
 *  是 egress 凭据），LLM 花费面由 appLlmAllowed 在网关侧闸——签发广度与
 *  能力闸门解耦，勿以「未声明 llm 就不签发」来修（会断非 llm 包的出站代理）。 */
export async function ensureAutoProvisionedToken(appId: string): Promise<void> {
  const existing = (await getDb()
    .select()
    .from(llmAppTokens)
    .where(and(eq(llmAppTokens.appId, appId), eq(llmAppTokens.auto, true))))[0];
  if (existing && existing.enabled) return;
  await createAppToken(appId, '自动签发（manifest llm）', null, { auto: true });
}

/** Bearer token → 凭据行；未命中/已吊销 → null */
export async function resolveAppToken(bearer: string | undefined | null): Promise<AppTokenRow | null> {
  if (!bearer) return null;
  const row = (await getDb()
    .select()
    .from(llmAppTokens)
    .where(eq(llmAppTokens.tokenHash, hashToken(bearer))))[0];
  if (!row || !row.enabled) return null;
  return row;
}

export async function listAppTokens(): Promise<Array<AppTokenRow & { id: number }>> {
  return await getDb().select().from(llmAppTokens).orderBy(sql`id DESC`);
}

export async function revokeAppToken(id: number): Promise<void> {
  await getDb().delete(llmAppTokens).where(eq(llmAppTokens.id, id));
}

// ---------- 上游与模型目录（C3） ----------

export interface UpstreamRow {
  id: number;
  name: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: number;
}

export async function createUpstream(name: string, baseUrl: string, apiKey: string): Promise<number> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpError(400, 'INVALID_BASE_URL', '上游 Base URL 不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_BASE_URL', '上游协议必须是 http/https');
  }
  const [created] = await getDb()
    .insert(llmUpstreams)
    .values({ name, baseUrl, apiKeyEnc: encryptSecret(apiKey), createdAt: Date.now() })
    .returning({ id: llmUpstreams.id });
  if (!created) throw new Error('Failed to create LLM upstream');
  return created.id;
}

export async function listUpstreams(): Promise<Array<UpstreamRow & { hasKey: boolean }>> {
  const rows = await getDb()
    .select()
    .from(llmUpstreams);
  return rows.map((u) => ({ id: u.id, name: u.name, baseUrl: u.baseUrl, enabled: u.enabled, createdAt: u.createdAt, hasKey: Boolean(u.apiKeyEnc) }));
}

export async function updateUpstream(id: number, patch: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean }): Promise<void> {
  const set: Partial<typeof llmUpstreams.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.apiKey) set.apiKeyEnc = encryptSecret(patch.apiKey);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  await getDb().update(llmUpstreams).set(set).where(eq(llmUpstreams.id, id));
}

export async function deleteUpstream(id: number): Promise<void> {
  await getDb().delete(llmUpstreams).where(eq(llmUpstreams.id, id));
}

async function upstreamApiKey(upstreamId: number): Promise<string> {
  const row = (await getDb().select().from(llmUpstreams).where(eq(llmUpstreams.id, upstreamId)))[0];
  if (!row) throw new HttpError(502, 'UPSTREAM_GONE', '上游已删除');
  return decryptSecret(row.apiKeyEnc);
}

export interface RouteRow {
  id: number;
  model: string;
  upstreamId: number;
  upstreamModel: string;
  multiplier: number;
  priority: number;
  weight: number;
  enabled: boolean;
}

export async function listRoutes(): Promise<RouteRow[]> {
  return await getDb().select().from(llmRoutes);
}

export async function createRoute(r: { model: string; upstreamId: number; upstreamModel: string; mediaAdapter?: 'image_url' | 'video_url'; multiplier?: number; priority?: number; weight?: number }): Promise<void> {
  await getDb()
    .insert(llmRoutes)
    .values({
      model: r.model.trim(),
      upstreamId: r.upstreamId,
      upstreamModel: r.upstreamModel.trim(),
      mediaAdapter: r.mediaAdapter ?? 'image_url',
      multiplier: r.multiplier ?? 100,
      priority: r.priority ?? 100,
      weight: r.weight ?? 100,
      createdAt: Date.now(),
    });
}

export async function deleteRoute(id: number): Promise<void> {
  await getDb().delete(llmRoutes).where(eq(llmRoutes.id, id));
}

/** aap.llm.chat 的平台默认模型（规范 §3.1「不填用平台默认」）：
 *  显式设置 LLM_DEFAULT_MODEL 优先，否则模型目录排序第一个；目录为空返回 null */
export async function resolveDefaultModel(): Promise<string | null> {
  const configured = (getSetting('LLM_DEFAULT_MODEL') ?? '').trim();
  if (configured) return configured;
  return (await modelCatalog())[0] ?? null;
}

/** 聚合模型目录（C1 /v1/models 数据源） */
export async function modelCatalog(): Promise<string[]> {
  const rows = await getDb()
    .select({ m: llmRoutes.model })
    .from(llmRoutes)
    .where(eq(llmRoutes.enabled, true));
  return [
    ...new Set(
      rows.map((r) => r.m),
    ),
  ].sort();
}

/** 按模型解析 failover 候选：priority 升序，同优先级按 weight 加权随机 */
export async function resolveRouteCandidates(model: string, mediaTypes: Array<'image' | 'video'> = []): Promise<Array<{ upstreamId: number; upstreamModel: string; mediaAdapter: 'image_url' | 'video_url'; multiplier: number; upstreamBaseUrl: string; apiKey: string }>> {
  const rows = await getDb()
    .select({
      id: llmRoutes.id,
      model: llmRoutes.model,
      upstreamId: llmRoutes.upstreamId,
      upstreamModel: llmRoutes.upstreamModel,
      mediaAdapter: llmRoutes.mediaAdapter,
      multiplier: llmRoutes.multiplier,
      priority: llmRoutes.priority,
      weight: llmRoutes.weight,
      baseUrl: llmUpstreams.baseUrl,
      upstreamEnabled: llmUpstreams.enabled,
    })
    .from(llmRoutes)
    .innerJoin(llmUpstreams, eq(llmRoutes.upstreamId, llmUpstreams.id))
    .where(and(eq(llmRoutes.model, model), eq(llmRoutes.enabled, true)));

  const live = rows.filter((r) => r.upstreamEnabled && (!mediaTypes.includes('video') || r.mediaAdapter === 'video_url'));
  if (live.length === 0) return [];

  const byPriority = new Map<number, typeof live>();
  for (const r of live) {
    const list = byPriority.get(r.priority) ?? [];
    list.push(r);
    byPriority.set(r.priority, list);
  }
  const candidates: Array<{ upstreamId: number; upstreamModel: string; mediaAdapter: 'image_url' | 'video_url'; multiplier: number; upstreamBaseUrl: string; apiKey: string }> = [];
  for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
    const list = byPriority.get(priority)!;
    // 同优先级：weight 加权随机抽一个作为该层代表（简单加权轮换语义）
    const total = list.reduce((acc, r) => acc + Math.max(1, r.weight), 0);
    let pick = Math.random() * total;
    let chosen = list[0]!;
    for (const r of list) {
      pick -= Math.max(1, r.weight);
      if (pick <= 0) {
        chosen = r;
        break;
      }
    }
    candidates.push({
      upstreamId: chosen.upstreamId,
      upstreamModel: chosen.upstreamModel,
      mediaAdapter: chosen.mediaAdapter === 'video_url' ? 'video_url' : 'image_url',
      multiplier: chosen.multiplier,
      upstreamBaseUrl: chosen.baseUrl,
      apiKey: await upstreamApiKey(chosen.upstreamId),
    });
  }
  return candidates;
}

// ---------- 计量与预检（C5/C6） ----------

/** 余额缓存读数（无行 = 未初始化，由结算重算） */
export async function cachedBalance(userId: number): Promise<number | null> {
  const row = (await getDb().select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, userId)))[0];
  return row ? row.balance : null;
}

/** 在途请求的预估成本（进程内；预检扣减只存在于缓存不在账本）。
 *  不记账则重算/对账会周期性抹掉在途扣减 → 常态化漏账（终审 P1）。 */
const inFlightEstimate = new Map<number, number>();

function addInFlightEstimate(userId: number, cost: number): void {
  inFlightEstimate.set(userId, (inFlightEstimate.get(userId) ?? 0) + cost);
}

function releaseInFlightEstimate(userId: number, cost: number): void {
  const left = (inFlightEstimate.get(userId) ?? 0) - cost;
  if (left > 0) inFlightEstimate.set(userId, left);
  else inFlightEstimate.delete(userId);
}

export function hasInFlightRequests(userId: number): boolean {
  return (inFlightEstimate.get(userId) ?? 0) > 0;
}

/** 从账本重算余额并写缓存（结算语义：读流水算余额；供事件失效与定时校正调用）。
 *  在途预估成本不在账本，重算时补减，避免对账/查账抹掉预检扣减。 */
export async function recomputeBalance(userId: number, executor: DbExecutor = getDb()): Promise<number> {
  const row = (await executor
    .select({ sum: sql<number>`coalesce(sum(delta), 0)` })
    .from(llmLedger)
    .where(eq(llmLedger.userId, userId)))[0];
  const balance = Number(row?.sum ?? 0) - (inFlightEstimate.get(userId) ?? 0);
  await executor
    .insert(llmBalanceCache)
    .values({ userId, balance, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: llmBalanceCache.userId, set: { balance, updatedAt: Date.now() } });
  return balance;
}

/** 账本追加（usage/grant/adjust 全走这里；append-only） */
export interface LedgerAppend {
  kind: 'usage' | 'grant' | 'adjust';
  delta: number;
  userId?: number | null;
  appId?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  status?: 'ok' | 'error';
  requestId?: string | null;
  note?: string | null;
}

export async function appendLedger(e: LedgerAppend, executor: DbExecutor = getDb()): Promise<number> {
  const [created] = await executor
    .insert(llmLedger)
    .values({
      ts: Date.now(),
      userId: e.userId ?? null,
      appId: e.appId ?? null,
      kind: e.kind,
      model: e.model ?? null,
      promptTokens: e.promptTokens ?? null,
      completionTokens: e.completionTokens ?? null,
      delta: Math.round(e.delta),
      latencyMs: e.latencyMs ?? null,
      status: e.status ?? 'ok',
      requestId: e.requestId ?? null,
      note: e.note ?? null,
    })
    .returning({ id: llmLedger.id });
  if (!created) throw new Error('Failed to append LLM ledger entry');
  return created.id;
}

/** 管理员调额/发放（写账本 + 失效缓存——缓存同步三触发之一） */
export async function grantTokens(userId: number, delta: number, note: string, byUserId: number, executor: DbExecutor = getDb()): Promise<number> {
  const id = await appendLedger({ kind: delta >= 0 ? 'grant' : 'adjust', delta, userId, note, status: 'ok' }, executor);
  await recomputeBalance(userId, executor);
  await auditGrant(userId, delta, note, byUserId);
  return id;
}

import { audit } from './audit.js';
async function auditGrant(userId: number, delta: number, note: string, by: number): Promise<void> {
  await audit(`admin:${by}`, null, 'llm.balance.adjust', { userId, delta, note });
}

/** 预检闸门（C6）：原子递减预估成本；余额不足 → 402，请求不出网关。
 *  无用户归因（userId=null）默认拒绝（403）：否则任何持 app token 者可绕过
 *  全部余额闸门免费调用（已实测利用路径）；可信内网应用可由管理员切 'allow'。 */
export async function precheck(userId: number | null, estimatedCost: number): Promise<void> {
  if (userId === null) {
    if (getSetting('LLM_UNATTRIBUTED_POLICY') !== 'allow') {
      throw new HttpError(403, 'ATTRIBUTION_REQUIRED', '该调用未携带用户身份归因（X-AAP-Identity），网关拒绝无归因请求；如确需应用级匿名调用，请在计费设置中调整');
    }
    return;
  }
  const db = getDb();
  const row = (await db.select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, userId)))[0];
  if (!row) {
    // 缓存未初始化：先按流水重算建行（避免首请求误拒），随后与其他请求
    // 走同一条条件递减路径（首请求同样占用预估）
    await recomputeBalance(userId);
  }
  // 原子条件递减：balance >= est 才扣
  const res = await db
    .update(llmBalanceCache)
    .set({ balance: sql`balance - ${estimatedCost}`, updatedAt: Date.now() })
    .where(and(eq(llmBalanceCache.userId, userId), sql`balance >= ${estimatedCost}`))
    .returning({ userId: llmBalanceCache.userId });
  if (res.length === 0) {
    throw insufficient(await cachedBalance(userId) ?? 0);
  }
  addInFlightEstimate(userId, estimatedCost);
}

function insufficient(balance: number): HttpError {
  return new HttpError(402, 'INSUFFICIENT_BALANCE', '额度不足，请充值或联系管理员', {
    balance,
  });
}

/** 事后校正：实际扣费与预估的差值补回/补扣（不动账本——账本只记实际用量）；
 *  同时释放在途预估占用。 */
export async function settleEstimate(userId: number | null, estimatedCost: number, actualCost: number): Promise<void> {
  if (userId === null) return;
  releaseInFlightEstimate(userId, estimatedCost);
  const diff = estimatedCost - actualCost;
  if (diff === 0) return;
  await getDb()
    .update(llmBalanceCache)
    .set({ balance: sql`balance + ${diff}`, updatedAt: Date.now() })
    .where(eq(llmBalanceCache.userId, userId));
}

/** 事件总线：缓存失效三触发（扣款欠费/充值到账/手动调额）统一走这里 */
type BalanceListener = (userId: number) => void;
const listeners = new Set<BalanceListener>();
export function onBalanceInvalidate(fn: BalanceListener): void {
  listeners.add(fn);
}
export async function invalidateBalance(userId: number): Promise<void> {
  await recomputeBalance(userId);
  for (const fn of listeners) fn(userId);
}

/** 用量入账（请求完成后调用；实际用量落账本） */
export async function recordUsage(e: {
  userId: number | null;
  appId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  multiplier: number;
  latencyMs: number;
  status: 'ok' | 'error';
  requestId: string;
}): Promise<number> {
  const cost = Math.ceil(((e.promptTokens + e.completionTokens) * e.multiplier) / 100);
  const id = await appendLedger({
    kind: 'usage',
    delta: -cost,
    userId: e.userId,
    appId: e.appId,
    model: e.model,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    latencyMs: e.latencyMs,
    status: e.status,
    requestId: e.requestId,
  });
  if (e.userId !== null) {
    // 实际扣费与缓存的校正走 settleEstimate；这里触发一次余额缓存事件（持久化视角刷新）
    const row = (await getDb().select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, e.userId)))[0];
    if (!row) await recomputeBalance(e.userId);
  }
  return cost;
}
