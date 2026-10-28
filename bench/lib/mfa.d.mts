// Types for mfa.mjs (used by packages/cli/test/bench-mfa.test.ts).
export interface TimedWord { text: string; start: number; end: number }
export function textGridWords(textGrid: string): TimedWord[];
export function attachTimes(words: Array<{ text: string; start?: number; end?: number }>, timed: readonly TimedWord[], offset?: number): number;
