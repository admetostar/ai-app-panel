const tierIconAssets = import.meta.glob('../../../server/assets/tier-icons/tier*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const TIER_ICON_PATHS: Record<number, string> = {
  1: '../../../server/assets/tier-icons/tier1_basic.png',
  2: '../../../server/assets/tier-icons/tier2_silver.png',
  3: '../../../server/assets/tier-icons/tier3_gold.png',
  4: '../../../server/assets/tier-icons/tier4_platinum.png',
  5: '../../../server/assets/tier-icons/tier5_diamond.png',
};

export function tierIconSrc(tier: number): string | undefined {
  const path = TIER_ICON_PATHS[tier];
  return path ? tierIconAssets[path] : undefined;
}
