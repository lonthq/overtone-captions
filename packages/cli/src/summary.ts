import { MATCH_KINDS, type MatchKind, type Profile, type Word } from 'overtone-format';

/**
 * The final CLI line: "312 words: 290 exact, 18 fuzzy, 4 interpolated · 6 edits, 1 rejected · 2 to review · 2 speakers
 * · 48/71 cues". `rejected`: edits that failed a structure check; `review`: LLM changes to check by ear.
 */
export function formatSummary(s: { words: readonly Word[]; edits: number; rejected: number; review?: number; speakers: number; profiles: readonly Profile[] }): string {
  const counts = new Map<MatchKind, number>();
  for (const w of s.words) if (w.match) counts.set(w.match, (counts.get(w.match) ?? 0) + 1);
  const kinds = MATCH_KINDS.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`);
  const words = `${s.words.length} words${kinds.length > 0 ? `: ${kinds.join(', ')}` : ''}`;
  // accepted edits, then the rejected ones: "6 edits, 1 rejected"
  const edits = `${s.edits} edit${s.edits === 1 ? '' : 's'}${s.rejected > 0 ? `, ${s.rejected} rejected` : ''}`;
  const speakers = `${s.speakers} speaker${s.speakers === 1 ? '' : 's'}`;
  const cues = `${s.profiles.map((p) => p.cues.length).join('/')} cues`;
  const review = s.review ? [`${s.review} to review`] : [];
  return [words, edits, ...review, speakers, cues].join(' · ');
}
