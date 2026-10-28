#!/usr/bin/env node
// Live runs of the caption readability benchmark: the systems that need an API call (see README.md).
//
//   overtone    the Overtone CLI with its defaults (OpenAI text, Azure Speech timing, OpenAI LLM), run as a black
//               box: `overtone transcribe audio.wav --context "<clip context>"`; it writes .overtone.json, VTT and SRT
//   elevenlabs  ElevenLabs speech-to-text (scribe_v2) with its built-in SRT export, in one request: 42 × 2
//               (horizontal), 22 × 2 (vertical) and 42 × 2 with Overtone's cue limits (horizontal-7s)
//
//   node bench/captions/run.mjs                    every clip and system; skips outputs that already exist
//   node bench/captions/run.mjs --fresh            run again (new, billable API calls; Overtone ignores its cache)
//   node bench/captions/run.mjs --clip <id>        only this clip (repeatable)
//   node bench/captions/run.mjs --system <name>    only this system: overtone | elevenlabs (repeatable)
//   node bench/captions/run.mjs --repeat <name>    an extra Overtone run into runs/<clip>/overtone-<name>/ that reuses
//                                                  the cached transcription and timing (--from-stage refine), so only
//                                                  the LLM steps run again: shows the run-to-run variation of the LLM
//   node bench/captions/run.mjs --refine           Overtone again into runs/<clip>/overtone/ on the cached transcription
//                                                  and timing (--from-stage refine): only the LLM steps run again, e.g.
//                                                  after a change to the line cutting or its prompt
//   node bench/captions/run.mjs --llm-linebreaks   pass --llm-linebreaks to Overtone (the optional LLM line cutting; the
//                                                  stored runs of 2026-10-18 used it, as it was the default then)
//
// Must run from the repository root (the CLI reads .env from the current directory). Keys come from .env and are
// never printed or written. Up to 3 runs go in parallel. Output: bench/captions/data/runs/<clip>/<system>/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from '../lib/env.mjs';
import { meterSummary } from '../lib/meter-summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CLI = join(ROOT, 'packages/cli/dist/cli.js');
const RUNS = join(HERE, 'data/runs');
const CONFIG = join(HERE, 'overtone.captions.json');
const PARALLEL = 3;
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_MODEL = 'scribe_v2';
/**
 * SRT exports requested from ElevenLabs (all from one transcription). 42 characters per line and 84 per cue are its
 * defaults; the other options (cue at most 4 s, new cue after a silence of 0.8 s) are left at their defaults.
 * horizontal-7s is a tuned variant with the same limits as Overtone's profile (cues up to 7 s, new cue after 1 s).
 */
const ELEVENLABS_SRT = {
  horizontal: { format: 'srt', max_characters_per_line: 42, max_segment_chars: 84 },
  vertical: { format: 'srt', max_characters_per_line: 22, max_segment_chars: 44 },
  'horizontal-7s': { format: 'srt', max_characters_per_line: 42, max_segment_chars: 84, max_segment_duration_s: 7, segment_on_silence_longer_than_s: 1 },
};

const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const pick = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const onlyClips = pick('--clip');
const onlySystems = pick('--system');
const repeat = pick('--repeat')[0];
const refine = argv.includes('--refine');
const llmLinebreaks = argv.includes('--llm-linebreaks');
if (repeat !== undefined && !/^[\w-]+$/.test(repeat)) { console.error('error: --repeat takes a name of letters, digits, "_" or "-"'); process.exit(1); }
const want = (system) => (repeat || refine ? system === 'overtone' : !onlySystems.length || onlySystems.includes(system));

if (process.cwd() !== ROOT) { console.error(`error: run from the repository root (${ROOT})`); process.exit(1); }
const { clips } = JSON.parse(readFileSync(join(HERE, 'clips.json'), 'utf8'));
const rel = (p) => relative(ROOT, p);

function runOvertone(clip, audio, outDir) {
  const meter = join(outDir, 'meter.jsonl');
  writeFileSync(meter, '');
  const args = ['transcribe', rel(audio), '--context', clip.context, '--export', 'json,vtt,srt', '--out', rel(outDir),
    '--config', rel(CONFIG), ...(llmLinebreaks ? ['--llm-linebreaks'] : []), ...(repeat || refine ? ['--from-stage', 'refine'] : fresh ? ['--no-cache'] : [])];
  console.error(`[${clip.id}] overtone: node packages/cli/dist/cli.js ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  return new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--import', join(ROOT, 'bench/lib/meter.mjs'), CLI, ...args],
      { cwd: ROOT, env: { ...process.env, BENCH_METER_FILE: meter } });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => {
      writeFileSync(join(outDir, 'cli.log'), log);
      const seconds = (Date.now() - t0) / 1000;
      writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ system: 'overtone', code, seconds, args, usage: meterSummary(meter) }, null, 2)}\n`);
      console.error(`[${clip.id}] overtone: ${code === 0 ? 'done' : `FAILED (exit ${code}, see ${rel(join(outDir, 'cli.log'))})`} in ${seconds.toFixed(0)} s`);
      done(code === 0);
    });
  });
}

async function runElevenLabs(clip, audio, outDir) {
  const key = envVar(ROOT, 'ELEVENLABS_API_KEY');
  if (!key) { console.error(`[${clip.id}] elevenlabs: ELEVENLABS_API_KEY is not set; skipped`); return false; }
  console.error(`[${clip.id}] elevenlabs: POST ${ELEVENLABS_URL} (model ${ELEVENLABS_MODEL})`);
  const form = new FormData();
  form.append('model_id', ELEVENLABS_MODEL);
  form.append('file', new Blob([readFileSync(audio)], { type: 'audio/wav' }), 'audio.wav');
  form.append('timestamps_granularity', 'word');
  form.append('diarize', 'true');
  // the systems are compared on speech; event tags such as "(music)" would add words only ElevenLabs has
  form.append('tag_audio_events', 'false');
  form.append('additional_formats', JSON.stringify(Object.values(ELEVENLABS_SRT)));
  const t0 = Date.now();
  let res;
  for (let attempt = 1; !res; attempt++) {
    // one retry on a network error (a dropped connection, not an HTTP error status)
    try { res = await fetch(ELEVENLABS_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: form }); } catch (err) {
      if (attempt >= 2) throw err;
      console.error(`[${clip.id}] elevenlabs: ${err.message}; retrying once`);
    }
  }
  const text = await res.text();
  const seconds = (Date.now() - t0) / 1000;
  if (!res.ok) {
    console.error(`[${clip.id}] elevenlabs: FAILED HTTP ${res.status}: ${text.slice(0, 300)}`);
    return false;
  }
  const body = JSON.parse(text);
  writeFileSync(join(outDir, 'response.json'), `${JSON.stringify(body, null, 2)}\n`);
  const formats = body.additional_formats ?? [];
  Object.keys(ELEVENLABS_SRT).forEach((profile, k) => {
    const f = formats[k];
    if (!f) throw new Error(`ElevenLabs returned ${formats.length} additional formats, expected ${Object.keys(ELEVENLABS_SRT).length}`);
    writeFileSync(join(outDir, `${profile}.srt`), f.is_base64_encoded ? Buffer.from(f.content, 'base64') : f.content);
  });
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ system: 'elevenlabs', model: ELEVENLABS_MODEL, seconds, exports: ELEVENLABS_SRT }, null, 2)}\n`);
  console.error(`[${clip.id}] elevenlabs: done in ${seconds.toFixed(0)} s`);
  return true;
}

const jobs = [];
for (const clip of clips) {
  if (onlyClips.length && !onlyClips.includes(clip.id)) continue;
  const audio = join(HERE, 'data', clip.id, 'audio.wav');
  if (!existsSync(audio)) { console.error(`error: ${rel(audio)} is missing; run \`node bench/captions/fetch.mjs\` first`); process.exit(1); }
  for (const [system, run, marker] of [['overtone', runOvertone, 'audio.overtone.json'], ['elevenlabs', runElevenLabs, 'horizontal.srt']]) {
    if (!want(system)) continue;
    const outDir = join(RUNS, clip.id, repeat ? `${system}-${repeat}` : system);
    if (!fresh && !refine && existsSync(join(outDir, marker))) { console.error(`[${clip.id}] ${system}: output exists, skipped (--fresh to rerun)`); continue; }
    mkdirSync(outDir, { recursive: true });
    jobs.push(() => run(clip, audio, outDir).catch((err) => { console.error(`[${clip.id}] ${system}: FAILED: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`); return false; }));
  }
}

let ok = true;
const queue = [...jobs];
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
  while (queue.length) ok = (await queue.shift()()) && ok;
}));
if (!ok) process.exit(1);
