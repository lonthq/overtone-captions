// The review list: LLM changes to check by ear. The editor's unsure edits, and text vote changes no engine heard.
// Written to `meta.review` and as a block in the CLI output.
import type { Logger } from './log.js';
import type { TextVote } from './reconcile/vote.js';
import type { UnsureEdit } from './refine/edits.js';

export interface ReviewItem {
  /** An LLM edit of the refine stage, or a choice of the text vote. */
  kind: 'edit' | 'vote';
  start: number;
  end: number;
  from: string;
  to: string;
  why: string;
}

const ms = (s: number) => Math.round(s * 1000) / 1000;

/** The edits' part of the review list, in time order. */
export function editReview(unsure: readonly UnsureEdit[]): ReviewItem[] {
  return unsure
    .map((e): ReviewItem => ({ kind: 'edit', start: ms(e.start), end: ms(e.end), from: e.from, to: e.edit.to, why: `the editor was not sure${e.edit.note?.trim() ? `: ${e.edit.note.trim()}` : ''}` }))
    .sort((a, b) => a.start - b.start);
}

/** The text vote's part: applied changes no engine or re-listen heard. */
export function voteReview(votes: readonly TextVote[]): ReviewItem[] {
  return votes.flatMap((v): ReviewItem[] => (v.result === 'changed' && v.review ? [{ kind: 'vote', start: ms(v.start), end: ms(v.end), from: v.from, to: v.to, why: v.review }] : []));
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** One line: `1:12 edit "Telecom Cell," → "Telkomsel,": the editor was not sure: …`. */
export function reviewLine(r: ReviewItem): string {
  return `${clock(r.start)} ${r.kind} "${r.from}" → "${r.to}": ${r.why}`;
}

/** The block before the summary line: what to check by ear. Nothing when the list is empty. */
export function reportReview(items: readonly ReviewItem[], log: Logger): void {
  if (items.length === 0) return;
  const n = items.length;
  log.info(`review: ${n} change${n === 1 ? '' : 's'} to check by ear (also in meta.review of the .overtone.json file):`);
  for (const r of items) log.info(`  - ${reviewLine(r)}`);
}
