import type { Profile } from 'overtone-format';

/** False outside the profile's `window` (start inclusive, end exclusive); true when it has none. */
export function isInWindow(profile: Profile, time: number): boolean {
  const window = profile.window;
  return !window || (time >= window.start && time < window.end);
}
