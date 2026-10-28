import type { Profile } from './types.js';

/** A profile aspect: "W:H", two positive integers without leading zeros. Keep in sync with overtone.schema.json. */
export const ASPECT_PATTERN = /^[1-9][0-9]*:[1-9][0-9]*$/;

/** Distances (natural log of the aspect) closer than this count as equal. */
const TIE_TOLERANCE = 1e-9;

/** "16:9" → 1.777…; throws for anything that is not "W:H" with two positive integers. */
export function parseAspect(aspect: string): number {
  if (!ASPECT_PATTERN.test(aspect)) throw new Error(`Invalid aspect "${aspect}": expected "W:H" with two positive integers without leading zeros, such as "16:9".`);
  const [w, h] = aspect.split(':').map(Number);
  return w / h;
}

/**
 * The profile for a picture of `pictureAspect` (width / height), spec §14.3: smallest |ln(picture) − ln(profile)|,
 * ties to the wider, then the earlier profile. A non-finite or non-positive aspect counts as 16:9.
 */
export function closestProfile<P extends Pick<Profile, 'aspect'>>(profiles: readonly P[], pictureAspect: number): P | undefined {
  const target = Math.log(Number.isFinite(pictureAspect) && pictureAspect > 0 ? pictureAspect : 16 / 9);
  let best: { profile: P; distance: number; aspect: number } | undefined;
  for (const profile of profiles) {
    const aspect = parseAspect(profile.aspect);
    const distance = Math.abs(Math.log(aspect) - target);
    if (!best || distance < best.distance - TIE_TOLERANCE || (Math.abs(distance - best.distance) <= TIE_TOLERANCE && aspect > best.aspect)) {
      best = { profile, distance, aspect };
    }
  }
  return best?.profile;
}
