import { speakerLabel } from '../speakers.js';
import { cleanText } from './shared.js';
import type { OvertoneDocument } from '../types.js';

/** Plain-text transcript: one "Label: text" paragraph per turn, blank line between. Expects a validated document. */
export function toTranscript(doc: OvertoneDocument): string {
  if (doc.turns.length === 0) return '';
  const paragraphs = doc.turns.map(
    (turn) => `${speakerLabel(doc, turn.speaker)}: ${turn.words.map((word) => cleanText(word.text)).join(' ')}`,
  );
  return paragraphs.join('\n\n') + '\n';
}
