import type { OvertoneDocument } from '../types.js';
import { flattenWords, rangeText } from '../words.js';
import { cleanText, exportCues } from './shared.js';
import { formatTimestamp } from './timestamp.js';

/**
 * Replaces what SRT players would parse (`-->`, tags like `<i>`, overrides like `{\an8}`) with lookalikes
 * (`→`, `‹i>`, `｛\an8}`) so the text shows literally.
 */
function srtText(text: string): string {
  return text
    .replace(/-->/g, '→')
    .replace(/<(?=\/?[A-Za-z])/g, '‹')
    .replace(/\{\\/g, '｛\\');
}

/**
 * SubRip for one profile: numbered cues, plain text, no speaker names.
 * Expects a validated document; throws RangeError for an out-of-range line word range.
 */
export function toSRT(doc: OvertoneDocument, profileId: string): string {
  const words = flattenWords(doc).map((word) => ({ ...word, text: cleanText(word.text) }));
  return exportCues(doc, profileId)
    .map((cue, i) => {
      const timing = `${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(cue.end, ',')}`;
      const lines = cue.lines.map((line) => srtText(rangeText(words, line.words)));
      return `${i + 1}\n${timing}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}
