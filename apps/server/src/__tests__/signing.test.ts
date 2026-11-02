/**
 * AWPK package uploads do not require signatures and reject legacy extensions.
 * User and administrator upload paths still validate the archive and manifest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessionCookieFor, setupTestDb, testPackage, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { apps, userGroups, users } from '../db/schema.js';
import { activateMembership, createPlan } from '../lib/billing.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base: string;
let dir: string;
let adminCookie = '';
let quotaUserCookie = '';

function packageBase64(id: string, extraFiles: Record<string, string> = {}): string {
  return testPackage({
    'manifest.json': JSON.stringify({
      name: id,
      display_name: id,
      version: '1.0.0',
      type: 'html',
      entry: 'index.html',
    }),
    'index.html': `<h1>${id}</h1>`,
    ...extraFiles,
  }).toString('base64');
}

function submitAs(cookie: string, dataBase64: string, filename = 'pkg.awpk'): Promise<{ status: number; body: { id?: string; error?: { code?: string } } }> {
  return fetch(`${base}/api/apps/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ filename, dataBase64 }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { id?: string; error?: { code?: string } } }));
}

function submit(dataBase64: string, filename = 'pkg.awpk') {
  return submitAs(adminCookie, dataBase64, filename);
}

function submitAdmin(dataBase64: string, filename = 'pkg.awpk'): Promise<{ status: number; body: { error?: { code?: string } } }> {
  return fetch(`${base}/api/admin/apps/package`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    body: JSON.stringify({ filename, dataBase64 }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: { code?: string } } }));
}

async function rowOf(id: string): Promise<{ signatureStatus: string | null; visibility: string; enabled: boolean } | null> {
  const row = (await getDb()
    .select({ signatureStatus: apps.signatureStatus, visibility: apps.visibility, enabled: apps.enabled })
    .from(apps)
    .where(eq(apps.id, id)))[0];
  return row ?? null;
}

beforeAll(async () => {
  ({ dir } = await setupTestDb());
  await seedSettings();

  server = createApp({ ...loadConfig({}), webDist: null }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const [admin] = await getDb()
    .insert(users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', mfaEnabled: true, createdAt: Date.now() })
    .returning({ id: users.id });
  if (!admin) throw new Error('Failed to create test administrator');
  adminCookie = await sessionCookieFor(admin.id);

  const [group] = await getDb()
    .insert(userGroups)
    .values({ name: 'upload-quota-test', createdAt: Date.now() })
    .returning({ id: userGroups.id });
  if (!group) throw new Error('Failed to create upload quota test group');
  const planId = await createPlan({
    name: '单应用上传权益',
    groupId: group.id,
    durationDays: 30,
    appUploadLimit: 1,
  });
  const [user] = await getDb()
    .insert(users)
    .values({ kind: 'local', username: 'quota-user', name: '额度用户', createdAt: Date.now() })
    .returning({ id: users.id });
  if (!user) throw new Error('Failed to create quota test user');
  await activateMembership(user.id, planId);
  quotaUserCookie = await sessionCookieFor(user.id);
});

afterAll(async () => {
  server.close();
  await closeDb();
  await teardownTestDb(dir);
});

describe('.awpk 上传不要求签名', () => {
  it('普通用户上传未签名包后立即启用为私有应用', async () => {
    const r = await submit(packageBase64('unsignedpkg'));
    expect(r.status).toBe(200);
    expect(await rowOf('unsignedpkg')).toEqual({ signatureStatus: null, visibility: 'private', enabled: true });
  });

  it('签名文件内容无效或与包内容不匹配不影响接收', async () => {
    const r = await submit(packageBase64('signatureignored', {
      'signature.json': JSON.stringify({ alg: 'ed25519', signature: 'invalid' }),
    }));
    expect(r.status).toBe(200);
    expect(await rowOf('signatureignored')).toEqual({ signatureStatus: null, visibility: 'private', enabled: true });
  });

  it('普通用户上传不需要管理员配置的公钥', async () => {
    const r = await submit(packageBase64('no-trust-list'));
    expect(r.status).toBe(200);
    expect(await rowOf('no-trust-list')).not.toBeNull();
  });

  it('应用达到权益数量上限后拒绝新上传，但允许更新已有应用', async () => {
    const first = await submitAs(quotaUserCookie, packageBase64('quota-first'));
    expect(first.status).toBe(200);

    const second = await submitAs(quotaUserCookie, packageBase64('quota-second'));
    expect(second.status).toBe(403);
    expect(second.body.error?.code).toBe('APP_UPLOAD_LIMIT_REACHED');
    expect(await rowOf('quota-second')).toBeNull();

    const update = await submitAs(quotaUserCookie, packageBase64('quota-first', { 'index.html': '<h1>updated</h1>' }));
    expect(update.status).toBe(200);
  });

  it('达到上传数量上限不影响公开发布已有应用', async () => {
    await getDb().insert(apps).values({
      id: 'publish-without-upload-quota',
      name: '发布不占上传额度',
      ownerUserId: (await getDb().select({ id: users.id }).from(users).where(eq(users.username, 'quota-user')))[0]!.id,
      visibility: 'private',
      kind: 'html',
      upstream: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const result = await fetch(`${base}/api/apps/publish-without-upload-quota/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: quotaUserCookie },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, visibility: 'public' });
  });

  it('管理员上传同样接受未签名包', async () => {
    const r = await submitAdmin(packageBase64('admin-unsigned'));
    expect(r.status).toBe(200);
    expect(await rowOf('admin-unsigned')).toEqual({ signatureStatus: null, visibility: 'private', enabled: true });
  });

  it('管理员上传也不验证包内签名', async () => {
    const r = await submitAdmin(packageBase64('admin-invalid-signature', {
      'signature.json': 'not a signature',
    }));
    expect(r.status).toBe(200);
    expect(await rowOf('admin-invalid-signature')).not.toBeNull();
  });

  it('用户端拒绝旧扩展名与通用 ZIP 扩展名', async () => {
    for (const filename of ['legacy.asp-app', 'legacy.zip']) {
      const r = await submit(packageBase64('rejected-extension'), filename);
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe('INVALID_PACKAGE_EXT');
    }
    expect(await rowOf('rejected-extension')).toBeNull();
  });

  it('管理端预览和上传拒绝旧扩展名与通用 ZIP 扩展名', async () => {
    const dataBase64 = packageBase64('preview-extension');
    for (const filename of ['legacy.asp-app', 'legacy.zip']) {
      const preview = await fetch(`${base}/api/admin/apps/package/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
        body: JSON.stringify({ filename, dataBase64 }),
      });
      expect(preview.status).toBe(400);
      expect(((await preview.json()) as { error?: { code?: string } }).error?.code).toBe('INVALID_PACKAGE_EXT');

      const r = await submitAdmin(dataBase64, filename);
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe('INVALID_PACKAGE_EXT');
    }
    expect(await rowOf('preview-extension')).toBeNull();
  });

  it('拒绝使用 .awpk 扩展名但内容不是 ZIP 的文件', async () => {
    const r = await submit(Buffer.from('not a zip').toString('base64'));
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('PACKAGE_INVALID');
    expect(await rowOf('pkg')).toBeNull();
  });

  it('用户 AWPK 的 Python requirements 安装失败时拒绝安装并清理临时文件', async () => {
    const previousPythonBin = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = process.execPath;
    try {
      const dataBase64 = testPackage({
        'manifest.json': JSON.stringify({
          name: 'user-dependency-failure',
          display_name: 'dependency failure',
          version: '1.0.0',
          type: 'python',
          entry: 'mod.py',
          runtime: 'invoked',
          requirements: ['example-package>=1'],
        }),
        'mod.py': 'def handle(input, aap):\n    return {"ok": True}\n',
      }).toString('base64');
      const response = await submit(dataBase64);
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe('PIP_INSTALL_FAILED');
      expect(await rowOf('user-dependency-failure')).toBeNull();
    } finally {
      if (previousPythonBin === undefined) delete process.env.PYTHON_BIN;
      else process.env.PYTHON_BIN = previousPythonBin;
    }
  });
});
