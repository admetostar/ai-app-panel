/**
 * 独立应用 origin：
 *  - 用户应用通过 <id>.localhost 访问，可使用浏览器自身的会话存储
 *  - 应用 origin 上的 /api 路径不会落入门户 API
 *  - 未配置应用域名时旧路径入口继续使用同源 iframe 沙箱
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { users, apps } from '../db/schema.js';
import { writeHtmlApp } from '../gateway/staticApp.js';

let gw: Server;
let gwPort = 0;
let dir: string;
const iconFilename = 'icon-0123456789abcdef0123456789abcdef.png';

const USER_HTML = '<!doctype html><html><body><h1>USERRAW-INDEX</h1><script>localStorage.setItem("album-token","persist")</script></body></html>';
const ADMIN_HTML = '<!doctype html><html><body><h1>ADMINRAW-INDEX</h1></body></html>';

beforeAll(async () => {
  ({ dir } = await setupTestDb());

  const cfg = { ...loadConfig({}), webDist: null };
  gw = http.createServer(createApp(cfg));
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  gwPort = (gw.address() as AddressInfo).port;

  // 管理员（id=1）与普通用户（html 包归属者，非管理员 → 触发 iframe 沙箱隔离）
  const now = Date.now();
  await getDb().insert(users).values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', createdAt: now });
  const [u] = await getDb().insert(users).values({ kind: 'local', username: 'uploader', name: '上传者', role: 'user', createdAt: now }).returning({ id: users.id });
  const uploaderId = Number(u!.id);

  writeHtmlApp('usrhtml', USER_HTML);
  await getDb().insert(apps).values({
    id: 'usrhtml', name: '用户 & HTML <应用>', description: '分享 "预览"', icon: `/api/apps/usrhtml/icon/${iconFilename}`,
    visibility: 'public', upstream: '', kind: 'html',
    ownerUserId: uploaderId, createdAt: now, updatedAt: now,
  });

  writeHtmlApp('admhtml', ADMIN_HTML);
  await getDb().insert(apps).values({
    id: 'admhtml', name: '管理员HTML', visibility: 'public', upstream: '', kind: 'html',
    ownerUserId: 1, createdAt: now, updatedAt: now,
  });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => gw.close(() => r()));
  await closeDb();
  await teardownTestDb(dir);
});

describe('用户应用独立子域名', () => {
  const fetchApp = (requestPath: string) =>
    new Promise<{
      status: number;
      headers: { get(name: string): string | null };
      text(): Promise<string>;
    }>((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${gwPort}${requestPath}`,
        { headers: { host: `usrhtml.localhost:${gwPort}` } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            resolve({
              status: response.statusCode ?? 0,
              headers: { get: (name) => response.headers[name.toLowerCase()]?.toString() ?? null },
              text: async () => body,
            });
          });
        },
      );
      request.on('error', reject);
    });

  it('用户应用子域名可使用原生浏览器会话存储，应用 API 路径不会访问门户 API', async () => {
    const res = await fetchApp('/');
    const html = await res.text();
    expect(res.status, html).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('sandbox');
    expect(html).toContain('USERRAW-INDEX');
    expect(html).toContain('localStorage.setItem');
    expect(html).not.toContain('<iframe sandbox');
    expect(html).toContain('<meta property="og:title" content="用户 &amp; HTML &lt;应用&gt;">');
    expect(html).toContain('<meta property="og:description" content="分享 &quot;预览&quot;">');
    expect(html).toContain(`property="og:image" content="http://localhost:${gwPort}/api/apps/usrhtml/icon/${iconFilename}"`);

    const appApi = await fetchApp('/api/portal/bootstrap');
    expect(appApi.status).toBe(200);
    expect(await appApi.text()).toContain('USERRAW-INDEX');
  });

  it('旧 /app/<id>/ 用户应用入口在本地使用同源 iframe 沙箱', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/usrhtml/`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<iframe data-aap-app-frame sandbox=');
    expect(html).toContain('<meta property="og:title"');
    expect(html).not.toContain('USERRAW-INDEX');
  });

  it('旧路径的深层资源仍在沙箱外壳中打开', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/usrhtml/api/ping?x=1`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<iframe data-aap-app-frame sandbox=');
  });

  it('d. 管理员自建 html 应用：直出且不附加 sandbox CSP（既往信任行为不变）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/admhtml/index.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ADMINRAW-INDEX');
    expect(html).not.toContain('<iframe sandbox');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('sandbox');
  });

  it('旧 raw 通道继续提供带 sandbox CSP 的应用内容', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/usrhtml/raw/index.html`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const html = await res.text();
    expect(html).toContain('USERRAW-INDEX');
    expect(html).not.toContain('og:title');
  });

});
