// Types for wer.mjs (used by the regression gate's scorer, packages/cli/test/bench/score.ts).
export interface AlignOp { op: 'C' | 'S' | 'D' | 'I'; r: number | null; h: number | null }
export function align(ref: readonly string[], hyp: readonly string[]): { ops: AlignOp[]; dist: number };
export function editDistance(a: readonly string[], b: readonly string[]): number;
