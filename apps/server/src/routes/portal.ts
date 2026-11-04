import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { PortalBootstrap } from '@aap/shared';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { getSetting } from '../lib/settings.js';
import { oidcEnabled } from '../lib/oidc.js';
import { listPlans } from '../lib/billing.js';
import { listGroups } from '../lib/groups.js';
import { appDomainRoot } from '../gateway/appDomains.js';
import { config } from '../config/index.js';

/**
 * 门户公共引导信息（未登录可读）：品牌数据（A1）+ 注册开关状态 + 初始化标记。
 * 管理端改品牌/注册策略后下次拉取即生效（保存即生效，E2-⑦）。
 */
export const portalRouter = Router();

portalRouter.get('/portal/bootstrap', async (_req, res) => {
  const bootstrap: PortalBootstrap = {
    appDomainRoot: appDomainRoot(),
    appPort: appDomainRoot() === 'localhost' ? config.port : null,
    branding: {
      siteName: getSetting('SITE_NAME') || 'ai-app-panel',
      browserTitle: getSetting('BROWSER_TITLE')?.trim() || getSetting('SITE_NAME') || 'ai-app-panel',
      tagline: getSetting('SITE_TAGLINE') || '',
      logo: getSetting('LOGO') || null,
      themeId: 'graphite',
      accentColor: null,
      footerText: getSetting('FOOTER_TEXT') || '',
      footerCopyright: getSetting('FOOTER_COPYRIGHT') || '',
      icpNumber: getSetting('ICP_NUMBER') || null,
      policeNumber: getSetting('POLICE_NUMBER') || null,
    },
    registration: {
      mode: 'open',
      turnstileEnabled: Boolean(getSetting('TURNSTILE_SITE_KEY')),
    },
    needsInit: Number((await getDb().select({ n: sql<number>`count(*)` }).from(users))[0]?.n ?? 0) === 0,
    oidc: { enabled: oidcEnabled() },
  };
  res.json(bootstrap);
});

portalRouter.get('/portal/plans', async (_req, res) => {
  const groupNames = new Map(await (await listGroups()).map((group) => [group.id, group.name]));
  const plans = await (await listPlans(true)).map((plan) => ({
    ...plan,
    groupName: groupNames.get(plan.groupId) ?? `#${plan.groupId}`,
  }));
  res.json({ plans });
});
