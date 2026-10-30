const AVATAR_NAMES = [
  'blob',
  'cloud',
  'cat',
  'bunny',
  'bear',
  'flower',
  'drop',
  'ghost',
  'arch',
  'sprout',
  'robot',
  'sun',
] as const;

const AVATAR_COUNT = 24;

export function defaultAvatarForUser(userId: number): string {
  const index = ((Math.max(1, userId) - 1) % AVATAR_COUNT) + 1;
  const name = AVATAR_NAMES[(index - 1) % AVATAR_NAMES.length]!;
  return `avatar_${String(index).padStart(2, '0')}_${name}.png`;
}
