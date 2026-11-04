import { getSetting } from '../lib/settings.js';
import { isSlug } from './registry.js';

export function appDomainRoot(): string {
  return (getSetting('SITE_DOMAIN') ?? '').trim().toLowerCase().replace(/\.$/, '') || 'localhost';
}

/** Returns null for the portal host, an app ID for a valid app host, and '' for an invalid subdomain. */
export function appIdFromHostname(hostname: string | null | undefined, root = appDomainRoot()): string | null {
  if (typeof hostname !== 'string' || hostname.trim() === '') return null;
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const suffix = `.${root}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.') || !isSlug(label)) return '';
  return label;
}

export function isAppHostname(hostname: string | null | undefined, root = appDomainRoot()): boolean {
  return appIdFromHostname(hostname, root) !== null;
}
