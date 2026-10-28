// Types for normalize.mjs (used by the regression gate's scorer, packages/cli/test/bench/score.ts).
export interface NormToken { t: string; src: number; punct?: true }
export function normalizeWords(words: ReadonlyArray<{ text?: string }>, lang?: string, mode?: 'plain' | 'formatted'): NormToken[];
export function wordsFromText(text: string): Array<{ text: string }>;
