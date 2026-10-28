#!/usr/bin/env node
// Score the caption readability benchmark (definitions: README.md). Reads the live outputs of run.mjs; makes no API
// calls.
//
//   node bench/captions/score.mjs
//
// Systems per clip and profile:
//   overtone       Overtone's cues as stored in the run's .overtone.json; the benchmark runs used --llm-linebreaks (LLM
//                  proposal, checked and repaired by the rules), so this is the optional LLM line cutting
//   deterministic  Overtone's default line cutting: the rules alone at the latest rule set (buildProfile without a
//                  proposal), on the same words
//   naive          greedy fill (see lib/tracks.mjs naiveTrack), on the same words and times
//   elevenlabs     ElevenLabs speech-to-text SRT export (its own transcript), default options
//   elevenlabs7    the same transcript exported with cues up to 7 s and a new cue after 1 s of silence (horizontal)
// Extra Overtone runs (run.mjs --repeat <name>, in runs/<clip>/overtone-<name>/) are scored in a separate table of
// run-to-run variation.
//
// Every track is timed with its system's own word times (Overtone's words for the first three, ElevenLabs' word
// timestamps from its saved response for the SRT exports), so a break at a pause of 0.5 s or more is exempt from
// the rule checks for every system alike (lib/metrics.mjs).
//
// Output (git-ignored): bench/captions/data/results/scores.json (all counts) and results.md (tables).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, pct, poolCounts, raw, ruleCounts, shown } from './lib/metrics.mjs';
import { loadOvertone } from './lib/overtone.mjs';
import { alignTrack, naiveTrack, overtoneTrack, parseSubtitles, timeTrack } from './lib/tracks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const OUT = join(DATA, 'results');
const ot = await loadOvertone();
const { clips } = JSON.parse(readFileSync(join(HERE, 'clips.json'), 'utf8'));

const SYSTEMS = {
  overtone: 'Overtone --llm-linebreaks',
  deterministic: 'Overtone default (rules only)',
  naive: 'Naive greedy',
  elevenlabs: 'ElevenLabs SRT',
  elevenlabs7: 'ElevenLabs SRT, 7 s / 1 s',
};
const PROFILES = ['horizontal', 'vertical'];

const read = (p) => readFileSync(p, 'utf8');
const scores = { date: new Date().toLocaleDateString('sv-SE'), clips: {}, pooled: {}, repeats: {}, minutes: 0 };

/** ElevenLabs' words with their times and speakers, from the saved response of run.mjs. */
function elevenLabsWords(dir) {
  const p = join(dir, 'response.json');
  if (!existsSync(p)) return undefined;
  return JSON.parse(read(p)).words.filter((w) => w.type === 'word').map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker_id }));
}

/** An ElevenLabs SRT export as a track, timed with its words. */
function elevenLabsTrack(file, words, note) {
  const track = parseSubtitles(read(file));
  if (!words) return track;
  const missed = alignTrack(track, words);
  if (missed) note(`${missed} tokens of ${file} not found in its words`);
  return timeTrack(track, words);
}

/** Overtone's own cues and the deterministic layout of the same words, for one profile of a document. */
function overtoneTracks(doc, id) {
  const profile = doc.profiles.find((p) => p.id === id);
  const words = ot.flattenTurns(doc.turns);
  const det = ot.buildProfile(words, { id, rules: profile.rules }, { language: doc.language, glossary: [], duration: doc.duration }).profile;
  return { overtone: overtoneTrack(profile, words), deterministic: overtoneTrack(det, words) };
}

/** Cues of track a that track b has too (same lines). */
function sameCues(a, b) {
  const key = (c) => c.lines.map((l) => l.text).join(' / ');
  const set = new Set(b.cues.map(key));
  return { n: a.cues.filter((c) => set.has(key(c))).length, of: a.cues.length };
}

for (const clip of clips) {
  const runs = join(DATA, 'runs', clip.id);
  const docPath = join(runs, 'overtone', 'audio.overtone.json');
  if (!existsSync(docPath)) { console.error(`warning: ${clip.id}: no Overtone output; skipped (run run.mjs first)`); continue; }
  const doc = JSON.parse(read(docPath));
  const words = ot.flattenTurns(doc.turns);
  const lang = doc.language;
  const entry = { language: lang, duration: doc.duration, profiles: {}, notes: [] };
  scores.minutes += doc.duration / 60;
  const elWords = elevenLabsWords(join(runs, 'elevenlabs'));
  for (const id of PROFILES) {
    const profile = doc.profiles.find((p) => p.id === id);
    const rules = profile.rules;
    const tracks = {
      ...overtoneTracks(doc, id),
      naive: naiveTrack(words, { maxChars: rules.maxCharsPerLine, maxLines: rules.maxLines, maxDuration: rules.maxDuration ?? 7, maxPause: 1 }),
    };
    const note = (msg) => { entry.notes.push(msg); console.error(`warning: ${clip.id}: ${msg}`); };
    const el = join(runs, 'elevenlabs', `${id}.srt`);
    if (existsSync(el)) tracks.elevenlabs = elevenLabsTrack(el, elWords, note);
    const el7 = join(runs, 'elevenlabs', `${id}-7s.srt`);
    if (existsSync(el7)) tracks.elevenlabs7 = elevenLabsTrack(el7, elWords, note);
    const out = {};
    for (const [sys, track] of Object.entries(tracks)) {
      out[sys] = { rules: ruleCounts(track, { lang, maxChars: rules.maxCharsPerLine, maxLines: rules.maxLines, ot }) };
    }
    entry.profiles[id] = { rules, systems: out };
  }
  // how much the LLM changed: cues of the Overtone track that the deterministic track has too (same lines)
  entry.cuesIdenticalToDeterministic = Object.fromEntries(PROFILES.map((id) => {
    const t = overtoneTracks(doc, id);
    return [id, sameCues(t.overtone, t.deterministic)];
  }));
  scores.clips[clip.id] = entry;

  // extra runs of the LLM steps (run.mjs --repeat <name>), both profiles
  const runOf = (name, d) => {
    scores.repeats[name] ??= {};
    scores.repeats[name][clip.id] = Object.fromEntries(PROFILES.map((id) => {
      const t = overtoneTracks(d, id);
      const rules = d.profiles.find((p) => p.id === id).rules;
      const score = (track) => ({ rules: ruleCounts(track, { lang, maxChars: rules.maxCharsPerLine, maxLines: rules.maxLines, ot }) });
      return [id, { overtone: score(t.overtone), deterministic: score(t.deterministic), identical: sameCues(t.overtone, t.deterministic) }];
    }));
  };
  runOf('run1', doc);
  for (const dir of readdirSync(runs).filter((d) => d.startsWith('overtone-')).sort()) {
    const p = join(runs, dir, 'audio.overtone.json');
    if (existsSync(p)) runOf(dir.slice('overtone-'.length), JSON.parse(read(p)));
  }
}

// pool clips (counts add up)
for (const id of PROFILES) {
  scores.pooled[id] = {};
  for (const sys of Object.keys(SYSTEMS)) {
    const list = Object.values(scores.clips).map((c) => c.profiles[id].systems[sys]).filter(Boolean);
    if (!list.length) continue;
    scores.pooled[id][sys] = { rules: poolCounts(list.map((x) => x.rules)) };
  }
}

// ---- tables
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const P = (x) => f1(pct(x));

function breakTable(systems) {
  const rows = ['| System | Breaks | Bad line ends¹ | Subject-pronoun ends | Adjective + noun split | Name/number split | Sentence starts at line end² | Sentence end carried over³ |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [sys, s] of Object.entries(systems)) {
    const r = s.rules;
    rows.push(`| ${SYSTEMS[sys]} | ${r.breaks.of} | ${P(r.badEnd)} | ${P(r.pronounEnd)} | ${P(r.adjNounSplit)} | ${P(r.groupSplit)} | ${P(r.sentenceStartAtEnd)} | ${P(r.sentenceEndCarried)} |`);
  }
  return rows.join('\n');
}

function layoutTable(systems) {
  const rows = ['| System | Cues | Two-line cues | Lone-word lines | 1–3-word cues | …not a whole sentence | Lines over limit | Cues over 2 lines | Unbalanced two-line cues⁴ | Median bottom/top |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [sys, s] of Object.entries(systems)) {
    const r = s.rules;
    rows.push(`| ${SYSTEMS[sys]} | ${r.cues.of} | ${P(r.twoLineCues)} | ${P(r.loneWordLines)} | ${P(r.shortCues)} | ${P(r.shortFragmentCues)} | ${P(r.overLimit)} | ${P(r.overTwoLines)} | ${P(r.unbalanced)} | ${f2(median(r.balance))} |`);
  }
  return rows.join('\n');
}

function timingTable(systems) {
  const rows = ['| System | Median cps | Cues > 17 cps | Cues > 20 cps | Cues < 1 s | Cues > 7 s |', '|---|---:|---:|---:|---:|---:|'];
  for (const [sys, s] of Object.entries(systems)) {
    const r = s.rules;
    rows.push(`| ${SYSTEMS[sys]} | ${f1(median(r.cps))} | ${P(r.cps17)} | ${P(r.cps20)} | ${P(r.under1s)} | ${P(r.over7s)} |`);
  }
  return rows.join('\n');
}

function pauseTable(systems, minutes) {
  const rows = ['| System | Pauses 0.5–1.5 s | Hesitations shown⁵ | as cue break | as line break | Hidden per minute | Breaks at hesitations⁶ | Waived: bad line ends | sentence edge | lone-word lines | 1–3-word cues | unbalanced |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [sys, s] of Object.entries(systems)) {
    const r = s.rules;
    const p = r.pauses;
    const w = r.waived;
    if (!r.timed) { rows.push(`| ${SYSTEMS[sys]} | – | – | – | – | – | – | – | – | – | – | – |`); continue; }
    rows.push(`| ${SYSTEMS[sys]} | ${p.n} | ${P(shown(p))} | ${P({ n: p.cue, of: p.n })} | ${P({ n: p.line, of: p.n })} | ${f2(p.hidden / minutes)} | ${P(r.hesitationBreaks)} | ${w.badEnd} | ${w.sentenceStartAtEnd + w.sentenceEndCarried} | ${w.loneWordLines} | ${w.shortFragmentCues} | ${w.unbalanced} |`);
  }
  return rows.join('\n');
}

const NOTES = [
  'Breaks followed by a pause of 0.5 s or more (each system\'s own word times) are not counted in the rule checks; the "Waived" columns count them (README.md, "Pauses").',
  '¹ Line or cue ends on an article, preposition, possessive, auxiliary or coordinating conjunction (no punctuation after it), as a share of all breaks.',
  '² A new sentence starts in the last one or two words before a break. ³ The last one or two words of a sentence are carried over a break.',
  '⁴ The shorter line is less than half as long as the longer one.',
  '⁵ Same-speaker pauses of 0.5–1.5 s that fall on a cue or line break. ⁶ Breaks followed by a pause of 0.5 s or more, % of all breaks.',
  'All values are % unless noted. Definitions: README.md.',
].join('\n');

const md = [`# Caption readability benchmark: results`, '', `Scored ${scores.date.slice(0, 10)}. Generated by score.mjs; see RESULTS.md for the discussion.`, ''];
const section = (title, systems, minutes) => {
  md.push(`### ${title}`, '', '**Breaks**', '', breakTable(systems), '', '**Layout**', '', layoutTable(systems), '', '**Timing**', '', timingTable(systems), '', '**Pauses**', '', pauseTable(systems, minutes), '');
};
for (const [id, label] of [['horizontal', 'Horizontal (42 × 2)'], ['vertical', 'Vertical (22 × 2)']]) {
  md.push(`## ${label}`, '');
  section('All clips pooled', scores.pooled[id], scores.minutes);
  for (const [clipId, c] of Object.entries(scores.clips)) section(clipId, c.profiles[id].systems, c.duration / 60);
}
md.push('## Run-to-run variation of the LLM (all clips pooled)', '',
  'run1 is the main run; other runs repeat only the LLM steps on the cached transcription and timing (run.mjs --repeat). The deterministic layout is recomputed on each run\'s words (the LLM corrections can change a few words).', '');
for (const id of PROFILES) {
  md.push(`**${id}**`, '',
    '| Run | System | Cues | Bad line ends | Sentence starts at line end | Sentence end carried over | Lone-word lines | 1–3-word cues, not a sentence | Unbalanced two-line cues | Cues > 20 cps | Cues < 1 s | Hesitations shown | Bad line ends, no pause exemption | Cues identical to deterministic |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, byClip] of Object.entries(scores.repeats)) {
    if (Object.keys(byClip).length !== Object.keys(scores.clips).length) continue;
    const list = Object.values(byClip).map((x) => x[id]);
    const identical = list.reduce((t, x) => ({ n: t.n + x.identical.n, of: t.of + x.identical.of }), { n: 0, of: 0 });
    for (const sys of ['overtone', 'deterministic']) {
      const r = poolCounts(list.map((x) => x[sys].rules));
      md.push(`| ${name} | ${SYSTEMS[sys]} | ${r.cues.of} | ${P(r.badEnd)} | ${P(r.sentenceStartAtEnd)} | ${P(r.sentenceEndCarried)} | ${P(r.loneWordLines)} | ${P(r.shortFragmentCues)} | ${P(r.unbalanced)} | ${P(r.cps20)} | ${P(r.under1s)} | ${P(shown(r.pauses))} | ${P(raw(r, 'badEnd'))} | ${sys === 'overtone' ? P(identical) : ''} |`);
    }
  }
  md.push('');
}
md.push('## Overtone cues identical to the deterministic layout', '', '| Clip | Horizontal | Vertical |', '|---|---:|---:|');
for (const [id, c] of Object.entries(scores.clips)) md.push(`| ${id} | ${PROFILES.map((p) => `${c.cuesIdenticalToDeterministic[p].n} of ${c.cuesIdenticalToDeterministic[p].of}`).join(' | ')} |`);
md.push('', NOTES, '');

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'scores.json'), `${JSON.stringify(scores, null, 1)}\n`);
writeFileSync(join(OUT, 'results.md'), md.join('\n'));
console.error(`wrote ${join(OUT, 'results.md')} and scores.json`);
