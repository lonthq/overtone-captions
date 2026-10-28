// Word times from Montreal Forced Aligner TextGrids (Zenodo record 2619474) for LibriSpeech-PC references.
// See DATASETS.md.
import { align } from './wer.mjs';

/** The words of a TextGrid's "words" tier: [{ text, start, end }], without the empty (silence) intervals. */
export function textGridWords(textGrid) {
  const tier = /name = "words"([\s\S]*?)(?:item \[\d+\]:|$)/.exec(textGrid);
  if (!tier) throw new Error('TextGrid: no "words" tier');
  const words = [];
  for (const m of tier[1].matchAll(/xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"/g)) {
    if (m[3].trim()) words.push({ text: m[3].trim(), start: Number(m[1]), end: Number(m[2]) });
  }
  return words;
}

const key = (text) => text.toLowerCase().replace(/[^a-z']/g, '');

/**
 * Copies aligner times onto reference `words`, shifted by `offset` s, pairing words by edit alignment of lowercase
 * letters; unmatched words stay untimed. Returns the number timed.
 */
export function attachTimes(words, timed, offset = 0) {
  const { ops } = align(words.map((w) => key(w.text)), timed.map((w) => key(w.text)));
  let n = 0;
  for (const o of ops) {
    if (o.op !== 'C') continue;
    words[o.r].start = +(timed[o.h].start + offset).toFixed(3);
    words[o.r].end = +(timed[o.h].end + offset).toFixed(3);
    n++;
  }
  return n;
}
