// Caption tracks: parse SRT, read Overtone cues, build the naive baseline, and flatten a track into a word sequence
// with the breaks between its words.
//
// A track is { cues: [{ start, end, lines: [{ text, words: [string] }] }] }. `text` is the line as displayed (its
// length is what the character limit applies to); `words` are its whitespace tokens that hold a letter or digit
// (a lone "-", ">>" or "..." is not a word).
//
// A timed track (timeTrack) also knows the system's own word times: each line gets `range` (its first and last
// index in the system's word list) and `after` ({ gap, same }: the silence after its last word and whether the
// same speaker goes on), and the track gets `pauses`: every same-speaker silence between two words, with the
// break it falls on. The pause rules of the metrics need them.

const TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/;
const seconds = (t) => { const m = TIME.exec(t); return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000; };

/** Whitespace tokens of a line that hold a letter or digit. */
export const wordsOf = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));

function makeLine(raw) {
  const text = raw.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
  return { text, words: wordsOf(text) };
}

/** Parse SRT (or WebVTT) text into a track. Cues without words are dropped. */
export function parseSubtitles(src) {
  const cues = [];
  for (const block of src.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const rows = block.split('\n');
    const at = rows.findIndex((r) => r.includes('-->'));
    if (at < 0) continue;
    const [a, b] = rows[at].split('-->');
    const lines = rows.slice(at + 1).map(makeLine).filter((l) => l.words.length > 0);
    if (lines.length) cues.push({ start: seconds(a), end: seconds(b), lines });
  }
  return { cues };
}

/**
 * The cues of one profile of an .overtone.json document as a track. With `words` (the document's words, flattened
 * with their speakers), the track is timed with them.
 */
export function overtoneTrack(profile, words) {
  const track = { cues: profile.cues.map((c) => ({ start: c.start, end: c.end, lines: c.lines.map((l) => ({ ...makeLine(l.text), range: l.words })) })) };
  return words ? timeTrack(track, words) : track;
}

/**
 * Naive baseline, typical of auto-captioning tools: fill lines greedily up to maxChars, at most maxLines lines per
 * cue; start a new cue when the next word would not fit, when the cue would last longer than maxDuration, or after
 * a pause longer than maxPause. Speakers are ignored. A cue lasts from its first word's start to its last word's end.
 * `words` = [{ text, start, end }].
 */
export function naiveTrack(words, { maxChars, maxLines = 2, maxDuration = 7, maxPause = 1 }) {
  const cues = [];
  let cue = null;
  const flush = () => { if (cue) cues.push({ start: cue.start, end: cue.end, lines: cue.lines.map((l) => ({ ...makeLine(l.text), range: [l.first, l.last] })) }); cue = null; };
  const line = (k) => ({ text: words[k].text, first: k, last: k });
  words.forEach((w, k) => {
    const prev = words[k - 1];
    if (cue && (w.start - prev.end > maxPause || w.end - cue.start > maxDuration)) flush();
    if (cue) {
      const last = cue.lines[cue.lines.length - 1];
      if (last.text.length + 1 + w.text.length <= maxChars) { last.text += ` ${w.text}`; last.last = k; }
      else if (cue.lines.length < maxLines) cue.lines.push(line(k));
      else { flush(); }
    }
    if (!cue) cue = { start: w.start, end: w.end, lines: [line(k)] };
    else cue.end = w.end;
  });
  flush();
  return timeTrack({ cues }, words);
}

/** Letters and digits only, lowercase: the key for matching a displayed token to a word of the system. */
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Find each line's `range` in a system's own word list (for a track parsed from SRT): its tokens are matched to
 * the words in order by their letters and digits; a token may span several words or a word several tokens, and
 * words without letters or digits are skipped. Returns the number of tokens that could not be matched (0 when the
 * SRT text is the word list, as for ElevenLabs).
 */
export function alignTrack(track, words) {
  const keys = words.map((w) => norm(w.text));
  let k = 0;
  let missed = 0;
  for (const cue of track.cues) {
    for (const line of cue.lines) {
      let first = -1;
      let last = -1;
      for (const token of line.words) {
        let want = norm(token);
        while (k < keys.length && !keys[k]) k++;
        if (!want) continue;
        // one token over several words ("e-mail" vs "e" "mail"), or several tokens over one word
        let j = k;
        let have = '';
        while (j < keys.length && have.length < want.length && want.startsWith(have + keys[j])) have += keys[j++];
        if (have === want && j > k) { if (first < 0) first = k; last = j - 1; k = j; continue; }
        if (k < keys.length && keys[k].startsWith(want)) {
          if (first < 0) first = k;
          last = k;
          keys[k] = keys[k].slice(want.length);
          if (!keys[k]) k++;
          continue;
        }
        missed++;
      }
      line.range = [first, last];
    }
  }
  return missed;
}

/**
 * Time a track with its system's own words ({ text, start, end, speaker }; every line has `range`): see the top
 * of this file. A gap counts as a pause only between two words of the same speaker.
 */
export function timeTrack(track, words) {
  const brk = new Map(); // index of a line's last word -> 'line' | 'cue'
  for (const cue of track.cues) {
    cue.lines.forEach((line, l) => {
      const b = line.range[1];
      const next = b >= 0 ? words[b + 1] : undefined;
      line.after = next ? { gap: next.start - words[b].end, same: next.speaker === words[b].speaker } : { gap: Infinity, same: false };
      if (b >= 0) brk.set(b, l === cue.lines.length - 1 ? 'cue' : 'line');
    });
  }
  track.pauses = [];
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i + 1].speaker !== words[i].speaker) continue;
    const gap = words[i + 1].start - words[i].end;
    if (gap > 0) track.pauses.push({ gap, brk: brk.get(i) ?? null });
  }
  return track;
}

/**
 * Flatten a track: words[k] = { text, cue, line, lineStart, brk, after } where brk is the break after the word:
 * 'line' (a new line of the same cue follows), 'cue' (a new cue follows) or null (the last word); `after` is the
 * line's `after` on its last word (timed tracks only).
 */
export function flatten(track) {
  const words = [];
  track.cues.forEach((cue, c) => {
    cue.lines.forEach((line, l) => {
      const lineStart = words.length;
      line.words.forEach((text, k) => {
        const last = k === line.words.length - 1;
        words.push({ text, cue: c, line: l, lineStart, brk: last ? (l === cue.lines.length - 1 ? 'cue' : 'line') : null, ...(last && line.after ? { after: line.after } : {}) });
      });
    });
  });
  if (words.length) words[words.length - 1].brk = null;
  return words;
}
