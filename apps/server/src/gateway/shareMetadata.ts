import type { Request } from 'express';
import { config } from '../config/index.js';
import { getSetting } from '../lib/settings.js';
import { appDomainRoot } from './appDomains.js';
import type { AppShareMetadata } from './staticApp.js';

type ShareableApp = {
  id: string;
  name: string;
  description: string;
  icon: string | null;
};

export function shareMetadataFor(req: Request, app: ShareableApp, appOrigin: boolean): AppShareMetadata {
  const host = appOrigin
    ? `${appDomainRoot()}${req.get('host')?.match(/:(\d+)$/)?.[0] ?? ''}`
    : req.get('host');
  const gatewayPrefix = config.gatewayPrefix ?? '';
  const iconPrefix = `/api/apps/${encodeURIComponent(app.id)}/icon/`;
  const iconFilename = app.icon?.startsWith(iconPrefix) ? app.icon.slice(iconPrefix.length) : '';
  const appIconPath = /^icon-[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/.test(iconFilename)
    ? `${gatewayPrefix}/api/apps/${encodeURIComponent(app.id)}/share-icon/${iconFilename}`
    : null;
  const siteIcon = getSetting('LOGO')?.trim();
  const siteIconPath = siteIcon
    ? /^https?:\/\//i.test(siteIcon)
      ? siteIcon
      : `${gatewayPrefix}${siteIcon.startsWith('/') ? siteIcon : `/${siteIcon}`}`
    : `${gatewayPrefix}/favicon.png`;
  const imageUrl = appIconPath
    ? host ? `${req.protocol}://${host}${appIconPath}` : null
    : /^https?:\/\//i.test(siteIconPath)
      ? siteIconPath
      : host ? `${req.protocol}://${host}${siteIconPath}` : null;
  return {
    title: app.name,
    description: app.description || app.name,
    imageUrl,
  };
}
