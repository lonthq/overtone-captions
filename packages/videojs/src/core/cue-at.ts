import type { Profile } from 'overtone-format';
import { cueIndexWithHold } from './cue-hold.js';
import { isInWindow } from './window.js';

/** The cue index to show at `time` (-1 for nothing), window and hold applied. Shared by the player and `overtone burn`. */
export function cueIndexAt(profile: Profile, time: number): number {
  return isInWindow(profile, time) ? cueIndexWithHold(profile.cues, time, profile.window) : -1;
}
