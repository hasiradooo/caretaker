export const XP_STEP = 3000;
export const MAX_TOTAL_XP = 2_000_000_000;

/** Legacy rows store XP WITHIN the current level, not lifetime XP. */
export function totalXp(level: number, xp: number): number {
  return (XP_STEP * level * (level + 1)) / 2 + xp;
}

export function splitXp(total: number): { level: number; xp: number } {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_TOTAL_XP)
    throw new Error("Total XP is outside the supported range");
  const level = Math.floor((Math.sqrt(1 + (8 * total) / XP_STEP) - 1) / 2);
  return { level, xp: total - totalXp(level, 0) };
}

export function messageXp(
  min: number,
  max: number,
  multiplier: number,
  random: () => number = Math.random,
): number {
  return Math.floor(
    (min + Math.floor(random() * (max - min + 1))) * multiplier,
  );
}
