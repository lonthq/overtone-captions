import type { Lang } from '../lang/index.js';
import { normalizeWords } from '../text/normalize.js';

/** One comparison piece ("can't" → "can", "not") and the index of the display word it came from. */
export interface Piece { text: string; word: number }

export function piecesOf(displayWords: readonly string[], lang: Lang, alternative = false): Piece[] {
  return normalizeWords(displayWords, lang, { alternative }).flatMap((w, word) => (w.key === '' ? [] : w.key.split(' ').map((text) => ({ text, word }))));
}

/** Scripts written without spaces between words: a name there is a run of characters, not a word. */
export const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Pieces with each spaceless-script character split off; other runs stay whole ("iphoneを買った" → "iphone", "を",
 * "買", "っ", "た"). A display word there is a whole phrase ("我去学校"), so only per character can a comparison see
 * what an edit changes ("我不去学校" adds "不").
 */
export function spacelessPieces(ps: readonly Piece[]): Piece[] {
  return ps.flatMap((p) => {
    if (!SPACELESS.test(p.text)) return [p];
    const out: Piece[] = [];
    let run = '';
    for (const { segment } of graphemes.segment(p.text)) {
      if (!SPACELESS.test(segment)) { run += segment; continue; }
      if (run) { out.push({ text: run, word: p.word }); run = ''; }
      out.push({ text: segment, word: p.word });
    }
    if (run) out.push({ text: run, word: p.word });
    return out;
  });
}

export const texts = (ps: readonly Piece[]): string[] => ps.map((p) => p.text);
export const squash = (ps: readonly Piece[]): string => texts(ps).join('');

/** How many leading and trailing pieces a and b share (they never overlap). */
export function sharedEnds(a: readonly Piece[], b: readonly Piece[]): [number, number] {
  let head = 0;
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].text === b[b.length - 1 - tail].text) tail++;
  return [head, tail];
}
