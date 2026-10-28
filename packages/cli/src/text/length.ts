// How long a caption line is for a reader: the characters they see, not JavaScript's UTF-16 code units.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Latin text without combining marks (English, Dutch, German, French as usually typed): one code unit per character. */
const SIMPLE = /^[ -˿]*$/;

/**
 * Characters as a reader counts them (grapheme clusters): "é" typed as "e" plus a combining accent, an emoji with a
 * skin tone and a flag are one character each, where `.length` counts 2 to 4.
 */
export function displayLength(text: string): number {
  return SIMPLE.test(text) ? text.length : [...graphemes.segment(text)].length;
}
