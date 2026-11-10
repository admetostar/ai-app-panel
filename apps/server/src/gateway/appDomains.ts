import { getSetting } from '../lib/settings.js';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { eq } from 'drizzle-orm';
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

/** Resolve a valid application host label to its stable app ID, supporting owner-defined aliases. */
export async function resolveAppIdFromHostname(hostname: string | null | undefined, root = appDomainRoot()): Promise<string | null> {
  const label = appIdFromHostname(hostname, root);
  if (label === null || label === '') return label;

  const [byId] = await getDb().select({ id: apps.id }).from(apps).where(eq(apps.id, label)).limit(1);
  if (byId) return byId.id;

  const [byAlias] = await getDb().select({ id: apps.id }).from(apps).where(eq(apps.alias, label)).limit(1);
  return byAlias?.id ?? label;
}

export async function appIdConflictsWithAlias(appId: string): Promise<boolean> {
  const [alias] = await getDb().select({ id: apps.id }).from(apps).where(eq(apps.alias, appId)).limit(1);
  return alias !== undefined;
}

export function isValidAppAlias(alias: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias);
}
