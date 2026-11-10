/**
 * 应用注册表（B4）：PostgreSQL 为唯一事实源，每次读取即拿到最新数据，
 * 管理 CRUD「保存即生效」天然成立。
 * urlSecret AES-256-GCM 加密落盘，转发时才解密拼入，绝不下发浏览器。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps, users } from '../db/schema.js';
import { decryptSecret } from '../lib/cryptoSecrets.js';
import { config } from '../config/index.js';
import type { ManifestRouteAccess } from './staticApp.js';

export type AppRow = typeof apps.$inferSelect;

export const PATH_SECRET_KEY = '__path__';

export function appHasLlmCapability(app: Pick<AppRow, 'manifestJson'>): boolean {
  if (!app.manifestJson) return false;
  try {
    const manifest = JSON.parse(app.manifestJson) as { capabilities?: unknown };
    return Array.isArray(manifest.capabilities) && manifest.capabilities.includes('llm');
  } catch {
    return false;
  }
}

export function requiresOwnerBilling(app: Pick<AppRow, 'manifestJson'>): boolean {
  return appHasLlmCapability(app);
}

export async function hasValidLlmOwner(app: Pick<AppRow, 'ownerUserId' | 'manifestJson'>): Promise<boolean> {
  if (!requiresOwnerBilling(app)) return true;
  if (app.ownerUserId == null) return false;
  return Boolean((await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, app.ownerUserId))
    .limit(1))[0]);
}

export interface UrlSecret {
  /** query 型：参数名；path 型：null */
  name: string | null;
  /** query 型：参数值；path 型：上游子路径（如 /chat/xxx） */
  value: string;
}

export function isSlug(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || /^clone_[0-9a-f]{8}$/.test(id);
}

/**
 * FPK 统一网关形态下，应用 ID 不得与网关前缀末段相同（GATEWAY_PREFIX=/app/ai-app-panel
 * 时即禁止 id=ai-app-panel）：入口层会把 /app/<末段>/... 整体剥前缀进门户路由，
 * 同名应用的反代路径将永远不可达。端口/容器形态（未配置前缀）不受限。
 */
export function idConflictsWithGatewayPrefix(id: string, prefix = config.gatewayPrefix): boolean {
  const last = prefix?.split('/').filter(Boolean).pop();
  return !!last && id.toLowerCase() === last.toLowerCase();
}

export async function listApps(): Promise<AppRow[]> {
  return await getDb().select().from(apps).orderBy(apps.sort, apps.id);
}

export async function findApp(id: string): Promise<AppRow | null> {
  return (await getDb().select().from(apps).where(eq(apps.id, id)))[0] ?? null;
}

/** 解析 urlSecret 密文；未配置返回 null */
export function getUrlSecret(app: AppRow): UrlSecret | null {
  if (!app.urlSecretEnc) return null;
  try {
    const raw = decryptSecret(app.urlSecretEnc);
    if (raw.startsWith(PATH_SECRET_KEY + '=')) {
      return { name: null, value: raw.slice(PATH_SECRET_KEY.length + 1) };
    }
    const eqi = raw.indexOf('=');
    if (eqi <= 0) return null;
    return { name: raw.slice(0, eqi), value: raw.slice(eqi + 1) };
  } catch (err) {
    console.error(`[registry] app ${app.id} urlSecret 解密失败:`, err);
    return null;
  }
}

/** 管理员可见一切（含 private） */
function isAdminUser(user: { role: string } | null | undefined): boolean {
  return Boolean(user && user.role === 'admin');
}

/**
 * 登录用户可见性（P）：
 *  - public：全员（含匿名）
 *  - login：站内共享，仅归属者与管理员可直接访问；其他用户只能克隆
 *  - private：门户中仅归属者可见；分享链接需要登录后访问
 */
export async function canAccess(
  app: AppRow,
  user: { id: number; authState: string; role: string } | null | undefined,
  request?: { method: string; path: string; websocket?: boolean },
): Promise<boolean> {
  const routeAccess = request
    ? manifestRouteAccess(app, request.method, request.path, request.websocket)
    : null;
  if (user && routeAccess?.access === 'account' && user.authState !== 'full') return false;
  if (isAdminUser(user)) return true;
  if (!user) {
    if (app.anonymousAccess === 'none') return false;
    if (app.anonymousAccessPolicy === 'legacy' && !hasManifestRouteDefinitions(app)) return true;
    if (!request) {
      return hasManifestAnonymousRoutes(app, app.anonymousAccess);
    }
    const rule = routeAccess ?? manifestRouteAccess(app, request.method, request.path, request.websocket);
    if (!rule || rule.access === 'account') return false;
    if (
      app.anonymousAccess === 'read' &&
      (request.websocket || !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()))
    ) return false;
    return app.anonymousAccess === 'write' || rule.access === 'anonymous_read';
  }
  switch (app.visibility) {
    case 'public':
      return true;
    case 'login':
      return Boolean(user && user.authState === 'full' && app.ownerUserId === user.id);
    case 'private':
      return Boolean(user && user.authState === 'full');
    default:
      return false;
  }
}

export function manifestRouteAccess(
  app: Pick<AppRow, 'manifestJson'>,
  method: string,
  requestPath: string,
  websocket = false,
): ManifestRouteAccess | null {
  if (!app.manifestJson) return null;
  let manifest: { routes?: unknown };
  try {
    manifest = JSON.parse(app.manifestJson) as { routes?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(manifest.routes)) return null;
  const normalizedPath = normalizeRoutePath(requestPath);
  let best: ManifestRouteAccess | null = null;
  let bestSpecificity = -1;
  for (const rawRule of manifest.routes) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue;
    const rule = rawRule as Partial<ManifestRouteAccess>;
    if (
      typeof rule.path !== 'string' ||
      !Array.isArray(rule.methods) ||
      !rule.methods.every((value) => typeof value === 'string') ||
      (rule.access !== 'anonymous_read' && rule.access !== 'anonymous_write' && rule.access !== 'account')
    ) continue;
    if (!rule.methods.includes(websocket ? 'WS' : method.toUpperCase())) continue;
    const pattern = normalizeRoutePath(rule.path);
    const matches = pattern.endsWith('*')
      ? normalizedPath.startsWith(pattern.slice(0, -1))
      : normalizedPath === pattern;
    if (!matches) continue;
    const specificity = pattern.endsWith('*') ? pattern.length - 1 : Number.MAX_SAFE_INTEGER;
    if (specificity > bestSpecificity) {
      best = rule as ManifestRouteAccess;
      bestSpecificity = specificity;
    }
  }
  return best;
}

export function hasManifestAnonymousRoutes(
  app: Pick<AppRow, 'manifestJson'>,
  permission?: 'read' | 'write',
): boolean {
  if (!app.manifestJson) return false;
  try {
    const manifest = JSON.parse(app.manifestJson) as { routes?: unknown };
    return Array.isArray(manifest.routes) && manifest.routes.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const access = (item as { access?: unknown }).access;
      return permission === 'write'
        ? access === 'anonymous_read' || access === 'anonymous_write'
        : permission === 'read'
          ? access === 'anonymous_read'
          : access === 'anonymous_read' || access === 'anonymous_write';
    });
  } catch {
    return false;
  }
}

function hasManifestRouteDefinitions(app: Pick<AppRow, 'manifestJson'>): boolean {
  if (!app.manifestJson) return false;
  try {
    const manifest = JSON.parse(app.manifestJson) as { routes?: unknown };
    return Array.isArray(manifest.routes) && manifest.routes.length > 0;
  } catch {
    return false;
  }
}

function normalizeRoutePath(value: string): string {
  const path = value.startsWith('/') ? value : `/${value}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** 门户卡片是否对该用户展示（private 且非归属者/管理员 → 隐藏） */
export function isVisibleInPortal(app: AppRow, user: { id: number; role: string } | null | undefined): boolean {
  if (app.clonedFromAppId) return false;
  if (isAdminUser(user)) return true;
  if (app.visibility === 'login') return Boolean(user && app.ownerUserId === user.id);
  if (app.visibility !== 'private') return true;
  return Boolean(user && app.ownerUserId === user.id);
}
