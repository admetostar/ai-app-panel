import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generate as totpGenerate } from 'otplib';

/**
 * E2E 全局装配：
 *  - mock 上游应用（9911：HTML 标记页 + JSON 回显）
 *  - 门户服务（9910：tsx 起真实 server，临时数据目录，生产 web 构建产物）
 *  - 预置：初始管理员（已知密码）→ 登录 → 创建 demo 应用 → 开放注册
 *    （P1-6 强制流程门禁后，管理端点须先走完 改密+绑 MFA 的强制流程；
 *     配置完成后直写 DB 把 admin 还原为初始态，供浏览器测试独立验收强制流程）
 */

export const PORTAL = 'http://127.0.0.1:9910';
export const UPSTREAM = 'http://127.0.0.1:9912'; // 避开本地体验用的 9911
export const INIT_ADMIN_PASSWORD = 'E2e-init-password-123';
export const ADMIN_NEW_PASSWORD = 'E2e-new-password-123';
/** 预置普通用户（mustChangePassword=1）：验收「普通用户不强制绑 MFA」回归。
 *  密码用常量显式传入（worker 进程读不到 setup 进程的模块状态） */
export const NORMAL_USERNAME = 'e2e-normal';
export const NORMAL_INIT_PASSWORD = 'E2e-normal-init-password-123';

const RUN_DIR = path.join(__dirname, '.run');
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const SCHEMA_FILE = path.join(RUN_DIR, 'database-schema');
const SERVER_DIR = path.join(__dirname, '../apps/server');

let portal: ChildProcess | null = null;
let upstream: http.Server | null = null;

function baseDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('E2E tests require E2E_DATABASE_URL, TEST_DATABASE_URL, or DATABASE_URL');
  }
  return url;
}

function scopedDatabaseUrl(url: string, schema: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  return scoped.toString();
}

function runPg(url: string, query: string, values: unknown[] = []): Array<Record<string, unknown>> {
  const script =
    "const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.E2E_PG_URL});" +
    "(async()=>{try{const result=await pool.query(process.argv[1],JSON.parse(process.argv[2]));" +
    "console.log(JSON.stringify(result.rows));}finally{await pool.end();}})()" +
    ".catch(error=>{console.error(error);process.exitCode=1});";
  const output = execFileSync(
    'node',
    ['-e', script, query, JSON.stringify(values)],
    { cwd: SERVER_DIR, env: { ...process.env, E2E_PG_URL: url } },
  ).toString();
  return JSON.parse(output) as Array<Record<string, unknown>>;
}

export function runDatabaseQuery(query: string, values: unknown[] = []): Array<Record<string, unknown>> {
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8').trim();
  return runPg(scopedDatabaseUrl(baseDatabaseUrl(), schema), query, values);
}

export async function setup(): Promise<void> {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  // 清掉残留的旧服务进程（避免端口/数据目录竞争）
  try {
    execFileSync('pkill', ['-f', 'tsx src/server.ts'], { stdio: 'ignore' });
  } catch {
    /* 没有残留 */
  }
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(path.join(RUN_DIR, 'data'), { recursive: true, force: true });
  fs.writeFileSync(SERVER_LOG, '');

  const databaseUrl = baseDatabaseUrl();
  const schema = `ai_app_panel_e2e_${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(SCHEMA_FILE, schema);
  runPg(databaseUrl, `CREATE SCHEMA "${schema}"`);
  process.env.E2E_DATABASE_URL = databaseUrl;
  process.env.DATABASE_URL = scopedDatabaseUrl(databaseUrl, schema);

  // mock 上游应用
  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/echo')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url, headers: req.headers }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><html><head><title>demo</title></head>` +
        `<body><h1 id="upstream-marker">DEMO-UPSTREAM-OK</h1>` +
        `<p>url=${url}</p></body></html>`,
    );
  });
  await new Promise<void>((r) => upstream!.listen(9912, '127.0.0.1', r));

  // 门户服务（tsx 直跑，生产 web 产物由 WEB_DIST 指定）
  portal = spawn(process.execPath, [path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: '9910',
      DATA_DIR: path.join(RUN_DIR, 'data'),
      WEB_DIST: path.join(__dirname, '../apps/web/dist'),
      MIGRATIONS_SCHEMA: schema,
      ADMIN_INITIAL_PASSWORD: INIT_ADMIN_PASSWORD,
      ADMIN_USERNAME: 'admin',
    },
    stdio: ['ignore', fs.openSync(SERVER_LOG, 'a'), fs.openSync(SERVER_LOG, 'a')],
    detached: false,
  });
  await waitHealthy(`${PORTAL}/api/health`, 30_000);

  // 预置数据：登录初始管理员 → 配零价权益包 → 开放注册 → 接入 demo 应用
  const login = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PORTAL },
    body: JSON.stringify({ username: 'admin', password: INIT_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`初始管理员登录失败: ${login.status}`);
  const cookie = (login.headers.getSetCookie().find((c) => c.startsWith('aap_sid=')) ?? '').split(';')[0];

  // 记录初始 admin 行（用于配置后还原初始态，避免测试之间共享安全设置状态）。
  const [pristine] = runDatabaseQuery(
    'SELECT users.*, local_credentials.password_hash AS "__password_hash" ' +
      'FROM users JOIN local_credentials ON local_credentials.user_id = users.id WHERE users.username = $1',
    ['admin'],
  );
  if (!pristine) throw new Error('E2E 数据库中未找到初始管理员');

  // 强制流程门禁（P1-6）：改密 → 步升 → 绑 TOTP，之后管理端点才放行
  const cp = await api('POST', '/api/auth/change-password', { currentPassword: INIT_ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD }, cookie);
  if (cp.status !== 200) throw new Error(`改密失败: ${JSON.stringify(cp.body)}`);
  const su = await api('POST', '/api/auth/step-up/password', { password: ADMIN_NEW_PASSWORD }, cookie);
  if (su.status !== 200) throw new Error(`步升失败: ${JSON.stringify(su.body)}`);
  const enroll = await api('POST', '/api/auth/mfa/totp/enroll', undefined, cookie);
  const secret = (enroll.body as { secret?: string }).secret;
  if (!secret) throw new Error(`MFA enroll 失败: ${JSON.stringify(enroll.body)}`);
  const confirm = await api('POST', '/api/auth/mfa/totp/confirm', { token: await totpGenerate({ secret }) }, cookie);
  if (confirm.status !== 200) throw new Error(`MFA confirm 失败: ${JSON.stringify(confirm.body)}`);

  const group = await api('POST', '/api/admin/groups', { name: 'E2E 免费权益组', note: 'E2E registration plan' }, cookie);
  if (group.status >= 300) throw new Error(`权益分组创建失败: ${JSON.stringify(group.body)}`);
  const groupId = (group.body as { id: number }).id;
  const plan = await api(
    'POST',
    '/api/admin/billing/plans',
    { name: 'E2E 免费权益包', groupId, durationDays: 30, priceFen: 0, tokenGrant: 0, tier: 0, appUploadLimit: 10 },
    cookie,
  );
  if (plan.status >= 300) throw new Error(`零价权益包创建失败: ${JSON.stringify(plan.body)}`);

  const app = await api(
    'POST',
    '/api/admin/apps',
    {
      id: 'demo',
      name: '演示应用',
      description: 'E2E 样例：验证网关与卡片墙',
      category: '演示',
      upstream: UPSTREAM,
      visibility: 'public',
      passUser: true,
    },
    cookie,
  );
  if (app.status >= 300) throw new Error(`demo 应用创建失败: ${JSON.stringify(app.body)}`);

  // 预置普通用户（mustChangePassword=1）
  const user = await api(
    'POST',
    '/api/admin/users',
    { username: NORMAL_USERNAME, name: 'E2E 普通用户', password: NORMAL_INIT_PASSWORD },
    cookie,
  );
  if (user.status >= 300) throw new Error(`普通用户创建失败: ${JSON.stringify(user.body)}`);

  // 还原 admin 初始态：原 users 行 + 原密码哈希，清除 setup 期间产生的 TOTP/恢复码
  {
    const { __password_hash, ...userRow } = pristine;
    const cols = Object.keys(userRow);
    const assignments = cols
      .map((column, index) => `"${column.replaceAll('"', '""')}" = $${index + 1}`)
      .join(', ');
    runDatabaseQuery(
      `UPDATE users SET ${assignments} WHERE username = $${cols.length + 1}`,
      [...Object.values(userRow), 'admin'],
    );
    runDatabaseQuery(
      'DELETE FROM totp_secrets WHERE user_id = (SELECT id FROM users WHERE username = $1)',
      ['admin'],
    );
    runDatabaseQuery(
      'DELETE FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = $1)',
      ['admin'],
    );
    runDatabaseQuery(
      'UPDATE local_credentials SET password_hash = $1 WHERE user_id = (SELECT id FROM users WHERE username = $2)',
      [__password_hash, 'admin'],
    );
  }
}

export async function teardown(): Promise<void> {
  if (portal) {
    const process = portal;
    portal = null;
    if (process.exitCode === null && process.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('E2E 服务未能在 10 秒内退出')), 10_000);
        process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        process.kill('SIGTERM');
      });
    }
  }
  if (upstream) {
    const server = upstream;
    upstream = null;
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  if (fs.existsSync(SCHEMA_FILE)) {
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8').trim();
    runPg(baseDatabaseUrl(), `DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    fs.rmSync(SCHEMA_FILE);
  }
}

async function api(
  method: string,
  p: string,
  json: unknown,
  cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${PORTAL}${p}`, {
    method,
    headers: { 'content-type': 'application/json', origin: PORTAL, ...(cookie ? { cookie } : {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务未就绪: ${url}（日志: ${SERVER_LOG}）`);
}

/** 从服务端日志提取最新验证码（未配置 SMTP 的日志兜底通道） */
export function latestCodeFromLog(): string {
  const text = fs.readFileSync(SERVER_LOG, 'utf8');
  const matches = [...text.matchAll(/code=(\d{6})/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('日志中无验证码');
  return last[1]!;
}
