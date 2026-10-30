import { withBase } from './base';

const avatarAssets = import.meta.glob('../../../server/assets/icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const orderedAvatarEntries = Object.entries(avatarAssets).sort(([left], [right]) => left.localeCompare(right));

export function userAvatarSrc(avatar: string | null | undefined, userId: number): string | undefined {
  if (avatar && /^(https?:|data:|blob:)/i.test(avatar)) return avatar;
  if (avatar?.startsWith('/')) return withBase(avatar);
  if (avatar) {
    const asset = avatarAssets[`../../../server/assets/icons/${avatar}`];
    if (asset) return asset;
  }
  if (orderedAvatarEntries.length === 0) return undefined;
  return orderedAvatarEntries[(Math.max(1, userId) - 1) % orderedAvatarEntries.length]?.[1];
}
