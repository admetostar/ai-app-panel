import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { closeDb, getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { recordAppRuntimeEvent } from '../lib/appRuntimeEvents.js';
import { setupTestDb, sessionCookieFor, teardownTestDb } from './testkit.js';

let server: Server;
let port = 0;
let schema = '';
let adminCookie = '';

beforeAll(async () => {
  ({ dir: schema } = await setupTestDb());
  const [admin] = await getDb()
    .insert(users)
    .values({
      kind: 'local',
      username: 'runtime-admin',
      name: 'Runtime Admin',
      role: 'admin',
      mfaEnabled: true,
      createdAt: Date.now(),
    })
    .returning({ id: users.id });
  adminCookie = await sessionCookieFor(Number(admin!.id));

  server = http.createServer(createApp({ ...loadConfig({}), webDist: null }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  if (schema) await teardownTestDb(schema);
});

describe('应用运行事件', () => {
  it('管理员查询可筛选应用，且路径查询参数不会被持久化', async () => {
    await recordAppRuntimeEvent({
      appId: 'web-album',
      event: 'http.timeout',
      level: 'error',
      userId: 7,
      method: 'GET',
      path: '/api/?token=must-not-be-recorded',
      statusCode: 504,
      durationMs: 25_000,
      details: { code: 'APP_RESPONSE_TIMEOUT' },
    });
    await recordAppRuntimeEvent({
      appId: 'other-app',
      event: 'process.ready',
      level: 'info',
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/admin/apps/runtime-events?appId=web-album&limit=1`, {
      headers: { cookie: adminCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      appId: 'web-album',
      event: 'http.timeout',
      level: 'error',
      method: 'GET',
      path: '/api/',
      statusCode: 504,
      durationMs: 25_000,
    });
    expect(JSON.stringify(body.events[0])).not.toContain('must-not-be-recorded');
  });

  it('未登录请求不能读取管理员运行事件', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/apps/runtime-events`);
    expect(response.status).toBe(401);
  });
});
