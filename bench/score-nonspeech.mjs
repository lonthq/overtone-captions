#!/usr/bin/env node
// Scores the non-speech set (clips.nonspeech.json) from run.mjs output. No API calls.
//
//   node bench/score-nonspeech.mjs --runs <dir>   writes <dir>/nonspeech.json and <dir>/nonspeech.md, prints the tables
//   --clips <file>     optional: clip selection file (default bench/clips.nonspeech.json)
//   --speech <dir>     optional: runs of the official set, for the WER of fleurs-nl on its own (default bench/runs)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hallucinationRate, scoreNonSpeechClip, SYSTEMS } from './lib/nonspeech.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const RUNS = resolve(flag('--runs') ?? join(BENCH, 'runs'));
const SPEECH = resolve(flag('--speech') ?? join(BENCH, 'runs'));
const { clips } = JSON.parse(readFileSync(resolve(flag('--clips') ?? join(BENCH, 'clips.nonspeech.json')), 'utf8'));
const LABEL = { overtone: 'Overtone', textOnly: 'gpt-transcribe alone', azure: 'Azure Speech alone', scribe: 'ElevenLabs Scribe alone' };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const scored = [];
for (const clip of clips) {
  const refPath = join(BENCH, 'data', clip.id, 'ref.json'), hypPath = join(RUNS, clip.id, 'hyp.json');
  if (!existsSync(refPath) || !existsSync(hypPath)) { console.error(`skip ${clip.id}: missing ${existsSync(refPath) ? 'hyp.json (run.mjs)' : 'ref.json (fetch.mjs)'}`); continue; }
  const ref = read(refPath), hyp = read(hypPath);
  const entry = { clip: clip.id, kind: clip.kind, nonSpeech: !!ref.nonSpeech, minutes: ref.duration / 60, noWords: !!hyp.noWords, scores: scoreNonSpeechClip(ref, hyp, clip.language) };
  // The speech part on its own, from the official set.
  const alone = clip.parts?.find((p) => !p.start && p.end === undefined)?.clip;
  if (alone && existsSync(join(SPEECH, alone, 'hyp.json'))) {
    const aloneRef = read(join(BENCH, 'data', alone, 'ref.json'));
    entry.alone = { clip: alone, scores: scoreNonSpeechClip({ ...aloneRef, speechStart: 0 }, read(join(SPEECH, alone, 'hyp.json')), clip.language) };
  }
  scored.push(entry);
}
// Systems every clip has (Scribe only when every run had the second hearing).
const systems = SYSTEMS.filter((sys) => scored.every((s) => s.scores[sys]));

const pct = (x) => (x === undefined || Number.isNaN(x) ? '–' : `${(100 * x).toFixed(1)}%`);
const L = ['## Non-speech set', '', '### Words output on audio without speech', '', `| Clip | Minutes | ${systems.map((s) => LABEL[s]).join(' | ')} |`, `|---|---:|${systems.map(() => '---:').join('|')}|`];
for (const s of scored.filter((x) => x.nonSpeech)) L.push(`| ${s.clip}${s.noWords ? ' (nothing written)' : ''} | ${s.minutes.toFixed(1)} | ${systems.map((sys) => `${s.scores[sys].words} (${s.scores[sys].perMinute.toFixed(1)}/min)`).join(' | ')} |`);
const rate = hallucinationRate(scored);
L.push(`| **Clips with any words** | | ${systems.map((sys) => `**${rate[sys].withWords} of ${rate[sys].clips}**`).join(' | ')} |`);
const after = scored.filter((x) => !x.nonSpeech);
if (after.length) {
  L.push('', '### Music, then speech', '', '| Clip | System | Words before the speech | WER of the speech | WER of the speech clip alone |', '|---|---|---:|---:|---:|');
  for (const s of after) for (const sys of systems) L.push(`| ${s.clip} | ${LABEL[sys]} | ${s.scores[sys].wordsBefore ?? 'n/a (no times)'} | ${pct(s.scores[sys].wer)} | ${s.alone?.scores[sys] ? `${pct(s.alone.scores[sys].wer)} (${s.alone.clip})` : '–'} |`);
}
writeFileSync(join(RUNS, 'nonspeech.json'), JSON.stringify({ scored, rate }, null, 1) + '\n');
writeFileSync(join(RUNS, 'nonspeech.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
