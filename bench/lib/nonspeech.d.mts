// Types for nonspeech.mjs (used by packages/cli/test/bench-nonspeech.test.ts).
type System = 'overtone' | 'textOnly' | 'azure' | 'scribe';
interface Word { text: string; start?: number; end?: number }
export const SYSTEMS: System[];
export const SPEECH_START_SLACK: number;
export interface NonSpeechScore { words: number; perMinute: number }
export interface SpeechAfterScore { wordsBefore: number | undefined; wer: number; refTokens: number }
export function scoreNonSpeechClip(
  ref: { nonSpeech?: boolean; duration: number; speechStart?: number; words: Array<{ text: string }> },
  hyp: { overtone: { words: Word[] }; azure: { words: Word[] }; scribe?: { words: Word[] }; textOnly: { text: string } },
  lang: string,
): Partial<Record<System, NonSpeechScore | SpeechAfterScore>>;
export function hallucinationRate(scored: Array<{ nonSpeech?: boolean; scores: Partial<Record<System, { words?: number }>> }>): Partial<Record<System, { clips: number; withWords: number }>>;
