import {
  flattenWords,
  speakerLabel,
  STYLE_CLASSES,
  type Cue,
  type FlatWord,
  type OvertoneDocument,
  type Profile,
  type TimeWindow,
} from 'overtone-format';
import type { SpeakerDisplay } from '../types.js';

export interface RenderOptions {
  speakers?: SpeakerDisplay; // default 'never'
}


const wordCache = new WeakMap<OvertoneDocument, FlatWord[]>();

/** The document's flattened words, computed once per document object (long transcripts have 10k+ words). */
export function wordsOf(doc: OvertoneDocument): FlatWord[] {
  let words = wordCache.get(doc);
  if (!words) {
    words = flattenWords(doc);
    wordCache.set(doc, words);
  }
  return words;
}

/**
 * Whether cue `index` gets a speaker label. With 'change', the first cue (or the first in the `window`) counts as a
 * change when the document has more than one speaker.
 */
export function shouldShowSpeaker(
  doc: OvertoneDocument,
  cues: readonly Cue[],
  index: number,
  mode: SpeakerDisplay,
  window?: TimeWindow,
): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  const previous = cues[index - 1];
  // A previous cue that ends at or before the window start is not shown (see clipCuesToWindow).
  if (!previous || (window && previous.end <= window.start)) return doc.speakers.length > 1;
  return previous.speaker !== cues[index].speaker;
}

/**
 * Builds one cue: `.ot-cue` > optional `.ot-speaker`, then `.ot-line` > `.ot-word` > `.ot-text`. Needs no player
 * (the style gallery uses it too).
 */
export function renderCue(doc: OvertoneDocument, profile: Profile, cueIndex: number, options: RenderOptions = {}): HTMLElement {
  const cue = profile.cues[cueIndex];
  const words = wordsOf(doc);
  const cueEl = document.createElement('div');
  cueEl.className = 'ot-cue';
  cueEl.dataset.speaker = cue.speaker;
  // Right CJK glyphs and screen-reader voice.
  if (doc.language && doc.language !== 'und') cueEl.lang = doc.language;

  if (shouldShowSpeaker(doc, profile.cues, cueIndex, options.speakers ?? 'never', profile.window)) {
    const label = document.createElement('div');
    label.className = 'ot-speaker';
    label.textContent = speakerLabel(doc, cue.speaker);
    cueEl.append(label);
  }

  for (const line of cue.lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'ot-line';
    // Arabic and Hebrew lines run right to left.
    lineEl.dir = 'auto';
    const lineWords = words.slice(line.words[0], line.words[1] + 1);
    const isKey = (word: FlatWord | undefined) => Boolean(word?.classes?.includes('key'));
    lineWords.forEach((word, i) => {
      const span = document.createElement('span');
      span.className = ['ot-word', ...(word.classes ?? []).filter((cls) => STYLE_CLASSES.includes(cls)).map((cls) => `ot-${cls}`)].join(' ');
      span.dataset.start = String(word.start);
      span.dataset.end = String(word.end);
      span.style.setProperty('--ot-turn', String(turnOf(word.index)));
      // `.ot-text` lets a pack move the text alone. Between two key words the space goes inside the first span
      // (`data-joined`), so their highlight is one box without gaps.
      const text = document.createElement('span');
      text.className = 'ot-text';
      text.textContent = word.text;
      span.append(text);
      const joined = isKey(word) && isKey(lineWords[i + 1]);
      if (joined) {
        span.append(' ');
        span.dataset.joined = '';
      }
      lineEl.append(span);
      if (i < lineWords.length - 1 && !joined) lineEl.append(' ');
    });
    cueEl.append(lineEl);
  }
  return cueEl;
}

/** The side a word tilts (`--ot-turn`): 1 or -1, pseudo-random but fixed per word index, so player and burn agree. */
export function turnOf(index: number): 1 | -1 {
  // MurmurHash3 finalizer: neighboring indices get unrelated bits.
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h & 1) === 0 ? 1 : -1;
}

/** Sets `ot-active` on the words being spoken at `time` (used by the social theme's pop). */
export function updateActiveWords(cueEl: HTMLElement, time: number): void {
  for (const span of cueEl.querySelectorAll<HTMLElement>('.ot-word')) {
    const active = time >= Number(span.dataset.start) && time < Number(span.dataset.end);
    span.classList.toggle('ot-active', active);
  }
}
