/**
 * 首次初始化（F3，Docker 形态的种子逻辑）：users 为空时创建初始管理员——
 * 随机密码（或 ADMIN_INITIAL_PASSWORD）打印容器日志 + 写 data/ 一次性凭据
 * 文件（0600）；管理员首次登录（强制改密流程）时删除该文件。
 * FPK 形态的 NAS 管理员免密通道在 W10 落地，最终收敛到同一 checklist。
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { localCredentials, users } from '../db/schema.js';
import { generatePassword, hashPassword } from './passwords.js';
import { audit } from './audit.js';
import { defaultAvatarForUser } from './userAvatar.js';

export const CREDENTIALS_FILE = 'admin-credentials.txt';
const INITIAL_ADMIN_POINTS = 99_999_999;

function credentialsPath(): string {
  return path.join(config.dataDir, CREDENTIALS_FILE);
}

export async function userCount(): Promise<number> {
  return Number((await getDb().select({ n: sql<number>`count(*)` }).from(users))[0]?.n ?? 0);
}

export async function adminCount(): Promise<number> {
  return Number((await getDb().select({ n: sql<number>`count(*)` }).from(users).where(sql`role = 'admin'`))[0]?.n ?? 0);
}

/** 首启引导；幂等（已有用户则跳过）。async：凭据 scrypt 完成前不得放行 listen，
 *  否则首秒内登录会因凭据行未落库而 401（e2e setup 高负载下随机踩中） */
export async function ensureInitialAdmin(): Promise<void> {
  if (await userCount() > 0) return;

  const username = (process.env.ADMIN_USERNAME?.trim() || 'admin').toLowerCase();
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
    console.error(`[bootstrap] ADMIN_USERNAME 非法（3-64 位字母数字_.-）：${username}，跳过引导`);
    return;
  }
  const password = config.adminInitialPassword ?? generatePassword(12);

  const [created] = await getDb()
    .insert(users)
    .values({
      kind: 'local',
      username,
      name: '管理员',
      role: 'admin',
      status: 'active',
      pointsBalance: INITIAL_ADMIN_POINTS,
      mustChangePassword: true, // F3：初始密码登录 → 强制改密 → 强制绑 MFA → checklist
      createdAt: Date.now(),
    })
    .returning({ id: users.id });
  if (!created) throw new Error('Failed to create bootstrap administrator');
  const userId = created.id;
  await getDb().update(users).set({ avatar: defaultAvatarForUser(userId) }).where(eq(users.id, userId));
  await writeLocalCredentials(userId, password);

  // 凭据落盘（0600）+ 打印日志
  const content = [
    '=== AI超级面板 初始管理员凭据（一次性，首次登录后本文件自动删除） ===',
    `地址: http://localhost:${config.port}`,
    `用户名: ${username}`,
    `密码: ${password}`,
    '首次登录后请立即设置新密码并绑定 MFA。',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(credentialsPath(), content, { mode: 0o600 });
  } catch (err) {
    console.error('[bootstrap] 凭据文件写入失败:', err);
  }
  console.log(content);
  await audit('system', null, 'bootstrap.admin.created', { username, via: config.adminInitialPassword ? 'env' : 'random' });
}

/** 管理员首次登录（进入强制改密流程）后删除一次性凭据文件 */
export function disposeCredentialsFile(): void {
  try {
    const p = credentialsPath();
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log('[bootstrap] 一次性凭据文件已删除');
    }
  } catch {
    // 删除失败不影响登录
  }
}

/** 创建/更新本地凭据（注册、改密、引导共用） */
export async function writeLocalCredentials(userId: number, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await getDb()
    .insert(localCredentials)
    .values({ userId, passwordHash, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: localCredentials.userId, set: { passwordHash, updatedAt: Date.now() } });
}

export async function getLocalPasswordHash(userId: number): Promise<string | null> {
  return (
    await (await getDb()
      .select({ h: localCredentials.passwordHash })
      .from(localCredentials)
      .where(eq(localCredentials.userId, userId)))[0]?.h ?? null
  );
}
