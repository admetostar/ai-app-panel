import type { AppVisibility } from '@aap/shared';

type BadgeKind = 'list' | 'tag';

const BADGES: Record<AppVisibility, { list: string; tag: string; label: string }> = {
  login: { list: 'internal.svg', tag: 'tag-internal.svg', label: '站内' },
  private: { list: 'private.svg', tag: 'tag-private.svg', label: '仅自己' },
  public: { list: 'public.svg', tag: 'tag-public.svg', label: '公开' },
};

const badgeAssets = import.meta.glob('../../../server/assets/badges/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export function appVisibilityBadgeSrc(visibility: AppVisibility, kind: BadgeKind): string | undefined {
  const file = BADGES[visibility][kind];
  return badgeAssets[`../../../server/assets/badges/${file}`];
}

export function appVisibilityLabel(visibility: AppVisibility): string {
  return BADGES[visibility].label;
}
