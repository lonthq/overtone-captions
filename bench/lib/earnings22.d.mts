// Types for earnings22.mjs (used by packages/cli/test/bench-earnings22.test.ts).
export interface NlpWord { text: string; speaker: string; start?: number; end?: number }
export interface RefWord extends NlpWord { seg: number }
export interface RefSegment { id: number; speaker: string; start?: number; end?: number }
export interface WindowRule { from?: number; length?: number; step?: number; edge?: number; maxUntimed?: number; minSpeakers?: number }
export function parseNlp(text: string): NlpWord[];
export function pickWindow(words: readonly NlpWord[], rule?: WindowRule): { start: number; end: number } | undefined;
export function windowWords(words: readonly NlpWord[], start: number, end: number): NlpWord[];
export function windowRef(words: readonly NlpWord[], start: number, end: number): { words: RefWord[]; segments: RefSegment[] };
