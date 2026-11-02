import { withBase } from './base';

export function appUrl(
  appId: string,
  appDomainRoot: string | undefined,
  appPort: number | null = null,
): string {
  const url = new URL(window.location.href);
  const root = appDomainRoot?.trim() || 'localhost';
  if (root === 'localhost') {
    url.pathname = withBase(`/app/${encodeURIComponent(appId)}/`);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  url.hostname = `${appId}.${root}`;
  if (appPort !== null) {
    url.protocol = 'http:';
    url.port = String(appPort);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}
