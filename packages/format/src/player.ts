import { getProfile } from './cues.js';
import type { OvertoneDocument, Turn } from './types.js';

/**
 * A valid document stripped to what a player reads: drops `meta`, `edits` and each word's `match` and `confidence`,
 * and keeps the chosen profiles (default: all). Throws for an unknown profile id.
 */
export function toPlayerDocument(doc: OvertoneDocument, opts: { profiles?: readonly string[] } = {}): OvertoneDocument {
  const profiles = (opts.profiles ?? doc.profiles.map((p) => p.id)).map((id) => {
    const profile = getProfile(doc, id);
    if (!profile) throw new Error(`Unknown profile "${id}"`);
    return profile;
  });
  const turns: Turn[] = doc.turns.map((t) => ({
    speaker: t.speaker,
    start: t.start,
    end: t.end,
    words: t.words.map((w) => ({ text: w.text, start: w.start, end: w.end, ...(w.classes?.length ? { classes: [...w.classes] } : {}) })),
  }));
  return {
    format: doc.format,
    version: doc.version,
    language: doc.language,
    duration: doc.duration,
    speakers: doc.speakers.map((s) => ({ ...s })),
    turns,
    profiles: profiles.map((p) => structuredClone(p)),
  };
}
