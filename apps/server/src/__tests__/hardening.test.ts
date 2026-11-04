/**
 * 安全加固回归（渗透测试 2026-09-14 + 代码终审 批一）：
 *  - 网关错误页 XSS：htmlError 全参数转义 + /app/:id isSlug 校验 + display_name 净化
 *  - 托管应用路径越界（../ 兄弟目录读文件）
 *  - storePackageFiles 压缩包路径逃逸
 *  - egress：IP 字面量拒绝 + 私网段判定 + DNS 失败不泄露 fetch 错误
 *  - 公开发布：应用可见性按策略控制；公开更新无需人工审核
 *  - LLM 无归因调用默认拒绝（ATTRIBUTION_REQUIRED）
 *  - 沙箱 invoked 身份环境变量可验签（M4 归因链）
 *  - admin 包上传：同名 409 不触碰既有站点目录
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { sessionCookieFor, setupTestDb, testPackage, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { loginAttempts, sessions, settings, users } from '../db/schema.js';
import { getSetting, seedSettings, setSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { appSiteDir, storePackageFiles, validateManifest, writeHtmlApp } from '../gateway/staticApp.js';
import { egressHostGate, ipInAllowCidr, isPrivateIp, parseIntranetAllowlist } from '../routes/aap.js';
import { baseEnv, identityEnv, loopbackPlatformPort, packageEntryPath } from '../lib/sandbox.js';
import { installPyDeps } from '../lib/pydeps.js';
import { handleUpgrade } from '../gateway/wsproxy.js';
import { issueCode, verifyCode } from '../lib/verification.js';
import { createSession } from '../lib/session.js';
import { signIdentity, verifyIdentity } from '../gateway/identity.js';
import { hasLeadingZeroBits } from '../lib/pow.js';
import { appendLedger, cachedBalance, createAppToken, grantTokens, precheck, recomputeBalance, settleEstimate } from '../lib/llm.js';
import { HttpError } from '../lib/httpError.js';
import { appEnvVars, apps, userGroupMembers, userGroups } from '../db/schema.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import { encryptSecret } from '../lib/cryptoSecrets.js';
import { createPlan, getAppCloneQuota } from '../lib/billing.js';

let server: Server;
let base = '';
let dir: string;
let adminCookie = '';
let ownerCookie = '';
let otherCookie = '';
let ownerId = 0;
let otherId = 0;

function zipPkg(files: Record<string, string>): Buffer {
  return testPackage(files);
}

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status}`);
  return cookieOf(res);
}

function getAppHost(
  appId: string,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }> {
  const port = new URL(base).port;
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}${requestPath}`,
      { headers: { ...headers, host: `${appId}.localhost:${port}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            headers: { get: (name) => res.headers[name.toLowerCase()]?.toString() ?? null },
            text: async () => body,
          });
        });
      },
    );
    req.on('error', reject);
  });
}

beforeAll(async () => {
  ({ dir } = await setupTestDb());
  await seedSettings();

  const cfg = { ...loadConfig({}), webDist: null };
  server = http.createServer(createApp(cfg));
  server.on('upgrade', handleUpgrade);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  // admin / owner / other 三用户
  // mfaEnabled: true——本文件用例与强制绑 MFA 门禁（forceFlowGate）无关，置位避免误拦；
  // 相应 HTTP 登录只会得到半登录态，故 admin 会话直建 full 态（见 testkit.sessionCookieFor）
  const [a] = await getDb().insert(users).values({ kind: 'local', username: 'admin', role: 'admin', mfaEnabled: true, createdAt: Date.now() }).returning({ id: users.id });
  const [o] = await getDb().insert(users).values({ kind: 'local', username: 'pkgowner', role: 'user', createdAt: Date.now() }).returning({ id: users.id });
  ownerId = Number(o!.id);
  await writeLocalCredentials(ownerId, 'owner-password');
  const [t] = await getDb().insert(users).values({ kind: 'local', username: 'other', role: 'user', createdAt: Date.now() }).returning({ id: users.id });
  otherId = t!.id;
  await writeLocalCredentials(otherId, 'other-password');

  adminCookie = await sessionCookieFor(Number(a!.id));
  ownerCookie = await login('pkgowner', 'owner-password');
  otherCookie = await login('other', 'other-password');
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
  await teardownTestDb(dir);
});

describe('错误页 XSS（P0-1/P0-2）', () => {
  it('非法应用 id 不回显（isSlug 校验，反射注入被拒）', async () => {
    const res = await fetch(`${base}/app/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/x`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).not.toContain('onerror');
  });

  it('错误页插值内容 HTML 转义（应用名含 HTML 时）', async () => {
    // 管理端建的 login 应用（匿名 → 403 分支插值 app.name）
    await getDb().insert(apps).values({
      id: 'esc-app', name: '<b>bold</b>&"q', visibility: 'login', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const res = await fetch(`${base}/app/esc-app/`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(body).not.toContain('<b>bold</b>');
    // NEW-3：模板自身的链接不被转义（对插值的转义只作用于插值本身）
    expect(body).toContain('<a href="/login">');
  });

  it('404 页插值路径正常（%% 锚点重构后）', async () => {
    const res = await fetch(`${base}/app/no-such-app-zzz/`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('未找到应用 no-such-app-zzz');
    expect(body).not.toContain('%%');
  });
});

describe('manifest.entry 越界（第二轮渗透 NEW-1）', () => {
  it('上传口：entry 含 ../ 或绝对路径直接拒绝', () => {
    for (const bad of ['../vic/mod.py', '..\\vic\\mod.py', '/etc/passwd', 'a/../../b.py']) {
      expect(() => validateManifest({ name: 'e1', type: 'python', entry: bad, runtime: 'invoked' })).toThrow(/entry/);
    }
    expect(() => validateManifest({ name: 'e1', type: 'python', entry: 'mod.py', runtime: 'invoked' })).not.toThrow();
    expect(() => validateManifest({ name: 'e1', type: 'python', entry: 'sub/mod.py', runtime: 'invoked' })).not.toThrow();
  });

  it('运行时兜底：packageEntryPath 拒绝越界解析', () => {
    expect(() => packageEntryPath('e-app', '../other/mod.py')).toThrow(/越出包目录/);
    expect(() => packageEntryPath('e-app', '..\\other\\mod.py')).toThrow(/越出包目录/);
    const ok = packageEntryPath('e-app', 'sub/mod.py');
    expect(ok.startsWith(appSiteDir('e-app'))).toBe(true);
  });
});

describe('沙箱回环平台端口（第二轮渗透 NEW-2）', () => {
  it('HTTP 口到达 → localPort；TLS 口到达 → 回落 config.port；未到达（undefined）→ config.port', () => {
    const cfg = { port: 8080, httpsPort: 8443 };
    expect(loopbackPlatformPort(8080, cfg)).toBe(8080);
    expect(loopbackPlatformPort(9910, cfg)).toBe(9910); // 测试随机端口
    expect(loopbackPlatformPort(8443, cfg)).toBe(8080); // HTTPS 到达：明文口回落
    expect(loopbackPlatformPort(undefined, cfg)).toBe(8080);
  });
});

describe('display_name 净化（回归）', () => {
  it('剥 HTML 敏感字符 + 限长', () => {
    const m = validateManifest({ name: 'dn-app', type: 'html', display_name: `<img src=x onerror=alert(1)>${'长'.repeat(60)}` });
    expect(m.displayName).not.toMatch(/[<>"'`]/);
    expect(m.displayName.length).toBeLessThanOrEqual(64);
  });
});

describe('托管应用路径越界（P1-4）', () => {
  it('旧 raw 通道越界请求不会跨应用读取文件', async () => {
    writeHtmlApp('trav-a', '<h1>trav-a</h1>');
    fs.mkdirSync(appSiteDir('trav-b'), { recursive: true });
    fs.writeFileSync(path.join(appSiteDir('trav-b'), 'secret.html'), 'TOPSECRET');
    await getDb().insert(apps).values({
      id: 'trav-a', name: 'TravA', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const res = await fetch(`${base}/app/trav-a/raw/..%2Ftrav-b%2Fsecret.html`, { redirect: 'manual' });
    expect(res.status).not.toBe(307);
    expect(await res.text()).not.toContain('TOPSECRET');
  });

  it('独立应用 origin 对越界路径直接拒绝', async () => {
    const res = await getAppHost('trav-a', '/..%2Ftrav-b%2Fsecret.html');
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain('TOPSECRET');
  });
});

describe('用户应用本地路径沙箱', () => {
  it('旧 iframe 路径直接显示沙箱外壳；应用内容不直出门户源', async () => {
    writeHtmlApp('sbx-app', '<h1 id="m">SBX-MARKER</h1><a href="/page2">inner</a>');
    await getDb().insert(apps).values({
      id: 'sbx-app', name: 'Sbx', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const entry = await fetch(`${base}/app/sbx-app/`, { redirect: 'manual' });
    expect(entry.status).toBe(200);
    const shell = await entry.text();
    expect(shell).toContain('<iframe data-aap-app-frame sandbox=');
    expect(shell).not.toContain('SBX-MARKER');

    const appPage = await getAppHost('sbx-app', '/');
    expect(appPage.status).toBe(200);
    const html = await appPage.text();
    expect(html).toContain('SBX-MARKER');
    expect(html).not.toContain('/portal-chrome.js');
    expect(html).not.toContain('iframe sandbox');
  });

  it('压缩包条目路径逃逸被拒（不写出 appsites 根）', () => {
    // 旧实现的 dest = path.join(dir, '../x') 会落到 data/ 下；新实现必须跳过该条目
    const escapedFile = path.join(path.dirname(path.dirname(appSiteDir('x'))), 'hardening-escape-marker.txt');
    fs.rmSync(escapedFile, { force: true });
    const buf = zipPkg({ '../hardening-escape-marker.txt': 'x' });
    // 无 manifest.json 会抛错，但逃逸条目必须先被过滤
    expect(() => storePackageFiles('escape-probe', buf)).toThrow();
    expect(fs.existsSync(escapedFile)).toBe(false);
  });
});

describe('egress 出站代理（P0-3）', () => {
  it('IP 字面量直连一律拒绝', async () => {
    const token = await createAppToken('eg-app1', 'egress-test', null);
    const res = await fetch(`${base}/api/aap/egress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aap-token': token },
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/api/health' }),
    });
    expect(res.status).toBe(403);
  });

  it('私网/保留段判定（含 v4 映射、ULA、链路本地、CGNAT）', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '114.114.114.114', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('白名单外域名拒绝；白名单内但 DNS 失败 → 拦截且不泄露 fetch 错误', async () => {
    const token = await createAppToken('eg-app2', 'egress-test', null);
    await getDb().insert(apps).values({
      id: 'eg-app2', name: 'EG2', visibility: 'private', kind: 'package', upstream: '',
      manifestJson: JSON.stringify({ capabilities: [], network: ['definitely-not-a-real-host.test'] }),
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const outside = await fetch(`${base}/api/aap/egress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aap-token': token },
      body: JSON.stringify({ url: 'http://example.com/' }),
    });
    expect(outside.status).toBe(403);

    const dnsFail = await fetch(`${base}/api/aap/egress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aap-token': token },
      body: JSON.stringify({ url: 'http://definitely-not-a-real-host.test/' }),
    });
    const body = (await dnsFail.json()) as { error?: { code?: string; message?: string } };
    expect(dnsFail.status).toBe(403);
    expect(body.error?.code).toBe('EGRESS_DENIED');
    expect(body.error?.message ?? '').not.toContain('fetch failed');
  });
});

describe('公开可见性与发布', () => {
  it('管理员可以设置分组的公开发布积分基准', async () => {
    const create = await fetch(`${base}/api/admin/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ name: 'admin-reward-group', note: 'test', appPublishRewardPoints: 17 }),
    });
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: number };
    const listed = await fetch(`${base}/api/admin/groups`, { headers: { cookie: adminCookie } });
    expect(((await listed.json()) as { groups: Array<{ id: number; appPublishRewardPoints: number }> }).groups)
      .toContainEqual(expect.objectContaining({ id, appPublishRewardPoints: 17 }));

    const invalid = await fetch(`${base}/api/admin/groups/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ appPublishRewardPoints: 1.5 }),
    });
    expect(invalid.status).toBe(400);

    const update = await fetch(`${base}/api/admin/groups/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ appPublishRewardPoints: 19 }),
    });
    expect(update.status).toBe(200);
  });

  it('删除托管应用：要求步升认证且仅归属者可删', async () => {
    writeHtmlApp('delete-owned-app', '<h1>DELETE-ME</h1>');
    await getDb().insert(apps).values({
      id: 'delete-owned-app', name: 'Delete me', visibility: 'private', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });

    let staleToken = '';
    await createSession({ cookie: (_name: string, value: string) => { staleToken = value; } } as never, { id: ownerId }, { grantStepUp: false });
    const stale = await fetch(`${base}/api/apps/delete-owned-app`, {
      method: 'DELETE',
      headers: { origin: base, cookie: `aap_sid=${staleToken}` },
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });

    const other = await fetch(`${base}/api/apps/delete-owned-app`, {
      method: 'DELETE',
      headers: { origin: base, cookie: otherCookie },
    });
    expect(other.status).toBe(403);

    const owner = await fetch(`${base}/api/apps/delete-owned-app`, {
      method: 'DELETE',
      headers: { origin: base, cookie: ownerCookie },
    });
    expect(owner.status).toBe(200);
    expect((await getDb().select().from(apps).where(eq(apps.id, 'delete-owned-app')))[0]).toBeUndefined();
    expect(fs.existsSync(appSiteDir('delete-owned-app'))).toBe(false);
  });

  it('首次公开应用按所属分组奖励积分，删除时最多扣至零且不重复奖励', async () => {
    const [group] = await getDb()
      .insert(userGroups)
      .values({
        name: 'publish-reward-test',
        note: '',
        appPublishRewardPoints: 11,
        createdAt: Date.now(),
      })
      .returning({ id: userGroups.id });
    await getDb().insert(userGroupMembers).values({
      groupId: group!.id,
      userId: ownerId,
      createdAt: Date.now(),
    });
    await getDb().update(users).set({ pointsBalance: 0 }).where(eq(users.id, ownerId));
    writeHtmlApp('reward-points-app', '<h1>Reward</h1>');
    await getDb().insert(apps).values({
      id: 'reward-points-app',
      name: 'Reward',
      visibility: 'private',
      kind: 'html',
      upstream: '',
      ownerUserId: ownerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const publish = (nextVisibility: string) =>
      fetch(`${base}/api/apps/reward-points-app/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
        body: JSON.stringify({ visibility: nextVisibility }),
      });
    const updateSettings = (nextVisibility: string) =>
      fetch(`${base}/api/apps/reward-points-app/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
        body: JSON.stringify({ name: 'Reward', description: '', visibility: nextVisibility }),
      });
    const firstPublish = await updateSettings('public');
    expect(firstPublish.status).toBe(200);
    expect(await firstPublish.json()).toMatchObject({ pointsAwarded: 11 });
    expect((await getDb().select().from(apps).where(eq(apps.id, 'reward-points-app')))[0]?.publicationRewardPoints).toBe(11);
    expect((await getDb().select().from(users).where(eq(users.id, ownerId)))[0]?.pointsBalance).toBe(11);

    const repeatedPublish = await publish('public');
    expect(await repeatedPublish.json()).toMatchObject({ pointsAwarded: 0 });
    await updateSettings('private');
    const republish = await publish('public');
    expect(await republish.json()).toMatchObject({ pointsAwarded: 0 });
    expect((await getDb().select().from(users).where(eq(users.id, ownerId)))[0]?.pointsBalance).toBe(11);

    await getDb().update(users).set({ pointsBalance: 3 }).where(eq(users.id, ownerId));
    const remove = await fetch(`${base}/api/apps/reward-points-app`, {
      method: 'DELETE',
      headers: { origin: base, cookie: ownerCookie },
    });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toMatchObject({ pointsDeducted: 3 });
    expect((await getDb().select().from(users).where(eq(users.id, ownerId)))[0]?.pointsBalance).toBe(0);
  });

  it('公开应用不受历史审核状态影响', async () => {
    writeHtmlApp('rev-app', '<h1>REV</h1>');
    await getDb().insert(apps).values({
      id: 'rev-app', name: 'Rev', visibility: 'public', kind: 'html', upstream: '',
      reviewStatus: 'approved', ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect((await getAppHost('rev-app', '/', { cookie: otherCookie })).status).toBe(200);

    await getDb().update(apps).set({ reviewStatus: 'pending' }).where(eq(apps.id, 'rev-app'));
    expect((await getAppHost('rev-app', '/', { cookie: otherCookie })).status).toBe(200);
    expect((await getAppHost('rev-app', '/')).status).toBe(200);
    expect((await getAppHost('rev-app', '/', { cookie: ownerCookie })).status).toBe(200);

    expect((await fetch(`${base}/api/apps/rev-app/meta`, { headers: { cookie: otherCookie } })).status).toBe(200);
  });

  it('已公开应用更新后保持在线，无需管理员审核', async () => {
    writeHtmlApp('rev-app', '<h1>REV</h1>');
    const app = (await getDb().select().from(apps).where(eq(apps.id, 'rev-app')))[0];
    if (app) {
      await getDb().update(apps).set({ ownerUserId: ownerId, visibility: 'public', enabled: true }).where(eq(apps.id, 'rev-app'));
    } else {
      await getDb().insert(apps).values({
        id: 'rev-app', name: 'Rev', visibility: 'public', kind: 'html', upstream: '', ownerUserId: ownerId,
        reviewStatus: 'approved', createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
    const res = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
      body: JSON.stringify({
        filename: 'pkg.awpk',
        dataBase64: zipPkg({
          'manifest.json': JSON.stringify({
            name: 'rev-app',
            display_name: 'Rev',
            type: 'html',
            version: '2.0.0',
          }),
          'index.html': '<h1>v2</h1>',
        }).toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    const row = (await getDb().select().from(apps).where(eq(apps.id, 'rev-app')))[0];
    expect(row?.enabled).toBe(true);
    expect(row?.visibility).toBe('public');
    const mineResponse = await fetch(`${base}/api/apps/mine`, { headers: { cookie: ownerCookie } });
    const mineBody = (await mineResponse.json()) as {
      apps: Array<{
        id: string;
        kind: string;
        name: string;
        description: string;
        icon: string | null;
        category: string;
        visibility: string;
        status: string;
        sort: number;
        accessible: boolean;
        enabled: boolean;
      }>;
    };
    expect(mineBody.apps.find((item) => item.id === 'rev-app')).toMatchObject({
      id: 'rev-app',
      kind: 'html',
      name: 'Rev',
      description: expect.any(String),
      icon: null,
      category: expect.any(String),
      visibility: 'public',
      status: expect.any(String),
      sort: expect.any(Number),
      accessible: true,
      enabled: true,
    });
    const sharedResponse = await fetch(`${base}/api/apps/shared`, { headers: { cookie: otherCookie } });
    expect(sharedResponse.status).toBe(200);
    const sharedBody = (await sharedResponse.json()) as { apps: Array<{ id: string }> };
    expect(sharedBody.apps.some((item) => item.id === 'rev-app')).toBe(true);

    const loginVisibility = await fetch(`${base}/api/apps/rev-app/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
      body: JSON.stringify({ visibility: 'login' }),
    });
    expect(loginVisibility.status).toBe(200);
    expect(await loginVisibility.json()).toMatchObject({ visibility: 'login' });
    const sharedLoginResponse = await fetch(`${base}/api/apps/shared`, { headers: { cookie: otherCookie } });
    expect(((await sharedLoginResponse.json()) as { apps: Array<{ id: string }> }).apps.some((item) => item.id === 'rev-app')).toBe(false);
    const siteSharedResponse = await fetch(`${base}/api/apps/site-shared`, { headers: { cookie: otherCookie } });
    expect(((await siteSharedResponse.json()) as { apps: Array<{ id: string }> }).apps.some((item) => item.id === 'rev-app')).toBe(true);
    expect((await getAppHost('rev-app', '/', { cookie: otherCookie })).status).toBe(403);

    const privateVisibility = await fetch(`${base}/api/apps/rev-app/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(privateVisibility.status).toBe(200);
    expect(await privateVisibility.json()).toMatchObject({ visibility: 'private' });
    const sharedPrivateResponse = await fetch(`${base}/api/apps/shared`, { headers: { cookie: otherCookie } });
    expect(((await sharedPrivateResponse.json()) as { apps: Array<{ id: string }> }).apps.some((item) => item.id === 'rev-app')).toBe(false);

    const invalidVisibility = await fetch(`${base}/api/apps/rev-app/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
      body: JSON.stringify({ visibility: 'unsupported' }),
    });
    expect(invalidVisibility.status).toBe(400);
    const restorePublic = await fetch(`${base}/api/apps/rev-app/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(restorePublic.status).toBe(200);
    expect((await getAppHost('rev-app', '/')).status).toBe(200);
  });

  it('站内共享只可克隆；复制环境变量、固定私有范围，删除后归还名额', async () => {
    const now = Date.now();
    const [group] = await getDb().insert(userGroups).values({
      name: '站内克隆权益组',
      createdAt: now,
    }).returning({ id: userGroups.id });
    const planId = await createPlan({
      name: '站内克隆测试权益',
      groupId: group!.id,
      durationDays: 30,
      appCloneLimit: 1,
    });
    await getDb().update(users).set({
      membershipPlanId: planId,
      membershipExpiresAt: now + 30 * 86_400_000,
    }).where(eq(users.id, otherId));

    fs.mkdirSync(appSiteDir('clone-source-test'), { recursive: true });
    fs.writeFileSync(path.join(appSiteDir('clone-source-test'), 'manifest.json'), JSON.stringify({
      name: 'clone-source-test',
      displayName: '站内源应用',
      type: 'html',
      version: '1.0.0',
    }));
    fs.writeFileSync(path.join(appSiteDir('clone-source-test'), 'index.html'), '<h1>source</h1>');
    fs.mkdirSync(path.join(appSiteDir('clone-source-test'), 'storage'), { recursive: true });
    fs.writeFileSync(path.join(appSiteDir('clone-source-test'), 'storage', 'private.txt'), 'not cloned');
    await getDb().insert(apps).values({
      id: 'clone-source-test',
      name: '站内源应用',
      visibility: 'login',
      kind: 'html',
      upstream: '',
      ownerUserId: ownerId,
      manifestJson: JSON.stringify({ name: 'clone-source-test', displayName: '站内源应用', type: 'html', version: '1.0.0' }),
      createdAt: now,
      updatedAt: now,
    });
    const [secret] = await getDb().insert(appEnvVars).values({
      appId: 'clone-source-test',
      name: 'SOURCE_SECRET',
      valueEnc: encryptSecret('copied-secret'),
      isSecret: true,
      updatedAt: now,
    }).returning({ valueEnc: appEnvVars.valueEnc });

    const clone = async (): Promise<{ status: number; id?: string }> => {
      const response = await fetch(`${base}/api/apps/clone-source-test/clone`, {
        method: 'POST',
        headers: { origin: base, cookie: otherCookie },
      });
      return { status: response.status, ...(response.status === 201 ? await response.json() as { id: string } : {}) };
    };
    const first = await clone();
    expect(first.status).toBe(201);
    const cloneId = first.id!;
    const cloneRow = (await getDb().select().from(apps).where(eq(apps.id, cloneId)))[0];
    expect(cloneRow).toMatchObject({
      ownerUserId: otherId,
      clonedFromAppId: 'clone-source-test',
      visibility: 'private',
    });
    expect((await getDb().select().from(appEnvVars).where(eq(appEnvVars.appId, cloneId)))[0]?.valueEnc).toBe(secret!.valueEnc);
    expect(fs.existsSync(path.join(appSiteDir(cloneId), 'storage', 'private.txt'))).toBe(false);
    expect((await getAppHost('clone-source-test', '/', { cookie: otherCookie })).status).toBe(403);
    expect((await getAppHost(cloneId, '/', { cookie: otherCookie })).status).toBe(200);
    expect(await getAppCloneQuota(otherId)).toEqual({ limit: 1, used: 1, remaining: 0 });
    const mine = await fetch(`${base}/api/apps/mine`, { headers: { cookie: otherCookie } });
    expect(mine.status).toBe(200);
    expect((await mine.json() as { apps: Array<{ id: string; isClone: boolean }> }).apps)
      .toContainEqual(expect.objectContaining({ id: cloneId, isClone: true }));

    const changeVisibility = await fetch(`${base}/api/apps/${cloneId}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: otherCookie },
      body: JSON.stringify({ name: '尝试公开克隆', description: '', visibility: 'public' }),
    });
    expect(changeVisibility.status).toBe(403);
    expect((await clone()).status).toBe(403);

    const stepUpCookie = await sessionCookieFor(otherId);
    const remove = await fetch(`${base}/api/apps/${cloneId}`, {
      method: 'DELETE',
      headers: { origin: base, cookie: stepUpCookie },
    });
    expect(remove.status).toBe(200);
    expect(await getAppCloneQuota(otherId)).toEqual({ limit: 1, used: 0, remaining: 1 });
    const afterDelete = await clone();
    expect(afterDelete.status).toBe(201);
    const removeAgain = await fetch(`${base}/api/apps/${afterDelete.id}`, {
      method: 'DELETE',
      headers: { origin: base, cookie: stepUpCookie },
    });
    expect(removeAgain.status).toBe(200);
    fs.rmSync(appSiteDir('clone-source-test'), { recursive: true, force: true });
  });
});

describe('LLM 归因强制（P1-5）', () => {
  it('无归因调用默认拒绝（ATTRIBUTION_REQUIRED）；allow 档放行', async () => {
    try {
      await precheck(null, 100);
      expect.unreachable('precheck 应拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).code).toBe('ATTRIBUTION_REQUIRED');
    }
    await setSetting('LLM_UNATTRIBUTED_POLICY', 'allow');
    await expect(precheck(null, 100)).resolves.toBeUndefined();
    await setSetting('LLM_UNATTRIBUTED_POLICY', 'reject');
  });

  it('invoked 身份环境变量：平台签名可验签且 uid 正确（M4 归因链）', async () => {
    const env = await identityEnv('some-app', ownerId);
    expect(env.AAP_IDENTITY_PAYLOAD).toBeTruthy();
    const secret = getSetting('AAP_SIGN_SECRET')!;
    const v = verifyIdentity(env.AAP_IDENTITY_PAYLOAD!, env.AAP_IDENTITY_SIG!, secret, 'some-app');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.uid).toBe(String(ownerId));
    expect((await identityEnv('some-app', null)).AAP_IDENTITY_PAYLOAD).toBeUndefined();
  });
});

describe('passUser 沙箱 env 注入 AAP_SIGN_SECRET', () => {
  async function insertApp(id: string, passUser: boolean): Promise<void> {
    await getDb().insert(apps).values({
      id, name: id, visibility: 'private', kind: 'package', upstream: '',
      ownerUserId: ownerId, passUser, createdAt: Date.now(), updatedAt: Date.now(),
    });
  }

  it('passUser 开启 → env 携带 AAP_SIGN_SECRET 且与平台设置一致；关闭 → 不注入', async () => {
    await insertApp('env-pu-on', true);
    await insertApp('env-pu-off', false);
    expect((await baseEnv('env-pu-on')).AAP_SIGN_SECRET).toBe(getSetting('AAP_SIGN_SECRET'));
    expect((await baseEnv('env-pu-off')).AAP_SIGN_SECRET).toBeUndefined();
  });

  it('管理端应用列表返回完整字段与 signSecret（仅 admin 路由可达）', async () => {
    await getDb().insert(apps).values({
      id: 'admin-list-shape',
      name: '管理列表回归应用',
      description: '确保管理列表字段完整',
      visibility: 'login',
      kind: 'upstream',
      upstream: 'http://127.0.0.1:8080',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    try {
      const res = await fetch(`${base}/api/admin/apps`, { headers: { cookie: adminCookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        signSecret?: string;
        apps: Array<{ id: string; name: string; description: string; upstream: string }>;
      };
      expect(body.signSecret).toBe(getSetting('AAP_SIGN_SECRET'));
      expect(body.apps.find((app) => app.id === 'admin-list-shape')).toMatchObject({
        id: 'admin-list-shape',
        name: '管理列表回归应用',
        description: '确保管理列表字段完整',
        upstream: 'http://127.0.0.1:8080',
      });
    } finally {
      await getDb().delete(apps).where(eq(apps.id, 'admin-list-shape'));
    }
  });

  it('运营面板订单与卡券码列表返回已解析的数组', async () => {
    const [orders, codes] = await Promise.all([
      fetch(`${base}/api/admin/billing/orders?status=pending`, { headers: { cookie: adminCookie } }),
      fetch(`${base}/api/admin/redeem/codes?limit=1`, { headers: { cookie: adminCookie } }),
    ]);

    expect(orders.status).toBe(200);
    expect(codes.status).toBe(200);
    expect(Array.isArray(((await orders.json()) as { orders: unknown }).orders)).toBe(true);
    expect(Array.isArray(((await codes.json()) as { codes: unknown }).codes)).toBe(true);
  });

  it('PUT 切换 passUser 即时生效且不报错（persistent 停起路径）', async () => {
    const res = await fetch(`${base}/api/admin/apps/env-pu-on`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ passUser: false }),
    });
    expect(res.status).toBe(200);
    expect((await baseEnv('env-pu-on')).AAP_SIGN_SECRET).toBeUndefined();
    await getDb().delete(apps).where(eq(apps.id, 'env-pu-on'));
    await getDb().delete(apps).where(eq(apps.id, 'env-pu-off'));
  });
});

describe('python 包声明制依赖（skill v0.2.6）', () => {
  const savedBin = process.env.PYTHON_BIN;
  let stubOut = '';

  function writeStub(extra = ''): string {
    const stubBin = path.join(dir, `stub-py-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(stubBin, `#!/bin/sh\necho "$@" > '${stubOut}'\n${extra}`);
    fs.chmodSync(stubBin, 0o755);
    return stubBin;
  }

  afterAll(() => {
    if (savedBin === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = savedBin;
  });

  it('manifest.requirements 解析：合法条目通过并去重；URL/本地路径/超限拒绝；仅 python 包支持', () => {
    const m = (requirements: unknown, type = 'python') => validateManifest({ name: 'rq-x', type, entry: 'mod.py', requirements });
    expect(m(['flask>=3.0', 'requests==2.32.3', 'PyYAML', 'flask>=3.0']).requirements).toEqual([
      'flask>=3.0',
      'requests==2.32.3',
      'PyYAML',
    ]);
    expect(() => m(['git+https://github.com/x/y'])).toThrow(/非法/);
    expect(() => m(['-r other.txt'])).toThrow(/非法/);
    expect(() => m(['/tmp/evil'])).toThrow(/非法/);
    expect(() => m(Array.from({ length: 33 }, (_, i) => `pkg${i}`))).toThrow(/最多/);
    expect(() => m(['flask'], 'html')).toThrow(/仅 python/);
  });

  it('installPyDeps：按声明调 pip（--target .deps / -r）；失败抛 400 带尾部 stderr；空声明清 .deps 不再调 pip', async () => {
    stubOut = path.join(dir, 'stub-cmds.txt');
    process.env.PYTHON_BIN = writeStub();
    await installPyDeps('deps-app', ['flask>=3.0']);
    const args = fs.readFileSync(stubOut, 'utf8');
    expect(args).toContain('--only-binary=:all:');
    expect(args).toContain(path.join(appSiteDir('deps-app'), '.deps'));
    expect(args).toContain('.deps-requirements.txt');

    process.env.PYTHON_BIN = writeStub('echo pip boom >&2\necho resolver boom\nexit 1\n');
    await expect(installPyDeps('deps-app', ['flask'])).rejects.toMatchObject({
      status: 400,
      code: 'PIP_INSTALL_FAILED',
      message: expect.stringContaining('resolver boom'),
    });

    fs.mkdirSync(path.join(appSiteDir('deps-app'), '.deps'), { recursive: true });
    const callsBefore = fs.existsSync(stubOut) ? fs.readFileSync(stubOut, 'utf8') : '';
    await installPyDeps('deps-app', []);
    expect(fs.existsSync(path.join(appSiteDir('deps-app'), '.deps'))).toBe(false);
    expect(fs.readFileSync(stubOut, 'utf8')).toBe(callsBefore);
  });

  it('baseEnv：PYTHONPATH 前置 AAP_PREINSTALLED_PYTHONPATH 且含 .deps', async () => {
    process.env.PYTHON_BIN = savedBin;
    process.env.AAP_PREINSTALLED_PYTHONPATH = '/opt/py-libs';
    try {
      const p = (await baseEnv('env-pu-on')).PYTHONPATH ?? '';
      expect(p.startsWith('/opt/py-libs:')).toBe(true);
      expect(p.endsWith(path.join(appSiteDir('env-pu-on'), '.deps'))).toBe(true);
    } finally {
      delete process.env.AAP_PREINSTALLED_PYTHONPATH;
    }
  });

  it('上传带 requirements 的包：接入时自动安装到应用 .deps', async () => {
    stubOut = path.join(dir, 'stub-cmds-upload.txt');
    process.env.PYTHON_BIN = writeStub();
    const res = await fetch(`${base}/api/admin/apps/package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({
        filename: 'deps.awpk',
        dataBase64: zipPkg({
          'manifest.json': JSON.stringify({
            name: 'deps-app-up', display_name: 'Deps', type: 'python', entry: 'mod.py', runtime: 'invoked',
            requirements: ['flask>=3.0'],
          }),
          'mod.py': 'def handle(input, aap):\n    return {"ok": True}\n',
        }).toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    const args = fs.readFileSync(stubOut, 'utf8');
    expect(args).toContain(path.join(appSiteDir('deps-app-up'), '.deps'));
    await getDb().delete(apps).where(eq(apps.id, 'deps-app-up'));
    fs.rmSync(appSiteDir('deps-app-up'), { recursive: true, force: true });
  });
});

describe('admin 包上传顺序（P3-14）', () => {
  it('同名 409：既有站点目录不被触碰，临时目录清理', async () => {
    writeHtmlApp('exist-up', '<h1>ORIGINAL-MARKER</h1>');
    await getDb().insert(apps).values({
      id: 'exist-up', name: 'ExistUp', visibility: 'private', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const res = await fetch(`${base}/api/admin/apps/package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({
        filename: 'pkg.awpk',
        dataBase64: zipPkg({ 'manifest.json': JSON.stringify({ name: 'exist-up', display_name: 'Dup', type: 'html' }), 'index.html': '<h1>NEW</h1>' }).toString('base64'),
      }),
    });
    expect(res.status).toBe(409);
    const marker = fs.readFileSync(path.join(appSiteDir('exist-up'), 'index.html'), 'utf8');
    expect(marker).toContain('ORIGINAL-MARKER');
    // 临时目录已被清理（唯一命名前缀）
    const dataRoot = path.dirname(appSiteDir('x'));
    const leftovers = fs.readdirSync(dataRoot).filter((n) => n.startsWith('upload_tmp_'));
    expect(leftovers).toHaveLength(0);
  });
});

// ---------- 批二：纵深 ----------

async function solvePow(): Promise<string> {
  const chRes = await fetch(`${base}/api/auth/pow`, { method: 'POST' });
  const { challenge } = (await chRes.json()) as { challenge: { challengeId: string; seed: string; difficulty: number } };
  let nonce = 0;
  for (;; nonce++) {
    const h = createHash('sha256').update(`${challenge.seed}:${nonce}`).digest('hex');
    if (hasLeadingZeroBits(h, challenge.difficulty)) break;
  }
  const vRes = await fetch(`${base}/api/auth/pow/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.challengeId, nonce: String(nonce) }),
  });
  return ((await vRes.json()) as { token: string }).token;
}

async function rawSessionCookie(userId: number, stepUp: number | null): Promise<string> {
  const token = `rawtok-${createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  await getDb().insert(sessions).values({
    tokenHash,
    userId,
    authState: 'full',
    stepUpUntil: stepUp,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 3600_000,
    userAgent: 'test',
  }).onConflictDoUpdate({ target: sessions.tokenHash, set: { userId, stepUpUntil: stepUp, createdAt: now, lastSeenAt: now, expiresAt: now + 3600_000 } });
  return `aap_sid=${token}`;
}

describe('MFA 绑定步升（P2-9）', () => {
  it('登录即授予步升窗口：enroll 立即可用（强制绑 MFA 流程不卡）', async () => {
    const cookie = await login('other', 'other-password');
    const res = await fetch(`${base}/api/auth/mfa/totp/enroll`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret?: string };
    expect(body.secret).toBeTruthy();
  });

  it('无步升窗口的陈旧会话：enroll/confirm 403 STEP_UP_REQUIRED（防劫持会话绑新因子）', async () => {
    const otherRow = (await getDb().select().from(users).where(eq(users.username, 'other')))[0];
    const cookie = await rawSessionCookie(otherRow!.id, null);
    const res = await fetch(`${base}/api/auth/mfa/totp/enroll`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('admin redeem 显式守卫（P2-10）', () => {
  it('非管理员 403（不再依赖挂载顺序偶然保护）；管理员可建批次', async () => {
    const denied = await fetch(`${base}/api/admin/redeem/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: otherCookie },
      body: JSON.stringify({ kind: 'tokens', count: 1, tokens: 100 }),
    });
    expect(denied.status).toBe(403);

    const ok = await fetch(`${base}/api/admin/redeem/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ kind: 'tokens', count: 1, tokens: 100 }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('HTTPS 跳转 Host 白名单（P2-11）', () => {
  function get(host: string): Promise<string | number | null> {
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: '/', headers: { host } }, (res) => {
        void res.resume();
        resolve(res.statusCode === 302 ? (res.headers.location ?? null) : (res.statusCode ?? 0));
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  it('非配置域名不反射：跳到 ACME_DOMAIN；命中域名正常跳转', async () => {
    await setSetting('HTTPS_REDIRECT', 'true');
    await setSetting('ACME_DOMAIN', 'regtest.example.com');
    try {
      expect(await get('evil.example.com')).toBe('https://regtest.example.com/');
      expect(await get('regtest.example.com')).toBe('https://regtest.example.com/');
    } finally {
      await setSetting('HTTPS_REDIRECT', 'false');
      await setSetting('ACME_DOMAIN', '');
    }
  });

  it('loopback Host 豁免：平台内部调用（沙箱 egress/LLM、健康检查）不被 302——否则 302 会让 urllib 把 POST 降级为 GET 打挂沙箱出站（ip-analyzer 实测）', async () => {
    await setSetting('HTTPS_REDIRECT', 'true');
    await setSetting('ACME_DOMAIN', 'regtest.example.com');
    try {
      for (const host of ['127.0.0.1', 'localhost']) {
        const r = await get(host);
        expect(`${host}:${String(r)}`).not.toContain(':302');
        expect(String(r)).not.toContain('https://');
      }
    } finally {
      await setSetting('HTTPS_REDIRECT', 'false');
      await setSetting('ACME_DOMAIN', '');
    }
  });
});

describe('身份头验签（P3-16：exp 强制 + jti 一次性）', () => {
  it('重放拒绝；allowReplay 豁免（平台内部归因）；exp 过期拒绝；缺 exp 拒绝', () => {
    const secret = getSetting('AAP_SIGN_SECRET')!;
    const su = {
      id: ownerId, kind: 'local' as const, subject: 'local:pkgowner', username: 'pkgowner', email: null,
      phone: null, name: 'pkgowner', role: 'user' as const, status: 'active', sessionId: 't',
      authState: 'full' as const, stepUpUntil: null, plan: 'free' as const, mfaEnabled: false,
      mustChangePassword: false, membershipSelectionRequired: false,
    };
    const idn = signIdentity(su, 'aud-app')!;
    expect(verifyIdentity(idn.payload, idn.sig, secret, 'aud-app').ok).toBe(true);
    // 同一身份头二次使用 → 重放拒绝
    const replay = verifyIdentity(idn.payload, idn.sig, secret, 'aud-app');
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toBe('JTI_REPLAYED');
    // 平台内部归因（沙箱一次运行多次调用同一身份）→ 豁免
    expect(verifyIdentity(idn.payload, idn.sig, secret, 'aud-app', { allowReplay: true }).ok).toBe(true);

    // exp 必须存在且未过期：篡改过期 payload（重新签名）→ EXPIRED
    const parsed = JSON.parse(Buffer.from(idn.payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    parsed.exp = Date.now() - 1000;
    delete parsed.jti;
    const payloadB64 = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    const sig = createHmac('sha256', secret).update(payloadB64).digest('hex');
    const expired = verifyIdentity(payloadB64, sig, secret, 'aud-app');
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error).toBe('EXPIRED');
  });
});

describe('用户角色管理（指定/取消管理员）', () => {
  it('可设为/取消管理员；不能改自己的角色；最后一名管理员不可降级', async () => {
    const [a] = await getDb().insert(users).values({ kind: 'local', username: 'roleu1', role: 'user', createdAt: Date.now() }).returning({ id: users.id });
    const uid = Number(a!.id);
    const put = (id: number, json: Record<string, unknown>): Promise<{ status: number; body: { error?: { code?: string } } }> =>
      fetch(`${base}/api/admin/users/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
        body: JSON.stringify(json),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: { code?: string } } }));

    // 设为管理员
    expect((await put(uid, { role: 'admin' })).status).toBe(200);
    expect(await (await getDb().select().from(users).where(eq(users.id, uid)))[0]?.role).toBe('admin');

    // 改自己的角色 → 400（防自锁；adminCookie 对应 admin 账号）。
    // 注：LAST_ADMIN（至少保留一名管理员）为并发竞态纵深防御——API 路径上
    // 操作者必是管理员，单人管理员的降级必然是改自己而先被防自锁拦截。
    const adminId = await (await getDb().select().from(users).where(eq(users.username, 'admin')))[0]!.id;
    const self = await put(adminId, { role: 'user' });
    expect(self.status).toBe(400);
    expect(self.body.error?.code).toBe('CANNOT_MODIFY_SELF_ROLE');

    // 正常取消（此时有两名管理员）
    expect((await put(uid, { role: 'user' })).status).toBe(200);
    expect(await (await getDb().select().from(users).where(eq(users.id, uid)))[0]?.role).toBe('user');

    // 非法角色值 → 400
    expect((await put(uid, { role: 'root' })).status).toBe(400);
  });
});

describe('HTML 页面内容编辑（编辑弹窗数据面）', () => {
  it('GET 读取当前页面；PUT 更新落盘保存即生效；空内容 400；非 html 应用 400', async () => {
    writeHtmlApp('edit-html', '<h1>V1</h1>');
    await getDb().insert(apps).values({
      id: 'edit-html', name: 'EditHtml', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const read = await fetch(`${base}/api/admin/apps/edit-html/html`, { headers: { cookie: adminCookie } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { html: string }).html).toContain('V1');

    const put = await fetch(`${base}/api/admin/apps/edit-html`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ html: '<h1>V2-EDITED</h1>' }),
    });
    expect(put.status).toBe(200);
    const file = await getAppHost('edit-html', '/', { cookie: ownerCookie });
    expect(await file.text()).toContain('V2-EDITED');

    const empty = await fetch(`${base}/api/admin/apps/edit-html`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ html: '   ' }),
    });
    expect(empty.status).toBe(400);
  });
});

describe('.awpk 包预解析（上传前预览）', () => {
  function preview(dataBase64: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return fetch(`${base}/api/admin/apps/package/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'pkg.awpk', dataBase64 }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  }

  it('返回 manifest 解析结果与可信签名状态，不创建应用、不落正式目录', async () => {
    const res = await preview(
      zipPkg({
        'manifest.json': JSON.stringify({ name: 'preview-pkg', display_name: '预览包', type: 'html', version: '1.0.0', capabilities: ['llm'], network: ['example.com'] }),
        'index.html': '<h1>hi</h1>',
      }).toString('base64'),
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('preview-pkg');
    expect(res.body.displayName).toBe('预览包');
    expect(res.body.signature).toBe('verified');
    expect(res.body.exists).toBe(false);
    expect((await getDb().select().from(apps).where(eq(apps.id, 'preview-pkg')))[0]).toBeUndefined();
    const dataRoot = path.dirname(appSiteDir('x'));
    expect(fs.readdirSync(dataRoot).filter((n) => n.startsWith('preview_tmp_'))).toHaveLength(0);
  });

  it('坏包 → 400', async () => {
    const res = await preview(Buffer.from('not a zip').toString('base64'));
    expect(res.status).toBe(400);
  });
});

describe('内网出站白名单（EGRESS_INTRANET_ALLOWLIST）', () => {
  it('解析：域名/IP/CIDR 混合条目', () => {
    const a = parseIntranetAllowlist('nas.local\n192.168.1.50, 10.0.0.0/8; HTTP://svc.internal/');
    expect(a.hosts.has('nas.local')).toBe(true);
    expect(a.hosts.has('192.168.1.50')).toBe(true);
    expect(a.hosts.has('svc.internal')).toBe(true);
    expect(ipInAllowCidr('10.1.2.3', a.cidrs)).toBe(true);
    expect(ipInAllowCidr('192.168.1.3', a.cidrs)).toBe(false);
    expect(parseIntranetAllowlist('').hosts.size).toBe(0);
  });

  it('闸门：默认拒绝内网目标；白名单命中即完全放行（管理员权威高于包声明）', () => {
    const allow = parseIntranetAllowlist('nas.local, 192.168.1.0/24');
    const manifest = ['nas.local', '192.168.1.50'];
    // 无白名单：IP 字面量/内网主机名拒绝
    expect(egressHostGate('192.168.1.50', manifest, parseIntranetAllowlist('')).ok).toBe(false);
    expect(egressHostGate('nas.local', manifest, parseIntranetAllowlist('')).ok).toBe(false);
    // 白名单命中 → 放行（IP 精确/CIDR 覆盖/主机名三种形态），无需 manifest 声明
    expect(egressHostGate('192.168.1.50', manifest, allow).ok).toBe(true);
    expect(egressHostGate('192.168.1.99', [], allow).ok).toBe(true);
    expect(egressHostGate('nas.local', [], allow).ok).toBe(true);
    // 未命中：公网域名不在 manifest → 照旧拒绝
    expect(egressHostGate('example.com', ['other.com'], allow).ok).toBe(false);
    // CIDR 覆盖范围外仍按内网拒绝
    expect(egressHostGate('192.168.2.1', ['192.168.2.1'], allow).ok).toBe(false);
  });
});

describe('托管应用健康探测（批：html/package 无 upstream 不再恒「异常」）', () => {
  it('html 应用探测记 ok；persistent 未拉起记 unknown；测试按钮对托管应用返回 ok', async () => {
    await getDb().insert(apps).values({
      id: 'health-html', name: 'HtmlApp', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await getDb().insert(apps).values({
      id: 'health-sbx', name: 'SbxApp', visibility: 'private', kind: 'package', upstream: '',
      runtimeMode: 'persistent', ownerUserId: ownerId, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const { probeAll } = await import('../gateway/health.js');
    await probeAll();

    const rows = await getDb().select().from(apps);
    expect(rows.find((r) => r.id === 'health-html')?.healthState).toBe('ok');
    expect(rows.find((r) => r.id === 'health-sbx')?.healthState).toBe('unknown');

    const test = await fetch(`${base}/api/admin/apps/health-html/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    });
    expect(test.status).toBe(200);
    expect(((await test.json()) as { ok?: boolean }).ok).toBe(true);
  });
});

describe('登录 401 信息泄露收敛（P2-12）', () => {
  it('登录失败响应不含 failures/banned', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'other', password: 'definitely-wrong' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: Record<string, unknown> };
    expect(body.error && 'failures' in body.error).toBe(false);
    expect(body.error && 'banned' in body.error).toBe(false);
  });

  it('/api/health 匿名仅回 ok（version/uptime 移入 admin overview）', async () => {
    const anon = await fetch(`${base}/api/health`);
    const body = (await anon.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.version).toBeUndefined();
    expect(body.uptimeSec).toBeUndefined();

    const ov = await fetch(`${base}/api/admin/overview`, { headers: { cookie: adminCookie } });
    const ovBody = (await ov.json()) as {
      releaseVersion?: string;
      uptimeSec?: number;
      totals?: { users?: number; apps?: number; tokens30d?: number };
      resources?: {
        cpuPercent?: number | null;
        memory?: { usedBytes?: number; totalBytes?: number; percent?: number };
        network?: { available?: boolean; capacityMbps?: number };
      };
      planSubscriptions?: Array<{ planId: number; subscribers: number }>;
    };
    expect(ovBody.releaseVersion).toBeTruthy();
    expect(typeof ovBody.uptimeSec).toBe('number');
    expect(typeof ovBody.totals?.users).toBe('number');
    expect(typeof ovBody.totals?.apps).toBe('number');
    expect(typeof ovBody.totals?.tokens30d).toBe('number');
    expect(ovBody.resources?.cpuPercent === null || typeof ovBody.resources?.cpuPercent === 'number').toBe(true);
    expect(typeof ovBody.resources?.memory?.usedBytes).toBe('number');
    expect(typeof ovBody.resources?.memory?.totalBytes).toBe('number');
    expect(typeof ovBody.resources?.memory?.percent).toBe('number');
    expect(typeof ovBody.resources?.network?.available).toBe('boolean');
    expect(ovBody.resources?.network?.capacityMbps).toBe(10);
    expect(Array.isArray(ovBody.planSubscriptions)).toBe(true);
  });

  it('/api/dev/guide 匿名 401、登录可见', async () => {
    const anon = await fetch(`${base}/api/dev/guide`);
    expect(anon.status).toBe(401);
    const authed = await fetch(`${base}/api/dev/guide`, { headers: { cookie: otherCookie } });
    expect(authed.status).toBe(200);
  });

  it('技能下载：匿名可下载 .skill、.zip 和 .md 三种格式', async () => {
    for (const format of ['skill', 'zip'] as const) {
      const response = await fetch(`${base}/api/dev/guide/download?format=${format}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/zip');
      expect(response.headers.get('content-disposition')).toContain(`awpk-app-develop.${format}`);

      const archive = new AdmZip(Buffer.from(await response.arrayBuffer()));
      const skillEntry = archive.getEntry('SKILL.md');
      expect(skillEntry).toBeDefined();
      expect(skillEntry?.getData().toString('utf8').startsWith('---')).toBe(true);
    }

    const markdown = await fetch(`${base}/api/dev/guide/download?format=md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get('content-disposition')).toContain('awpk-app-develop.md');
    expect((await markdown.text()).startsWith('---')).toBe(true);
    expect((await fetch(`${base}/api/dev/guide/download?format=exe`)).status).toBe(400);
  });
});

// ---------- 批三：正确性/并发/健壮性 ----------

describe('对账在途保护（批三①）', () => {
  it('预检占用期间重算/对账保留在途扣减；结算后与账本一致', async () => {
    const uid = 7001;
    await grantTokens(uid, 1000, 'seed', 1);
    await precheck(uid, 100);
    expect(await cachedBalance(uid)).toBe(900);
    // 结算循环重算：在途 100 不被抹掉
    expect(await recomputeBalance(uid)).toBe(900);
    // 请求进行中管理员发放 → 重算仍保留在途扣减
    await grantTokens(uid, 500, 'mid-flight', 1);
    expect(await cachedBalance(uid)).toBe(1400);
    // 请求结束：实际 40，释放预估 100（补回差值 60），账本补记实际用量
    await settleEstimate(uid, 100, 40);
    expect(await cachedBalance(uid)).toBe(1460);
    await appendLedger({ kind: 'usage', delta: -40, userId: uid, appId: 't', model: 'm' });
    expect(await recomputeBalance(uid)).toBe(1460);
    expect(await cachedBalance(uid)).toBe(1460);
  });
});

describe('settings secret 加密落盘（批三③）', () => {
  it('secret 配置密文入库、读取透明解密；非 secret 项仍明文', async () => {
    await setSetting('SMTP_PASS', 'supersecret-pass');
    const raw = (await getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, 'SMTP_PASS')))[0]!;
    expect(raw.value.startsWith('enc:')).toBe(true);
    expect(raw.value).not.toContain('supersecret-pass');
    expect(getSetting('SMTP_PASS')).toBe('supersecret-pass');

    await setSetting('SITE_NAME', '明文名称站点');
    const raw2 = (await getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, 'SITE_NAME')))[0]!;
    expect(raw2.value).toBe('明文名称站点');
  });
});

describe('账号维度登录节流（批三⑤）', () => {
  it('同账号失败超阈值后：即使换正确密码也要求 PoW', async () => {
    // 清空失败计数：让阈值在本用例内从零累计（否则全局 IP 计数会提前触发 PoW，
    // 吞掉失败记录，账号维度计数不满 5）
    await getDb().delete(loginAttempts);
    const [a] = await getDb().insert(users).values({ kind: 'local', username: 'acct1', role: 'user', createdAt: Date.now() }).returning({ id: users.id });
    await writeLocalCredentials(a!.id, 'acct1-correct-pass');
    // 跨 IP 语义在单进程测试里退化为同 IP 连续失败：账号维度独立计数被验证
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${i}.1` },
        body: JSON.stringify({ username: 'acct1', password: 'wrong-pass' }),
      });
      void r;
    }
    // 账号失败已达 5 次：正确密码也被 PoW 闸门拦截（TRUST_PROXY=false 时 XFF 无效，
    // 全部落在同一 IP；此处账号维度阈值与 IP 维度同达，无法单证账号维度——
    // 直接断言 needsPow 语义）
    const { needsPow, accountFailuresInWindow } = await import('../lib/security.js');
    expect(await accountFailuresInWindow('local:acct1')).toBeGreaterThanOrEqual(5);
    expect(await needsPow('203.0.113.77', 'local:acct1')).toBe(true); // 全新 IP 也要求 PoW
    expect(await needsPow('203.0.113.77', 'local:nobody-else')).toBe(false);
    // 正确密码从全新 IP 登录 → 403 POW_REQUIRED（无 token）
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ username: 'acct1', password: 'acct1-correct-pass' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('POW_REQUIRED');
  });
});

describe('WS 握手 Origin 校验（生产评审 6.1① CSWSH）', () => {
  function upgrade(origin?: string): Promise<{ status?: number; upgraded: boolean }> {
    return new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: '/app/wsapp-origin/ws',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          ...(origin ? { Origin: origin } : {}),
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode, upgraded: true });
      });
      req.on('response', (res) => {
        res.resume();
        resolve({ status: res.statusCode, upgraded: false });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('跨站 Origin 403；同源/无 Origin（非浏览器）放行到后续门禁', async () => {
    writeHtmlApp('wsapp-origin', '<h1>ws</h1>');
    await getDb().insert(apps).values({
      id: 'wsapp-origin', name: 'WsApp', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const evil = await upgrade('https://evil.example.com');
    expect(evil.upgraded).toBe(false);
    expect(evil.status).toBe(403);
    // 通过 Origin 关后走到应用形态判断：html 应用不支持 WS → 404
    const sameOrigin = await upgrade(new URL(base).origin);
    expect(sameOrigin.status).toBe(404);
    const noOrigin = await upgrade();
    expect(noOrigin.status).toBe(404);
  });
});

describe('zip 解压上限（生产评审 6.1② zip 炸弹）', () => {
  it('条目数超 2000 整包拒绝且目录清理', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 2001; i++) zip.addFile(`d/${i}.txt`, Buffer.from('x'));
    expect(() => storePackageFiles('ziplim-entries', zip.toBuffer())).toThrow(/条目数超过上限/);
    expect(fs.existsSync(appSiteDir('ziplim-entries'))).toBe(false);
  });

  it('单条目声明解压体积超 100MB：不解压直接拒绝', () => {
    const zip = new AdmZip();
    zip.addFile('blob.bin', Buffer.alloc(101 * 1024 * 1024, 0x61));
    expect(() => storePackageFiles('ziplim-declared', zip.toBuffer())).toThrow(/解压后总大小/);
    expect(fs.existsSync(appSiteDir('ziplim-declared'))).toBe(false);
  });

  it('逐条声明合规但累计解压超限：按实际字节数兜底拒绝', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 30; i++) zip.addFile(`p/${i}.bin`, Buffer.alloc(4 * 1024 * 1024, 0x61));
    expect(() => storePackageFiles('ziplim-cumulative', zip.toBuffer())).toThrow(/解压后总大小/);
  }, 60_000);

  it('正常小包不受影响', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'ziplim-ok', type: 'html' })));
    zip.addFile('index.html', Buffer.from('<h1>ok</h1>'));
    const r = storePackageFiles('ziplim-ok', zip.toBuffer());
    expect(r.files).toBe(2);
  });
});

describe('上传限频与磁盘水位（生产评审 6.2①）', () => {
  it('数据卷水位超限时上传 503 DISK_ALMOST_FULL；恢复后正常', async () => {
    await setSetting('UPLOAD_MIN_FREE_MB', String(10 ** 9)); // 必然高于真实剩余空间
    const res = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie, origin: base },
      body: JSON.stringify({
        filename: 'w.awpk',
        dataBase64: Buffer.from(zipPkg({ 'manifest.json': JSON.stringify({ name: 'wm-app', type: 'html' }), 'index.html': '<h1>w</h1>' })).toString('base64'),
      }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('DISK_ALMOST_FULL');
    await setSetting('UPLOAD_MIN_FREE_MB', '512');
  });

  it('同用户每日第 21 次上传 429 UPLOAD_RATE_LIMITED（默认 20/天）', async () => {
    const b64 = Buffer.from(zipPkg({ 'manifest.json': JSON.stringify({ name: 'rate-app', type: 'html' }), 'index.html': '<h1>r</h1>' })).toString('base64');
    let lastStatus = 0;
    let lastCode = '';
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${base}/api/apps/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: otherCookie, origin: base },
        body: JSON.stringify({ filename: 'r.awpk', dataBase64: b64 }),
      });
      lastStatus = res.status;
      if (res.status !== 200) lastCode = ((await res.json()) as { error?: { code?: string } }).error?.code ?? '';
    }
    expect(lastStatus).toBe(429);
    expect(lastCode).toBe('UPLOAD_RATE_LIMITED');
  });
});

describe('验证码条件消费（生产评审 6.3.1 纵深）', () => {
  it('成功消费后同码复验被拒（条件 UPDATE）', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    };
    try {
      await issueCode('email', 'once-a@test.local', 'register', '127.0.0.1');
    } finally {
      console.log = orig;
    }
    const line = logs.find((l) => l.includes('once-a@test.local') && l.includes('code='));
    const code = /code=(\d{6})/.exec(line ?? '')?.[1];
    expect(code).toBeTruthy();
    expect((await verifyCode('email', 'once-a@test.local', 'register', code!)).ok).toBe(true);
    const second = await verifyCode('email', 'once-a@test.local', 'register', code!);
    expect(second.ok).toBe(false);
  });
});
