/**
 * 应用注册表（B4）：PostgreSQL 为唯一事实源，每次读取即拿到最新数据，
 * 管理 CRUD「保存即生效」天然成立。
 * urlSecret AES-256-GCM 加密落盘，转发时才解密拼入，绝不下发浏览器。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { decryptSecret } from '../lib/cryptoSecrets.js';
import { config } from '../config/index.js';

export type AppRow = typeof apps.$inferSelect;

export const PATH_SECRET_KEY = '__path__';

export interface UrlSecret {
  /** query 型：参数名；path 型：null */
  name: string | null;
  /** query 型：参数值；path 型：上游子路径（如 /chat/xxx） */
  value: string;
}

export function isSlug(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
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
 * 可见性模型（P）：
 *  - public：全员（含匿名）
 *  - login：站内共享，仅归属者与管理员可直接访问；其他用户从「站内共享」克隆
 *  - private：仅归属者（用户自建应用默认）
 */
export async function canAccess(
  app: AppRow,
  user: { id: number; authState: string; role: string } | null | undefined,
): Promise<boolean> {
  if (isAdminUser(user)) return true;
  switch (app.visibility) {
    case 'public':
      return true;
    case 'login':
      return Boolean(user && user.authState === 'full' && app.ownerUserId === user.id);
    case 'private':
      return Boolean(user && user.authState === 'full' && app.ownerUserId === user.id);
    default:
      return false;
  }
}

/** 门户卡片是否对该用户展示（private 且非归属者/管理员 → 隐藏） */
export function isVisibleInPortal(app: AppRow, user: { id: number; role: string } | null | undefined): boolean {
  if (isAdminUser(user)) return true;
  if (app.visibility === 'login') return Boolean(user && app.ownerUserId === user.id);
  if (app.visibility !== 'private') return true;
  return Boolean(user && app.ownerUserId === user.id);
}
