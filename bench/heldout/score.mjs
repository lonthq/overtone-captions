#!/usr/bin/env node
// Scores the held-out runs (run.mjs) with the caption metrics of bench/captions (definitions: ../captions/README.md),
// each system on its own words and times. No API calls. Word error rates need the reference transcripts
// (PROTOCOL.md, "References") and are not computed here yet.
//
//   node bench/heldout/score.mjs
//
// Output (git-ignored): bench/heldout/data/results/scores.json and results.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, pct, poolCounts, ruleCounts, shown } from '../captions/lib/metrics.mjs';
import { loadOvertone } from '../captions/lib/overtone.mjs';
import { alignTrack, naiveTrack, overtoneTrack, parseSubtitles, timeTrack } from '../captions/lib/tracks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const OUT = join(DATA, 'results');
const ot = await loadOvertone();
const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));

const SYSTEMS = {
  E: 'E Overtone default',
  F: 'F Overtone with ElevenLabs',
  L: "E's words, lines filled to the limit",
  A: 'A whisper-1, lines filled to the limit',
  B: 'B ElevenLabs SRT export',
  C: 'C Azure Speech, lines filled to the limit',
  D: "D Overtone recut of B's SRT",
};
const PROFILES = ['horizontal', 'vertical'];
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** whisper-1's words carry no punctuation; take each word's spelling from the punctuated text, in order. */
function whisperWords(body) {
  const tokens = body.text.split(/\s+/).filter(Boolean);
  let k = 0;
  return body.words.map((w) => {
    let text = w.word;
    for (let j = k; j < Math.min(k + 4, tokens.length); j++) {
      if (norm(tokens[j]) === norm(w.word)) { text = tokens[j]; k = j + 1; break; }
    }
    return { text, start: w.start, end: w.end };
  });
}

const elevenLabsWords = (body) => body.words.filter((w) => w.type === 'word').map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker_id }));

/**
 * Azure Speech's words from E's request cache: the folder is named by the SHA-256 of the clip's audio, and the
 * whole-file Azure request is the one sent with that audio (the others are re-listened snippets).
 */
function azureWords(clipId) {
  const sha = createHash('sha256').update(readFileSync(join(DATA, 'audio', `${clipId}.wav`))).digest('hex');
  const requests = join(DATA, 'cache', sha.slice(0, 16), 'requests');
  if (!existsSync(requests)) return undefined;
  for (const f of readdirSync(requests).filter((n) => n.startsWith('timing-'))) {
    const r = json(join(requests, f));
    if (r.provider.startsWith('azure-speech') && r.request.audio === sha && r.response) return r.response.words;
  }
  return undefined;
}

/** An SRT as a track, timed with the given words (ElevenLabs' for B and D). */
function srtTrack(file, words, note) {
  const track = parseSubtitles(read(file));
  const missed = alignTrack(track, words);
  if (missed) note(`${missed} tokens of ${file.slice(DATA.length + 1)} not found in the words`);
  return timeTrack(track, words);
}

const { clips } = json(join(HERE, 'clips.json'));
const scores = { date: new Date().toLocaleDateString('sv-SE'), clips: {}, pooled: {}, minutes: 0 };
for (const clip of clips.filter((c) => c.excerpt)) {
  const runs = join(DATA, 'runs', clip.id);
  const docE = join(runs, 'E', `${clip.id}.overtone.json`);
  if (!existsSync(docE)) { console.error(`warning: ${clip.id}: no E output; skipped`); continue; }
  const e = json(docE);
  const entry = { language: clip.language, duration: e.duration, profiles: {}, notes: [] };
  const note = (msg) => { entry.notes.push(msg); console.error(`warning: ${clip.id}: ${msg}`); };
  scores.minutes += e.duration / 60;
  const docF = join(runs, 'F', `${clip.id}.overtone.json`);
  const f = existsSync(docF) ? json(docF) : undefined;
  const wordsA = existsSync(join(runs, 'A', 'response.json')) ? whisperWords(json(join(runs, 'A', 'response.json'))) : undefined;
  const wordsB = existsSync(join(runs, 'B', 'response.json')) ? elevenLabsWords(json(join(runs, 'B', 'response.json'))) : undefined;
  const wordsC = azureWords(clip.id);
  if (!wordsC) note('no Azure words in the cache; C skipped');
  for (const id of PROFILES) {
    const rules = e.profiles.find((p) => p.id === id).rules;
    const fill = (words) => naiveTrack(words, { maxChars: rules.maxCharsPerLine, maxLines: rules.maxLines, maxDuration: rules.maxDuration ?? 7, maxPause: 1 });
    const wordsE = ot.flattenTurns(e.turns);
    const tracks = { E: overtoneTrack(e.profiles.find((p) => p.id === id), wordsE), L: fill(wordsE) };
    if (f) tracks.F = overtoneTrack(f.profiles.find((p) => p.id === id), ot.flattenTurns(f.turns));
    if (wordsA) tracks.A = fill(wordsA);
    if (wordsB && existsSync(join(runs, 'B', `${id}.srt`))) tracks.B = srtTrack(join(runs, 'B', `${id}.srt`), wordsB, note);
    if (wordsC) tracks.C = fill(wordsC);
    if (wordsB && existsSync(join(runs, 'D', `horizontal.${id}.srt`))) tracks.D = srtTrack(join(runs, 'D', `horizontal.${id}.srt`), wordsB, note);
    const systems = {};
    for (const sys of Object.keys(SYSTEMS)) {
      if (tracks[sys]) systems[sys] = { rules: ruleCounts(tracks[sys], { lang: clip.language, maxChars: rules.maxCharsPerLine, maxLines: rules.maxLines, ot }) };
    }
    entry.profiles[id] = { rules, systems };
  }
  // cost and time of the runs that made a request
  entry.runs = Object.fromEntries(['A', 'B', 'E', 'F'].filter((s) => existsSync(join(runs, s, 'run.json'))).map((s) => [s, json(join(runs, s, 'run.json'))]));
  scores.clips[clip.id] = entry;
}
for (const id of PROFILES) {
  scores.pooled[id] = {};
  for (const sys of Object.keys(SYSTEMS)) {
    const list = Object.values(scores.clips).map((c) => c.profiles[id].systems[sys]).filter(Boolean);
    if (list.length === Object.keys(scores.clips).length) scores.pooled[id][sys] = { rules: poolCounts(list.map((x) => x.rules)) };
  }
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const P = (x) => f1(pct(x));
function table(systems) {
  const rows = ['| System | Cues | Bad line ends¹ | Sentence starts at line end | Sentence end carried over | Lone-word lines | 1–3-word fragments | Unbalanced two-line cues | Hesitations shown² | Cues > 17 cps | Median cps |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [sys, s] of Object.entries(systems)) {
    const r = s.rules;
    rows.push(`| ${SYSTEMS[sys]} | ${r.cues.of} | ${P(r.badEnd)} | ${P(r.sentenceStartAtEnd)} | ${P(r.sentenceEndCarried)} | ${P(r.loneWordLines)} | ${P(r.shortFragmentCues)} | ${P(r.unbalanced)} | ${r.timed ? P(shown(r.pauses)) : '–'} | ${P(r.cps17)} | ${f1(median(r.cps))} |`);
  }
  return rows.join('\n');
}
const md = ['# Held-out study: caption metrics', '', `Scored ${scores.date}, ${f1(scores.minutes)} audio minutes. Generated by score.mjs.`, ''];
for (const [id, label] of [['horizontal', 'Horizontal (42 × 2)'], ['vertical', 'Vertical (22 × 2)']]) {
  md.push(`## ${label}`, '', '### All clips pooled', '', table(scores.pooled[id]), '');
  for (const [clipId, c] of Object.entries(scores.clips)) md.push(`### ${clipId}`, '', table(c.profiles[id].systems), '');
}
md.push('¹ Line or caption ends on an article, preposition, possessive, auxiliary or conjunction without punctuation, % of breaks; breaks followed by a pause of 0.5 s or more are not counted. ² Same-speaker pauses of 0.5–1.5 s shown as a cue or line break. All values are % unless noted.', '');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'scores.json'), `${JSON.stringify(scores, null, 1)}\n`);
writeFileSync(join(OUT, 'results.md'), md.join('\n'));
console.error(`wrote ${join(OUT, 'results.md')} and scores.json`);
