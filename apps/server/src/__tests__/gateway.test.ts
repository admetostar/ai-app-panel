/**
 * W5 应用网关集成测试：
 *  - mock 上游（HTML/JSON 回显/SSE/重定向）+ WS 回声（ws 包）
 *  - HTML 改写/<base>/猴补丁、Link/Location 改写、头过滤、身份注入验签
 *  - 访问策略三态、路径穿越、双维度限流、urlSecret（query/path 型）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { sessionCookieFor, setupTestDb, teardownTestDb } from './testkit.js';
import { getDb } from '../db/index.js';
import { seedSettings, setSetting, getSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { handleUpgrade, upgradeClientIp } from '../gateway/wsproxy.js';
import { appRuns, apps, users } from '../db/schema.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import { verifyIdentity } from '../gateway/identity.js';
import { appIconDir } from '../routes/appsRun.js';

let gw: Server; // 网关（含 upgrade）
let gwPort = 0;
let up: Server; // mock 上游
let upPort = 0;
let dir: string;
let adminCookie = '';
let appOwnerId = 0;
let appViewerId = 0;
let lastUpstreamIdentity = '';
let lastUpstreamIdentitySig = '';
const publicRunAppId = `public-run-${randomBytes(4).toString('hex')}`;

const PAGE_HTML = `<!doctype html><html><head><title>up</title></head><body>
<link rel="stylesheet" href="/assets/style.css">
<a href="/page">inner</a>
<img src="/img.png" srcset="/img@2x.png 2x">
<script src="/app.js"></script>
</body></html>`;

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

async function createAppViaAdmin(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${gwPort}/api/admin/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${gwPort}`, cookie: adminCookie },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    throw new Error(`create app failed: ${res.status} ${await res.text()}`);
  }
  if (payload.visibility === 'public') {
    await getDb().update(apps).set({
      anonymousAccess: 'write',
      anonymousAccessPolicy: 'legacy',
    }).where(eq(apps.id, String(payload.id)));
  }
}

beforeAll(async () => {
  ({ dir } = await setupTestDb());
  await seedSettings();

  // mock 上游
  up = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const pathname = new URL(url, 'http://internal.invalid').pathname;
    if (pathname === '/up') {
      // JSON 回显：url + headers（供断言身份注入/头过滤/query 合并）
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url, headers: req.headers }));
      return;
    }
    if (pathname === '/sse') {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 50);
      return;
    }
    if (pathname === '/redir') {
      res.statusCode = 302;
      res.setHeader('location', '/landing');
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('link', '</assets/preload.css>; rel=preload');
      res.end(PAGE_HTML);
      return;
    }
    // 其余路径一律 JSON 回显（供路径凭据等用例断言上游真实 URL）
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url, headers: req.headers }));
  });
  const wss = new WebSocketServer({ noServer: true });
  up.on('upgrade', (req, socket, head) => {
    lastUpstreamIdentity = String(req.headers['x-aap-identity'] ?? '');
    lastUpstreamIdentitySig = String(req.headers['x-aap-identity-sig'] ?? '');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
    });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  upPort = (up.address() as AddressInfo).port;

  // 网关
  const cfg = { ...loadConfig({}), webDist: null };
  gw = http.createServer(createApp(cfg));
  gw.on('upgrade', handleUpgrade);
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  gwPort = (gw.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${gwPort}`;

  // 管理员（直插 + 直建 full 会话；mfaEnabled=true 时 HTTP 登录只给半登录态）
  const [info] = await getDb()
    .insert(users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', mfaEnabled: true, createdAt: Date.now() }).returning({ id: users.id });
  appOwnerId = Number(info!.id);
  adminCookie = await sessionCookieFor(Number(info!.id));

  // 普通用户（plan=free）
  const [u] = await getDb()
    .insert(users)
    .values({ kind: 'local', username: 'freeuser', name: 'free', role: 'user', createdAt: Date.now() })
    .returning({ id: users.id });
  appViewerId = Number(u!.id);
  await writeLocalCredentials(u!.id, 'free-password');

  // 注册应用：公开(passUser) / 站内共享 / 会员 / path 型凭据
  await createAppViaAdmin({ id: 'pub', name: '公开应用', upstream: `http://127.0.0.1:${upPort}`, visibility: 'public', passUser: true });
  await createAppViaAdmin({ id: 'priv', name: '登录应用', upstream: `http://127.0.0.1:${upPort}`, visibility: 'login' });
  await createAppViaAdmin({
    id: 'pathsecret',
    name: '路径凭据',
    upstream: `http://127.0.0.1:${upPort}`,
    visibility: 'public',
    urlSecret: '__path__=/chat/abc',
  });
  await createAppViaAdmin({
    id: 'querysecret',
    name: 'query 凭据',
    upstream: `http://127.0.0.1:${upPort}`,
    visibility: 'public',
    urlSecret: 'token=SECRET123',
  });
  await getDb().insert(apps).values({
    id: 'public-llm-owner',
    name: '公开大模型应用',
    visibility: 'public',
    anonymousAccess: 'write',
    anonymousAccessPolicy: 'legacy',
    kind: 'upstream',
    ownerUserId: appOwnerId,
    manifestJson: JSON.stringify({ capabilities: ['llm'] }),
    upstream: `http://127.0.0.1:${upPort}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await getDb().insert(apps).values([
    {
      id: publicRunAppId,
      name: '公开执行应用',
      visibility: 'public',
      anonymousAccess: 'write',
      anonymousAccessPolicy: 'legacy',
      kind: 'package',
      runtimeMode: 'invoked',
      ownerUserId: appOwnerId,
      manifestJson: JSON.stringify({ entry: 'main.py', capabilities: [] }),
      upstream: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'private-run',
      name: '私有执行应用',
      visibility: 'private',
      kind: 'package',
      runtimeMode: 'invoked',
      ownerUserId: appOwnerId,
      manifestJson: JSON.stringify({ entry: 'main.py', capabilities: [] }),
      upstream: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'llm-publish',
      name: '待发布大模型应用',
      visibility: 'private',
      kind: 'package',
      runtimeMode: 'invoked',
      ownerUserId: appOwnerId,
      manifestJson: JSON.stringify({ entry: 'main.py', capabilities: ['llm'] }),
      upstream: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'ownerless-public-llm',
      name: '无归属的大模型应用',
      visibility: 'public',
      anonymousAccess: 'write',
      anonymousAccessPolicy: 'legacy',
      kind: 'upstream',
      manifestJson: JSON.stringify({ capabilities: ['llm'] }),
      upstream: `http://127.0.0.1:${upPort}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => gw.close(() => r()));
  await new Promise<void>((r) => up.close(() => r()));
  await teardownTestDb(dir);
});

describe('W5 反代（B1）', () => {
  it('裸 /app/<id> 301 补斜杠', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/app/pub/');
  });

  it('HTML 改写：绝对路径进代理前缀 + base 注入 + 猴补丁 + Link 头', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/app/pub/assets/style.css"');
    expect(html).toContain('src="/app/pub/img.png"');
    expect(html).toContain('/app/pub/img@2x.png 2x');
    expect(html).toContain('href="/app/pub/page"');
    expect(html).toContain('<base href="/app/pub/">');
    expect(html).toContain('var PREFIX="/app/pub"');
    expect(res.headers.get('link')).toContain('/app/pub/assets/preload.css');
  });

  it('资源映射到上游根 + 请求头过滤（cookie/authorization 不外泄）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/up?a=1`, {
      headers: { cookie: 'aap_sid=should-not-leak', authorization: 'Bearer x' },
    });
    const body = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(body.url).toBe('/up?a=1');
    expect(body.headers.cookie).toBeUndefined();
    expect(body.headers.authorization).toBeUndefined();
    expect(body.headers.host).toBe(`127.0.0.1:${upPort}`);
  });

  it('身份注入（passUser）：签名可验签、aud 正确', async () => {
    // 登录普通用户
    const base = `http://127.0.0.1:${gwPort}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const cookie = cookieOf(login);
    const res = await fetch(`${base}/app/pub/up`, { headers: { cookie } });
    const body = (await res.json()) as { headers: Record<string, string> };
    const payload = body.headers['x-aap-identity'];
    const sig = body.headers['x-aap-identity-sig'];
    expect(payload).toBeTruthy();
    const secret = getSetting('AAP_SIGN_SECRET')!;
    const v = verifyIdentity(payload!, sig!, secret, 'pub');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.uid).toBe(String(appOwnerId));
      expect(v.payload.kind).toBe('local');
    }
  });

  it('WebSocket passUser 注入应用属主身份', async () => {
    lastUpstreamIdentity = '';
    lastUpstreamIdentitySig = '';
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/pub/echo`);
    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => ws.send('owner'));
      ws.on('message', (data) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(received).toBe('echo:owner');
    const verified = verifyIdentity(
      lastUpstreamIdentity,
      lastUpstreamIdentitySig,
      getSetting('AAP_SIGN_SECRET')!,
      'pub',
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.payload.uid).toBe(String(appOwnerId));
    ws.close();
  });

  it('Location 仅同源改写', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/redir`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/pub/landing');
  });

  it('SSE 流式透传（text/event-stream 原样，无 HTML 改写）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/sse`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: one');
    expect(text).toContain('data: two');
  });

  it('urlSecret：query 型注入 + 请求侧优先合并；path 型替换上游路径', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const qs = await fetch(`${base}/app/querysecret/up?x=1`);
    const qsBody = (await qs.json()) as { url: string };
    expect(qsBody.url).toContain('token=SECRET123');
    expect(qsBody.url).toContain('x=1');

    const ps = await fetch(`${base}/app/pathsecret/up`);
    const psBody = (await ps.json()) as { url: string };
    expect(psBody.url.startsWith('/chat/abc/up')).toBe(true);
  });

  it('路径穿越（编码变体）拒绝（不落 200 即安全）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/%2e%2e/secret`);
    expect(res.status).not.toBe(200);
  });
});

describe('W5 访问策略（B4 三态）', () => {
  it('public 匿名可访问；非公开应用匿名自动跳转登录并保留分享信息', async () => {
    const pub = await fetch(`http://127.0.0.1:${gwPort}/app/pub/`);
    expect(pub.status).toBe(200);
    const publicPage = await pub.text();
    expect(publicPage).toContain('<title>公开应用</title>');
    expect(publicPage).toContain('<meta property="og:title" content="公开应用">');

    const priv = await fetch(`http://127.0.0.1:${gwPort}/app/priv/`);
    expect(priv.status).toBe(200);
    const page = await priv.text();
    expect(page).toContain('og:title" content="登录应用"');
    expect(page).toContain('window.location.replace');
    expect(page).toContain('next=%2Fapp-login-return%3FappId%3Dpriv%26target%3D%252Fapp%252Fpriv%252F');
    expect(page).toContain('nonPublicApp=1&amp;appId=priv&amp;target=%2Fapp%2Fpriv%2F');

    const crawler = await fetch(`http://127.0.0.1:${gwPort}/app/priv/`, {
      headers: { 'user-agent': 'facebookexternalhit/1.1' },
    });
    expect(crawler.status).toBe(200);
    const crawlerPage = await crawler.text();
    expect(crawlerPage).toContain('<title>登录应用</title>');
    expect(crawlerPage).toContain('<meta property="og:title" content="登录应用">');
    expect(crawlerPage).not.toContain('window.location.replace');
  });

  it('普通应用路径为匿名可访问的仅自己应用注入应用分享标题和简介', async () => {
    const appId = `private-anon-share-${randomBytes(4).toString('hex')}`;
    await getDb().insert(apps).values({
      id: appId,
      name: '仅自己匿名只读应用',
      description: '不应显示网站标题的分享简介',
      icon: null,
      visibility: 'private',
      anonymousAccess: 'read',
      anonymousAccessPolicy: 'legacy',
      kind: 'upstream',
      ownerUserId: appOwnerId,
      upstream: `http://127.0.0.1:${upPort}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const base = `http://127.0.0.1:${gwPort}`;
    const response = await fetch(`${base}/app/${appId}/`);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<title>仅自己匿名只读应用</title>');
    expect(page).toContain('<meta property="og:title" content="仅自己匿名只读应用">');
    expect(page).toContain('<meta name="twitter:title" content="仅自己匿名只读应用">');
    expect(page).toContain('<meta property="og:description" content="不应显示网站标题的分享简介">');
    expect(page).toContain(`<meta property="og:image" content="${base}/favicon.png">`);
    expect(page).not.toContain('<title>up</title>');
  });

  it('非公开应用的分享预览包含应用标题和可匿名读取的图标', async () => {
    const appId = `private-share-${randomBytes(4).toString('hex')}`;
    const iconFilename = 'icon-0123456789abcdef0123456789abcdef.png';
    const iconBytes = Buffer.from('private-app-share-icon');
    const iconDirectory = appIconDir(appId);
    fs.mkdirSync(iconDirectory, { recursive: true });
    fs.writeFileSync(path.join(iconDirectory, iconFilename), iconBytes);
    await getDb().insert(apps).values({
      id: appId,
      name: '仅自己应用分享标题',
      description: '应用分享简介',
      icon: `/api/apps/${appId}/icon/${iconFilename}`,
      visibility: 'private',
      kind: 'upstream',
      ownerUserId: appOwnerId,
      upstream: `http://127.0.0.1:${upPort}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    try {
      const base = `http://127.0.0.1:${gwPort}`;
      const pageResponse = await fetch(`${base}/app/${appId}/`, { redirect: 'manual' });
      expect(pageResponse.status).toBe(200);
      const page = await pageResponse.text();
      expect(page).toContain('<title>仅自己应用分享标题</title>');
      expect(page).toContain('<meta property="og:title" content="仅自己应用分享标题">');
      expect(page).toContain('<meta property="og:description" content="应用分享简介">');
      expect(page).toContain(`property="og:image" content="${base}/api/apps/${appId}/share-icon/${iconFilename}"`);
      expect(page).not.toContain('http-equiv="refresh"');
      expect(page).toContain('window.location.replace');

      const publicShareIcon = await fetch(`${base}/api/apps/${appId}/share-icon/${iconFilename}`);
      expect(publicShareIcon.status).toBe(200);
      expect(publicShareIcon.headers.get('content-type')).toContain('image/png');
      expect(publicShareIcon.headers.get('cache-control')).toContain('public');
      expect(Buffer.from(await publicShareIcon.arrayBuffer())).toEqual(iconBytes);

      const privateIcon = await fetch(`${base}/api/apps/${appId}/icon/${iconFilename}`);
      expect(privateIcon.status).toBe(404);
    } finally {
      fs.rmSync(iconDirectory, { recursive: true, force: true });
    }
  });

  it('无自定义图标的非公开应用使用站点图标生成分享预览', async () => {
    const appId = `private-share-no-icon-${randomBytes(4).toString('hex')}`;
    await getDb().insert(apps).values({
      id: appId,
      name: '无图标私有应用',
      description: '即使匿名访问关闭，也可读取分享元数据',
      icon: null,
      visibility: 'private',
      anonymousAccess: 'none',
      kind: 'upstream',
      ownerUserId: appOwnerId,
      upstream: `http://127.0.0.1:${upPort}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const base = `http://127.0.0.1:${gwPort}`;
    const pageResponse = await fetch(`${base}/app/${appId}/`, { redirect: 'manual' });
    expect(pageResponse.status).toBe(200);
    const page = await pageResponse.text();
    expect(page).toContain('<title>无图标私有应用</title>');
    expect(page).toContain('<meta property="og:title" content="无图标私有应用">');
    expect(page).toContain('<meta property="og:description" content="即使匿名访问关闭，也可读取分享元数据">');
    expect(page).toContain(`<meta property="og:image" content="${base}/favicon.png">`);
    expect(page).toContain(`<meta name="twitter:image" content="${base}/favicon.png">`);
  });

  it('应用执行页匿名打开私有应用时明确提示先登录', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/api/apps/private-run/meta`);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('请先登录平台账号');

    const run = await fetch(`http://127.0.0.1:${gwPort}/api/apps/private-run/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${gwPort}` },
      body: JSON.stringify({ input: {} }),
    });
    expect(run.status).toBe(401);
  });

  it('公开 invoked 应用允许匿名调用；执行记录不伪造访客账号', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/api/apps/${publicRunAppId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${gwPort}` },
      body: JSON.stringify({ input: { echo: 'guest' } }),
    });
    expect(res.status).toBe(200);
    const result = await res.json() as { status: string };
    expect(result.status).toBe('error');
    const [run] = await getDb().select().from(appRuns).where(eq(appRuns.appId, publicRunAppId));
    expect(run?.userId).toBeNull();
  });

  it('应用设置分别保存可见范围和匿名权限；新应用默认关闭匿名', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const update = (visibility: string, anonymousAccess?: string) => fetch(
      `${base}/api/apps/${publicRunAppId}/settings`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
        body: JSON.stringify({
          name: '公开执行应用',
          description: '',
          visibility,
          ...(anonymousAccess === undefined ? {} : { anonymousAccess }),
        }),
      },
    );
    const initial = (await getDb().select().from(apps).where(eq(apps.id, 'private-run')))[0]!;
    expect(initial.anonymousAccess).toBe('none');
    await getDb().update(apps).set({
      manifestJson: JSON.stringify({
        entry: 'main.py',
        routes: [
          { path: '/meta', methods: ['GET'], access: 'anonymous_read' },
          { path: '/run', methods: ['POST'], access: 'anonymous_write' },
        ],
      }),
    }).where(eq(apps.id, publicRunAppId));

    expect((await update('private', 'read')).status).toBe(200);
    expect((await fetch(`${base}/api/apps/${publicRunAppId}/meta`)).status).toBe(200);
    const runDenied = await fetch(`${base}/api/apps/${publicRunAppId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ input: {} }),
    });
    expect(runDenied.status).toBe(401);

    expect((await update('login')).status).toBe(200);
    expect((await fetch(`${base}/api/apps/${publicRunAppId}/meta`)).status).toBe(200);

    await update('public', 'none');
    await getDb().update(apps).set({
      manifestJson: JSON.stringify({ entry: 'main.py', capabilities: [] }),
    }).where(eq(apps.id, publicRunAppId));
  });

  it('LLM 费用归属不通过伪造属主身份头传递', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const anon = await fetch(`${base}/app/public-llm-owner/up`);
    const anonBody = (await anon.json()) as { headers: Record<string, string> };
    expect(anonBody.headers['x-aap-identity']).toBeUndefined();
    expect(anonBody.headers['x-aap-identity-sig']).toBeUndefined();

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const viewerCookie = cookieOf(login);
    const viewer = await fetch(`${base}/app/public-llm-owner/up`, { headers: { cookie: viewerCookie } });
    const viewerBody = (await viewer.json()) as { headers: Record<string, string> };
    expect(viewerBody.headers['x-aap-identity']).toBeUndefined();
    expect(viewerBody.headers['x-aap-identity-sig']).toBeUndefined();
  });

  it('公开大模型应用的 WebSocket 不注入伪造的属主身份', async () => {
    lastUpstreamIdentity = '';
    lastUpstreamIdentitySig = '';
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/public-llm-owner/echo`);
    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => ws.send('owner'));
      ws.on('message', (data) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(received).toBe('echo:owner');
    expect(lastUpstreamIdentity).toBe('');
    expect(lastUpstreamIdentitySig).toBe('');
    ws.close();
  });

  it('匿名权限独立于可见范围，并按 manifest 路由权限限制 HTTP 请求', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const routes = [
      { path: '/up', methods: ['GET'], access: 'anonymous_read' },
      { path: '/write', methods: ['POST'], access: 'anonymous_write' },
      { path: '/account', methods: ['GET'], access: 'account' },
      { path: '/echo', methods: ['WS'], access: 'anonymous_write' },
    ];
    await getDb().update(apps).set({
      visibility: 'private',
      anonymousAccess: 'read',
      anonymousAccessPolicy: 'manifest',
      manifestJson: JSON.stringify({ routes }),
    }).where(eq(apps.id, 'priv'));

    try {
      const read = await fetch(`${base}/app/priv/up`);
      expect(read.status).toBe(200);
      expect(((await read.json()) as { url: string }).url).toBe('/up');

      const writeDenied = await fetch(`${base}/app/priv/write`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'guest write',
      });
      expect(await writeDenied.text()).toContain('nonPublicApp=1');

      const accountDenied = await fetch(`${base}/app/priv/account`);
      expect(await accountDenied.text()).toContain('nonPublicApp=1');

      const wsDenied = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/priv/echo`);
        ws.on('open', () => resolve('open'));
        ws.on('error', () => resolve('rejected'));
        ws.on('unexpected-response', () => resolve('rejected'));
      });
      expect(wsDenied).toBe('rejected');

      await getDb().update(apps).set({ anonymousAccess: 'write' }).where(eq(apps.id, 'priv'));
      const writeAllowed = await fetch(`${base}/app/priv/write`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'guest write',
      });
      expect(writeAllowed.status).toBe(200);

      const wsAllowed = new WebSocket(`ws://127.0.0.1:${gwPort}/app/priv/echo`);
      const wsReply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        wsAllowed.on('open', () => wsAllowed.send('anonymous'));
        wsAllowed.on('message', (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
        wsAllowed.on('error', reject);
      });
      expect(wsReply).toBe('echo:anonymous');
      wsAllowed.close();
    } finally {
      await getDb().update(apps).set({
        visibility: 'login',
        anonymousAccess: 'none',
        anonymousAccessPolicy: 'manifest',
        manifestJson: null,
      }).where(eq(apps.id, 'priv'));
    }
  });

  it('任何可见范围下的大模型身份与费用都归当前应用属主', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    await getDb().insert(apps).values({
      id: 'private-llm-owner',
      name: '仅自己大模型应用',
      visibility: 'private',
      kind: 'upstream',
      ownerUserId: appOwnerId,
      passUser: true,
      manifestJson: JSON.stringify({ capabilities: ['llm'] }),
      anonymousAccess: 'read',
      anonymousAccessPolicy: 'manifest',
      upstream: `http://127.0.0.1:${upPort}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await getDb().update(apps).set({
      manifestJson: JSON.stringify({
        capabilities: ['llm'],
        routes: [{ path: '/up', methods: ['GET'], access: 'anonymous_read' }],
      }),
    }).where(eq(apps.id, 'private-llm-owner'));

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const response = await fetch(`${base}/app/private-llm-owner/up`, { headers: { cookie: cookieOf(login) } });
    expect(response.status).toBe(200);
    const body = await response.json() as { headers: Record<string, string> };
    const identity = JSON.parse(Buffer.from(body.headers['x-aap-identity']!, 'base64url').toString('utf8')) as { uid: string };
    expect(identity.uid).toBe(String(appOwnerId));

    const anonymous = await fetch(`${base}/app/private-llm-owner/up`);
    expect(anonymous.status).toBe(200);
    const anonymousBody = await anonymous.json() as { headers: Record<string, string> };
    const anonymousIdentity = JSON.parse(Buffer.from(anonymousBody.headers['x-aap-identity']!, 'base64url').toString('utf8')) as { uid: string };
    expect(anonymousIdentity.uid).toBe(String(appOwnerId));
  });

  it('登录回跳只允许公开应用或应用属主直接进入', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const appId = 'login-redirect-test';
    await getDb().insert(apps).values({
      id: appId,
      name: '登录回跳测试应用',
      visibility: 'private',
      kind: 'upstream',
      ownerUserId: appOwnerId,
      upstream: `http://127.0.0.1:${upPort}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const anon = await fetch(`${base}/api/apps/${appId}/login-redirect`);
    expect(anon.status).toBe(401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const viewerCookie = cookieOf(login);
    const viewerPrivate = await fetch(`${base}/api/apps/${appId}/login-redirect`, {
      headers: { cookie: viewerCookie },
    });
    expect(await viewerPrivate.json()).toEqual({ openApp: false });

    const ownerPrivate = await fetch(`${base}/api/apps/${appId}/login-redirect`, {
      headers: { cookie: adminCookie },
    });
    expect(await ownerPrivate.json()).toEqual({ openApp: true });

    await getDb().update(apps).set({ visibility: 'public' }).where(eq(apps.id, appId));
    const viewerPublic = await fetch(`${base}/api/apps/${appId}/login-redirect`, {
      headers: { cookie: viewerCookie },
    });
    expect(await viewerPublic.json()).toEqual({ openApp: true });
    await getDb().update(apps).set({ visibility: 'private' }).where(eq(apps.id, appId));
  });

  it('account 路由需要登录并向应用传递实际访问者身份，而非覆盖成属主身份', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    await getDb().update(apps).set({
      manifestJson: JSON.stringify({
        capabilities: ['llm'],
        routes: [{ path: '/up', methods: ['GET'], access: 'account' }],
      }),
    }).where(eq(apps.id, 'private-llm-owner'));

    const anon = await fetch(`${base}/app/private-llm-owner/up`);
    expect(await anon.text()).toContain('nonPublicApp=1');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const viewer = await fetch(`${base}/app/private-llm-owner/up`, { headers: { cookie: cookieOf(login) } });
    expect(viewer.status).toBe(200);
    const body = await viewer.json() as { headers: Record<string, string> };
    const identity = JSON.parse(Buffer.from(body.headers['x-aap-identity']!, 'base64url').toString('utf8')) as { uid: string };
    expect(identity.uid).toBe(String(appViewerId));
  });

  it('没有属主的大模型应用不会以匿名方式公开运行', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/ownerless-public-llm/up`);
    expect(res.status).toBe(503);
  });

  it('发布大模型应用必须明确确认 Token 由属主账号承担', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const request = (llmOwnerConsent?: boolean) => fetch(`${base}/api/apps/llm-publish/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({
        name: '待发布大模型应用',
        description: '',
        visibility: 'public',
        ...(llmOwnerConsent === undefined ? {} : { llmOwnerConsent }),
      }),
    });
    const unconfirmed = await request();
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.text()).toContain('请确认大模型 Token 消耗');

    const confirmed = await request(true);
    expect(confirmed.status).toBe(200);
    const app = (await getDb().select().from(apps).where(eq(apps.id, 'llm-publish')))[0];
    expect(app?.visibility).toBe('public');
  });

  it('非归属登录用户不能直接打开其他账号的站内应用', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    await createAppViaAdmin({ id: 'site-shared', name: '站内应用', upstream: `http://127.0.0.1:${upPort}`, visibility: 'login' });
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const cookie = cookieOf(login);
    const res = await fetch(`${base}/app/site-shared/`, { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('只能克隆');
  });

  it('卡片墙：accessible 标记按会话计算', async () => {
    const anon = await fetch(`http://127.0.0.1:${gwPort}/api/apps`);
    const anonBody = (await anon.json()) as { apps: Array<{ id: string; accessible: boolean }> };
    const pubCard = anonBody.apps.find((a) => a.id === 'pub');
    expect(pubCard?.accessible).toBe(true);
    expect(anonBody.apps.some((a) => a.id === 'priv')).toBe(false);
  });
});

describe('W5 WebSocket（B2）', () => {
  it('经网关 upgrade 的回声（HTTP）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/pub/echo`);
    const received = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => {
        clearTimeout(t);
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(received).toBe('echo:hello');
    ws.close();
  });

  it('未授权 WS（login 应用）被拒', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/priv/echo`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', (e) => resolve(e.message));
      ws.on('unexpected-server-response', (res) => resolve(`status:${res.statusCode}`));
    });
    expect(outcome).not.toBe('open');
    ws.close();
  });

  it('公开应用的 WebSocket 可通过自定义域名别名访问', async () => {
    const { apps } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await getDb().update(apps).set({ alias: 'pub-alias' }).where(eq(apps.id, 'pub'));
    await setSetting('SITE_DOMAIN', 'example.com');
    const httpResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${gwPort}/up`,
        { headers: { host: 'pub-alias.example.com' } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
    });
    expect(httpResponse.status, httpResponse.body).toBe(200);
    expect(JSON.parse(httpResponse.body)).toMatchObject({ url: '/up' });

    const conflictingId = await fetch(`http://127.0.0.1:${gwPort}/api/admin/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${gwPort}`, cookie: adminCookie },
      body: JSON.stringify({
        id: 'pub-alias',
        name: '冲突应用 ID',
        visibility: 'public',
        upstream: `http://127.0.0.1:${upPort}`,
      }),
    });
    expect(conflictingId.status).toBe(409);
    expect(await conflictingId.json()).toMatchObject({ error: { code: 'APP_ID_CONFLICT' } });

    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/echo`, {
      headers: { host: 'pub-alias.example.com' },
    });
    const received = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => ws.send('alias'));
      ws.on('message', (data) => {
        clearTimeout(t);
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(received).toBe('echo:alias');
    ws.close();
  });
});

describe('HTML 托管应用', () => {
  it('HTML 托管应用 + 统一页面元素注入', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const { writeHtmlApp } = await import('../gateway/staticApp.js');
    const { apps } = await import('../db/schema.js');
    writeHtmlApp('htmltest', '<!doctype html><html><body><h1 id="h">HELLO-HTML</h1></body></html>');
    await getDb().insert(apps).values({
      id: 'htmltest', name: 'HTML', visibility: 'public', upstream: '', kind: 'html',
      anonymousAccess: 'write', anonymousAccessPolicy: 'legacy',
      ownerUserId: 1, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await setSetting('SITE_NAME', '我的测试站点');
    const res = await fetch(`${base}/app/htmltest/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('HELLO-HTML');
    expect(html).toContain('/portal-chrome.js');
    const chrome = await fetch(`${base}/portal-chrome.js`);
    const chromeJs = await chrome.text();
    expect(chromeJs).toContain('我的测试站点');
    expect(chromeJs).toContain('right:16px;bottom:16px');
    expect(chromeJs).not.toContain('top:10px');
    expect(chromeJs).not.toContain('返回超级面板');
    expect(chromeJs).not.toContain('应用门户');
    expect(chromeJs).not.toContain('个人中心');
    expect(chromeJs).not.toContain('退出登录');
    expect(chromeJs).not.toContain('/api/auth/me');
  });
});

describe('站内共享可见性矩阵', () => {
  it('站内应用：匿名跳转登录；其他登录用户只能克隆，不能直接访问', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    // 匿名 → 登录页引导
    const anon = await fetch(`${base}/app/priv/`);
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain('nonPublicApp=1');

    // 其他登录用户仍无权直接访问
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const cookie = cookieOf(login);
    const entry = await fetch(`${base}/app/priv/`, { headers: { cookie } });
    expect(entry.status).toBe(403);
    expect(await entry.text()).toContain('只能克隆');

    // 站内共享只会显示在「我的应用 → 站内共享」，并且卡片不可直接打开。
    const wall = await fetch(`${base}/api/apps`, { headers: { cookie } });
    const wallBody = (await wall.json()) as { apps: Array<{ id: string; accessible: boolean }> };
    expect(wallBody.apps.some((a) => a.id === 'priv')).toBe(false);
    const shared = await fetch(`${base}/api/apps/site-shared`, { headers: { cookie } });
    const sharedBody = (await shared.json()) as { apps: Array<{ id: string; accessible: boolean }> };
    expect(sharedBody.apps.find((a) => a.id === 'priv')?.accessible).toBe(false);
  });

  it('站内应用拒绝非归属登录用户的 WebSocket 访问', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const cookie = cookieOf(login);
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/priv/echo`, { headers: { cookie } });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', (error) => resolve(error.message));
      ws.on('unexpected-server-response', (res) => resolve(`status:${res.statusCode}`));
    });
    expect(outcome).not.toBe('open');
    ws.close();
  });
});

describe('W5 限流（令牌桶双维度）', () => {
  it('超过每 IP 上限 → 429（放最后，避免污染其他用例）', async () => {
    await setSetting('RATE_IP_PER_MIN', '3');
    // 连续请求匿名公开应用，直到 429（桶里可能已有余量，上限 20 次防死循环）
    let got429 = false;
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/up`);
      if (res.status === 429) {
        got429 = true;
        break;
      }
      await res.text();
    }
    expect(got429).toBe(true);
    await setSetting('RATE_IP_PER_MIN', '600');
  });
});

describe('WS 通道客户端 IP（审计 F2：upgrade 不经 express，按 TRUST_PROXY 语义解析）', () => {
  function mkReq(headers: Record<string, string>, remoteAddress: string | undefined): IncomingMessage {
    return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
  }

  it('TRUST_PROXY=1：与 req.ip 同语义——只信直连一跳，取 XFF 最右（反代上报的其对端）；无 XFF 回落 socket 地址', () => {
    // 一级反代：nginx 追加客户端地址 → 最右即真实客户端
    expect(upgradeClientIp(mkReq({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.2'), true)).toBe('203.0.113.7');
    // 两级链：client, 中间代理 —— trust=1 只到中间代理（与 express req.ip 一致）
    expect(upgradeClientIp(mkReq({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }, '10.0.0.2'), true)).toBe('203.0.113.7');
    expect(upgradeClientIp(mkReq({}, '203.0.113.7'), true)).toBe('203.0.113.7');
  });

  it('TRUST_PROXY 关闭：忽略 XFF 用 socket 地址（防伪造 XFF 绕过限流）；::ffff: 前缀剥离', () => {
    expect(upgradeClientIp(mkReq({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.2'), false)).toBe('10.0.0.2');
    expect(upgradeClientIp(mkReq({}, '::ffff:203.0.113.7'), false)).toBe('203.0.113.7');
    expect(upgradeClientIp(mkReq({}, '::ffff:203.0.113.7'), true)).toBe('203.0.113.7');
    expect(upgradeClientIp(mkReq({}, undefined), false)).toBe('unknown');
  });
});
