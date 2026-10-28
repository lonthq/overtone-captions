// Types for srt.mjs (used by packages/cli/test/bench-srt.test.ts).
export interface Cue { start: number; end: number; text: string }
export function toSrt(cues: readonly Cue[]): string;
export function refCues(
  ref: { segments: Array<{ id: number; start?: number; end?: number }>; words: Array<{ text: string; seg: number }> },
  lang: string,
): Cue[] | undefined;
export function wordCues(words: ReadonlyArray<{ text: string; start?: number; end?: number }>, lang: string): Cue[];
export function textCue(plain: string, duration: number, lang: string): Cue[];
export function captionCues(doc: { profiles: Array<{ cues: Array<{ start: number; end: number; lines: Array<{ text: string }> }> }> }, lang: string): Cue[];
