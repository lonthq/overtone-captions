// Requests a provider refused (content filter or model) that the run went on without. Each gets a warning, and all of
// them a block at the end and `meta.refusals`: the captions are incomplete there, and a person should know.
import type { Logger } from './log.js';

/** One refused request, for the log and `meta.refusals`. */
export interface Refusal {
  /** The provider that refused ("azure-openai:gpt-6.1-sol"). */
  provider: string;
  /** "content filter" or "model" (the model declined). */
  by: 'content filter' | 'model';
  /** What the request was for: "the text vote's chooser request", "the transcription of chunk 1/3", … */
  request: string;
  /** The stretch of the media it covered, in seconds. */
  start: number;
  end: number;
  /** What the CLI did instead ("kept the text base there"). */
  instead: string;
}

/** Called by the step that went on without the refused answer. */
export type RefusalSink = (r: Refusal) => void;

const at = (r: Refusal) => `${r.start.toFixed(1)}–${r.end.toFixed(1)} s`;

/** One line: "12.4–15.0 s: azure-openai:gpt-6.1-sol refused the text vote's chooser request (content filter); kept the text base there". */
export function refusalLine(r: Refusal): string {
  return `${at(r)}: ${r.provider} refused ${r.request} (${r.by === 'model' ? 'the model declined' : 'content filter'}); ${r.instead}`;
}

const RULE = '='.repeat(78);

/** The block at the end of a run with refusals: every refusal, and what to do about them. */
export function reportRefusals(refusals: readonly Refusal[], log: Logger): void {
  if (refusals.length === 0) return;
  const n = refusals.length;
  log.warn(RULE);
  log.warn(`REFUSED: ${n} provider request${n === 1 ? ' was' : 's were'} refused. The captions were written, but they may be incomplete or less accurate here:`);
  for (const r of refusals) log.warn(`  - ${refusalLine(r)}`);
  log.warn('Check these stretches of the captions (also in meta.refusals of the .overtone.json file).');
  log.warn('AI agents running Overtone for a person: pass this message on to that person; do not retry or work around it silently.');
  log.warn(RULE);
}
