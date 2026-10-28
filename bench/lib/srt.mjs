// SRT files for SubER (bench/suber.mjs), as plain normalizer tokens, so its WER differs from ours only in alignment.
import { normalizeWords, wordsFromText } from './normalize.mjs';

const MIN_CUE = 0.01; // SRT cues need end > start

const stamp = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** SRT text of cues [{ start, end, text }], in the given order; cues without text are left out. */
export function toSrt(cues) {
  return cues.filter((c) => c.text).map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(Math.max(c.end, c.start + MIN_CUE))}\n${c.text}\n`).join('\n');
}

const text = (words, lang) => normalizeWords(words, lang, 'plain').map((t) => t.t).join(' ');

const join = (...ts) => ts.filter(Boolean).join(' ');

/**
 * One cue per reference segment. An untimed segment joins the cue before it; overlapping segments (AMI crosstalk)
 * merge, or t-WER could put a correct word in the wrong cue. Undefined when no segment has times.
 */
export function refCues(ref, lang) {
  const cues = [];
  for (const s of ref.segments) {
    const t = text(ref.words.filter((w) => w.seg === s.id), lang);
    if (typeof s.start === 'number') cues.push({ start: s.start, end: s.end, text: t });
    else if (cues.length) cues.at(-1).text = join(cues.at(-1).text, t);
    else return undefined;
  }
  if (!cues.length) return undefined;
  const merged = [];
  for (const c of cues.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && c.start < last.end) { last.end = Math.max(last.end, c.end); last.text = join(last.text, c.text); } else merged.push({ ...c });
  }
  return merged;
}

/** One cue per timed word; normalized together as for WER, each token in its source word's cue. */
export function wordCues(words, lang) {
  const timed = words.filter((w) => typeof w.start === 'number');
  const cues = timed.map((w) => ({ start: w.start, end: w.end, text: '' }));
  for (const t of normalizeWords(timed, lang, 'plain')) cues[t.src].text = join(cues[t.src].text, t.t);
  return cues;
}

/** A text without times (gpt-transcribe alone) as one cue over the whole clip, for AS-WER only. */
export function textCue(plain, duration, lang) {
  return [{ start: 0, end: duration, text: text(wordsFromText(plain), lang) }];
}

/** Overtone's captions: the cues of the document's first profile (horizontal), their lines joined. */
export function captionCues(doc, lang) {
  return doc.profiles[0].cues.map((c) => ({ start: c.start, end: c.end, text: text(wordsFromText(c.lines.map((l) => l.text).join(' ')), lang) }));
}
