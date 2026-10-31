/**
 * .asp-app package uploads do not require signatures.
 * User and administrator upload paths still validate the archive and manifest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessionCookieFor, setupTestDb, testPackage, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { apps, users } from '../db/schema.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base: string;
let dir: string;
let adminCookie = '';

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

function submit(dataBase64: string): Promise<{ status: number; body: { id?: string; error?: { code?: string } } }> {
  return fetch(`${base}/api/apps/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    body: JSON.stringify({ filename: 'pkg.asp-app', dataBase64 }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { id?: string; error?: { code?: string } } }));
}

function submitAdmin(dataBase64: string): Promise<{ status: number; body: { error?: { code?: string } } }> {
  return fetch(`${base}/api/admin/apps/package`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    body: JSON.stringify({ filename: 'pkg.asp-app', dataBase64 }),
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
});

afterAll(async () => {
  server.close();
  await closeDb();
  await teardownTestDb(dir);
});

describe('.asp-app 上传不要求签名', () => {
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
});
