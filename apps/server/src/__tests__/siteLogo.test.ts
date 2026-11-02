import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { createApp } from '../app.js';
import { config, loadConfig } from '../config/index.js';
import { sessionCookieFor, setupTestDb, teardownTestDb } from './testkit.js';

let server: Server | null = null;
let base = '';
let dir: string | null = null;
let adminCookie = '';

beforeAll(async () => {
  ({ dir } = await setupTestDb());
  const [admin] = await getDb()
    .insert(users)
    .values({ kind: 'local', username: 'logo-admin', role: 'admin', mfaEnabled: true, createdAt: Date.now() })
    .returning({ id: users.id });
  if (!admin) throw new Error('Failed to create site logo test admin');
  adminCookie = await sessionCookieFor(admin.id);

  const instance = createServer(createApp({ ...loadConfig({}), webDist: null }));
  server = instance;
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
});

afterAll(async () => {
  const instance = server;
  if (instance) {
    await new Promise<void>((resolve, reject) => {
      instance.close((error) => error ? reject(error) : resolve());
    });
  }
  if (dir) await teardownTestDb(dir);
});

describe('站点 Logo 上传', () => {
  it('仅管理员可上传栅格图片，并以完整公开路径访问数据卷文件', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5sAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${base}/api/admin/site-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ dataBase64: bytes.toString('base64') }),
    });
    expect(upload.status).toBe(200);
    const { path: logoPath } = await upload.json() as { path: string };
    expect(logoPath).toMatch(/^\/uploads\/sitelogo\/logo-[a-f0-9]{32}\.png$/);

    const filename = path.basename(logoPath);
    const filePath = path.join(config.dataDir, 'admin', 'site-logo', filename);
    try {
      expect(fs.readFileSync(filePath)).toEqual(bytes);
      const read = await fetch(`${base}${logoPath}`);
      expect(read.status).toBe(200);
      expect(read.headers.get('content-type')).toContain('image/png');
      expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
    } finally {
      fs.rmSync(filePath, { force: true });
    }

    const anonymous = await fetch(`${base}/api/admin/site-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ dataBase64: bytes.toString('base64') }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('拒绝 SVG 与非图片内容', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
    const response = await fetch(`${base}/api/admin/site-logo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ dataBase64: svg }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'UNSUPPORTED_LOGO_FORMAT' },
    });
  });
});
