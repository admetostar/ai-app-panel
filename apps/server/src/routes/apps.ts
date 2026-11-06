/** 门户卡片墙数据（A1×B4）：所有启用应用 + 按会话计算的 accessible 标记 */
import { Router } from 'express';
import type { AppCard } from '@aap/shared';
import { listApps, canAccess, isVisibleInPortal } from '../gateway/registry.js';

export const appsRouter = Router();

appsRouter.get('/apps', async (req, res) => {
  const user = req.user ?? null;
  const cards: AppCard[] = await Promise.all((await listApps())
    .filter((a) => a.enabled)
    .filter((a) => isVisibleInPortal(a, user)) // 克隆副本始终隐藏；private 对非归属者隐藏
    .map(async (a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      category: a.category,
      visibility: a.visibility as AppCard['visibility'],
      accessible: await canAccess(a, user),
      status: (a.healthState as AppCard['status']) ?? 'unknown',
      sort: a.sort,
      kind: a.kind as AppCard['kind'],
      runtimeMode: (a.runtimeMode as AppCard['runtimeMode']) ?? null,
    })));
  res.json({ apps: cards });
});
