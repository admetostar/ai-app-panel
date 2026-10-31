import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';

/**
 * 存活与健康探针（Docker HEALTHCHECK / FPK 健康检查）。
 * 仅回 ok/存活状态：version 与 uptimeSec 是指纹/重启监控信息，
 * 已移入管理员总览 /api/admin/overview（信息泄露收敛，渗透测试 P2-12）。
 */
export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  try {
    await getDb().execute(sql`SELECT 1`);
    res.status(200).json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
