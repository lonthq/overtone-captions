import { speakerLabel } from '../speakers.js';
import type { FlatWord, OvertoneDocument } from '../types.js';
import { sliceRange } from '../range.js';
import { flattenWords } from '../words.js';
import { cleanText, exportCues } from './shared.js';
import { formatTimestamp } from './timestamp.js';

function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wordToVtt(word: FlatWord, styled: boolean): string {
  const text = escapeVtt(cleanText(word.text));
  if (!styled || !word.classes || word.classes.length === 0) return text;
  return `<c.${word.classes.join('.')}>${text}</c>`;
}

/**
 * WebVTT for one profile, each cue led by a `<v Label>` voice tag. `styled` (default true) wraps styled words in
 * `<c.class>`; `wordTimings` (default false) adds `<hh:mm:ss.mmm>` tags where they fall strictly inside the cue and in
 * order. Expects a validated document; throws RangeError for an out-of-range line word range.
 */
export function toWebVTT(doc: OvertoneDocument, profileId: string, opts: { styled?: boolean; wordTimings?: boolean } = {}): string {
  const styled = opts.styled ?? true;
  const words = flattenWords(doc);
  const blocks = exportCues(doc, profileId).map((cue) => {
    // A trailing "-" would form "-->" with the closing ">", which breaks parsing.
    const label = escapeVtt(speakerLabel(doc, cue.speaker));
    const voice = `<v ${label.endsWith('-') ? `${label} ` : label}>`;
    // Compared in whole milliseconds, as written.
    let last = Math.round(cue.start * 1000);
    const end = Math.round(cue.end * 1000);
    const timed = (word: FlatWord): string => {
      const text = wordToVtt(word, styled);
      const at = Math.round(word.start * 1000);
      if (!opts.wordTimings || at <= last || at >= end) return text;
      last = at;
      return `<${formatTimestamp(at / 1000, '.')}>${text}`;
    };
    const lines = cue.lines.map((line) =>
      sliceRange(words, line.words)
        .map(timed)
        .join(' '),
    );
    const timing = `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}`;
    return `${timing}\n${voice}${lines.join('\n')}`;
  });
  return ['WEBVTT', ...blocks].join('\n\n') + '\n';
}
