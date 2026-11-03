import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PortalBootstrap } from '@aap/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { createGroup } from '../lib/groups.js';
import { createPlan, updatePlan } from '../lib/billing.js';
import { setupTestDb, teardownTestDb } from './testkit.js';

let server: Server;
let baseUrl: string;
let dbSchema: string;

beforeAll(async () => {
  ({ dir: dbSchema } = await setupTestDb());
  // 测试配置：默认值但关闭 webDist（测试环境无前端产物）
  const cfg = { ...loadConfig({}), webDist: null };
  const app = createApp(cfg);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardownTestDb(dbSchema);
});

describe('W1 冒烟', () => {
  it('GET /api/health 探活', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version?: string };
    expect(body.ok).toBe(true);
    // 信息泄露收敛（P2-12）：version/uptimeSec 仅管理员可见，匿名 health 只回 ok
    expect(body.version).toBeUndefined();
  });

  it('GET /api/portal/bootstrap 返回默认品牌与开放注册、needsInit=true', async () => {
    const res = await fetch(`${baseUrl}/api/portal/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PortalBootstrap;
    expect(body.branding.siteName).toBe('ai-app-panel');
    expect(body.registration.mode).toBe('open');
    expect(body.appDomainRoot).toBe('localhost');
    expect(body.appPort).toBe(8080);
    expect(body.needsInit).toBe(true);
  });

  it('GET /api/portal/plans 匿名返回管理员启用的权益套餐', async () => {
    const groupId = await createGroup('公开套餐分组', '');
    await createPlan({
      name: '可见权益包',
      groupId,
      durationDays: 30,
      priceFen: 1200,
      tokenGrant: 500,
      tier: 4,
      appUploadLimit: 2,
      appCloneLimit: 3,
    });
    const hiddenPlanId = await createPlan({ name: '停售权益包', groupId, durationDays: 30, priceFen: 1000 });
    await updatePlan(hiddenPlanId, { enabled: false });

    const res = await fetch(`${baseUrl}/api/portal/plans`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plans: Array<{ name: string; groupName: string; tier: number; appCloneLimit: number }>;
    };
    expect(body.plans).toHaveLength(1);
    expect(body.plans[0]).toMatchObject({
      name: '可见权益包',
      groupName: '公开套餐分组',
      tier: 4,
      appCloneLimit: 3,
    });
  });

  it('未知 /api 路径返回 JSON 404（不被 SPA 兜底吞掉）', async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
