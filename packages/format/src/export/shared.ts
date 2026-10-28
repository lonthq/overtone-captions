import { clipCuesToWindow, getProfile } from '../cues.js';
import type { Cue, OvertoneDocument } from '../types.js';

/** The cues of a profile as exporters write them (window applied). Throws for an unknown profile id. */
export function exportCues(doc: OvertoneDocument, profileId: string): Cue[] {
  const profile = getProfile(doc, profileId);
  if (!profile) throw new Error(`Unknown profile "${profileId}"`);
  return clipCuesToWindow(profile);
}

/** Collapses all whitespace (including newlines) to single spaces and trims. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
