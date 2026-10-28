import { sliceRange } from './range.js';
import type { FlatWord, OvertoneDocument, Word, WordRange } from './types.js';

/** All words of the document with their global index, speaker and turn index. */
export function flattenWords(doc: OvertoneDocument): FlatWord[] {
  const flat: FlatWord[] = [];
  doc.turns.forEach((turn, turnIndex) => {
    for (const word of turn.words) {
      flat.push({ ...word, index: flat.length, speaker: turn.speaker, turn: turnIndex });
    }
  });
  return flat;
}

/** Texts of the words in the inclusive range, joined by single spaces. Throws RangeError on a bad range. */
export function rangeText(words: readonly Word[], range: WordRange): string {
  return sliceRange(words, range)
    .map((word) => word.text)
    .join(' ');
}
