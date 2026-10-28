#!/usr/bin/env node
// t-WER and AS-WER of each system with AppTek's SubER tool (subtitle-edit-rate, Apache-2.0). No API calls.
// See RESULTS.md ("t-WER and AS-WER").
//
//   node bench/suber.mjs --runs <dir>    writes <dir>/<clip>/suber/*.srt, <dir>/suber.json and <dir>/suber.md
//   --clips <file>     optional: clip selection file (default bench/clips.json)
//
// Needs the tool in bench/data/.venv (git-ignored, about 80 MB):
//   python3 -m venv bench/data/.venv && bench/data/.venv/bin/pip install subtitle-edit-rate
//
// - t-WER: words go into reference cues by time (Cherry et al.), so right text at the wrong time is an error.
// - AS-WER: re-segments by edit distance, ignoring time; a cross-check of score.mjs's WER.
// Both score the benchmark normalizer's plain tokens.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captionCues, refCues, textCue, toSrt, wordCues } from './lib/srt.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const RUNS = resolve(flag('--runs') ?? join(BENCH, 'runs'));
const { clips } = JSON.parse(readFileSync(resolve(flag('--clips') ?? join(BENCH, 'clips.json')), 'utf8'));
const SUBER = join(BENCH, 'data/.venv/bin/suber');
if (!existsSync(SUBER)) { console.error('error: the SubER tool is missing; see the header of bench/suber.mjs'); process.exit(1); }
const LABEL = { captions: 'Overtone captions (horizontal cues)', overtone: 'Overtone words', textOnly: 'gpt-transcribe alone', azure: 'Azure Speech alone', scribe: 'ElevenLabs Scribe alone' };

const suber = (hyp, ref, metrics) => JSON.parse(execFileSync(SUBER, ['-H', hyp, '-R', ref, '--metrics', ...metrics], { encoding: 'utf8' }));

const results = [];
for (const clip of clips) {
  const refPath = join(BENCH, 'data', clip.id, 'ref.json'), hypPath = join(RUNS, clip.id, 'hyp.json');
  if (!existsSync(refPath) || !existsSync(hypPath)) { console.error(`skip ${clip.id}: missing ${existsSync(refPath) ? 'hyp.json (run.mjs)' : 'ref.json (fetch.mjs)'}`); continue; }
  const ref = JSON.parse(readFileSync(refPath, 'utf8')), hyp = JSON.parse(readFileSync(hypPath, 'utf8'));
  const lang = clip.language;
  const rc = refCues(ref, lang);
  if (!rc) { console.error(`skip ${clip.id}: no timed reference segments`); continue; }
  const dir = join(RUNS, clip.id, 'suber');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ref.srt'), toSrt(rc));
  const systems = {};
  const docPath = join(RUNS, clip.id, 'audio.overtone.json');
  if (existsSync(docPath)) systems.captions = captionCues(JSON.parse(readFileSync(docPath, 'utf8')), lang);
  for (const s of ['overtone', 'azure', 'scribe']) if (hyp[s]) systems[s] = wordCues(hyp[s].words, lang);
  systems.textOnly = textCue(hyp.textOnly.text, ref.duration, lang); // no times: AS-WER only
  const res = { clip: clip.id, cues: rc.length, systems: {} };
  for (const [s, cues] of Object.entries(systems)) {
    const file = join(dir, `${s}.srt`);
    writeFileSync(file, toSrt(cues));
    res.systems[s] = suber(file, join(dir, 'ref.srt'), s === 'textOnly' ? ['AS-WER'] : ['t-WER', 'AS-WER']);
  }
  results.push(res);
}

const f = (x) => (x === undefined ? '–' : `${x.toFixed(1)}%`);
const L = ['## t-WER and AS-WER (SubER tool)', '', '| Clip | Reference cues | System | t-WER | AS-WER |', '|---|---:|---|---:|---:|'];
for (const r of results) for (const [s, m] of Object.entries(r.systems)) L.push(`| ${r.clip} | ${r.cues} | ${LABEL[s]} | ${f(m['t-WER'])} | ${f(m['AS-WER'])} |`);
writeFileSync(join(RUNS, 'suber.json'), JSON.stringify(results, null, 1) + '\n');
writeFileSync(join(RUNS, 'suber.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
