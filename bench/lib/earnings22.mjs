// Earnings-22 references (Rev's force-aligned .nlp files) and the clip window rule. See DATASETS.md ("Earnings-22").
// .nlp: pipe-separated, one cased token per line, header token|speaker|ts|endTs|punctuation|prepunctuation|….
// Tags (<crosstalk>) and the bare placeholder "inaudible" are dropped; a token whose alignment failed is kept untimed.

/** Parses an .nlp file into words: [{ text, speaker, start?, end? }]. */
export function parseNlp(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const cols = lines[0].split('|');
  const at = (name) => { const i = cols.indexOf(name); if (i < 0) throw new Error(`.nlp: no ${name} column`); return i; };
  const T = at('token'), S = at('speaker'), TS = at('ts'), END = at('endTs'), P = at('punctuation'), PRE = cols.indexOf('prepunctuation');
  const words = [];
  for (const line of lines.slice(1)) {
    const c = line.split('|');
    const token = c[T];
    if (!token || /^<[^>]*>$/.test(token) || /^inaudible$/i.test(token)) continue;
    const w = { text: (PRE >= 0 ? c[PRE] : '') + token + c[P], speaker: `S${c[S]}` };
    if (c[TS] !== '' && c[END] !== '') { w.start = Number(c[TS]); w.end = Number(c[END]); }
    words.push(w);
  }
  return words;
}

const timed = (w) => typeof w.start === 'number';

/**
 * The first window of `length` s from `from` on (in `step`s) whose edges are `edge` s clear of every timed word, with
 * at most a `maxUntimed` share of untimed words and at least `minSpeakers` speakers: { start, end } or undefined.
 */
export function pickWindow(words, { from = 600, length = 240, step = 5, edge = 0.3, maxUntimed = 0.05, minSpeakers = 2 } = {}) {
  const last = words.filter(timed).at(-1);
  if (!last) return undefined;
  for (let start = from; start + length <= last.end; start += step) {
    const end = start + length;
    const near = (t) => words.some((w) => timed(w) && w.start - edge < t && t < w.end + edge);
    if (near(start) || near(end)) continue;
    const span = windowWords(words, start, end);
    if (!span.length) continue;
    const untimed = span.filter((w) => !timed(w)).length;
    if (untimed / span.length > maxUntimed) continue;
    if (new Set(span.map((w) => w.speaker)).size < minSpeakers) continue;
    return { start, end };
  }
  return undefined;
}

/** The words of the window [start, end): from its first to its last timed word that starts inside it. */
export function windowWords(words, start, end) {
  const idx = [];
  words.forEach((w, i) => { if (timed(w) && w.start >= start && w.start < end) idx.push(i); });
  return idx.length ? words.slice(idx[0], idx.at(-1) + 1) : [];
}

/**
 * A window's reference: words shifted to start at 0, and segments (bootstrap units) split at speaker changes and
 * sentence ends.
 */
export function windowRef(words, start, end) {
  const span = windowWords(words, start, end);
  if (span.some((w) => timed(w) && w.end > end)) throw new Error(`a word runs past the window end ${end}`);
  const out = [], segments = [];
  let seg = -1, newSeg = true;
  for (const [i, w] of span.entries()) {
    if (i > 0 && w.speaker !== span[i - 1].speaker) newSeg = true;
    if (newSeg) { seg++; segments.push({ id: seg, speaker: w.speaker }); newSeg = false; }
    const word = { text: w.text, speaker: w.speaker, seg };
    if (timed(w)) { word.start = +(w.start - start).toFixed(3); word.end = +(w.end - start).toFixed(3); }
    out.push(word);
    if (/[.?!…]$/.test(w.text)) newSeg = true;
  }
  for (const s of segments) {
    const ws = out.filter((w) => w.seg === s.id && timed(w));
    if (ws.length) { s.start = ws[0].start; s.end = ws.at(-1).end; }
  }
  return { words: out, segments };
}
