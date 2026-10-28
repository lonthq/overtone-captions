#!/usr/bin/env node
// Downloads only the audio and references the benchmark needs (see DATASETS.md and clips.json).
//
//   node bench/fetch.mjs                 every clip in clips.json not yet fetched
//   node bench/fetch.mjs --force         fetch again even if the files exist
//   node bench/fetch.mjs --update-checksums   record new checksums instead of failing on a mismatch
//   --clips <file>       clip selection file (default bench/clips.json)
//   --checksums <file>   checksum file (default bench/checksums.json, or <dir>/checksums.X.json for
//                        --clips <dir>/clips.X.json)
//
// Per clip, in bench/data/<clip>/ (git-ignored), verified against the committed checksums:
//   audio.wav  16 kHz mono 16-bit PCM as sent to the pipeline (audio.flac with "audioFormat": "flac")
//   ref.json   words (cased, punctuated; times and speakers when the dataset has them) and segments (bootstrap units)
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { parseNlp, windowRef } from './lib/earnings22.mjs';
import { attachTimes, textGridWords } from './lib/mfa.mjs';
import { decodeToPcm } from './lib/pcm.mjs';
import { listRemoteZip, readRemoteZipEntry, readZip } from './lib/remote-zip.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const DATA = join(BENCH, 'data');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const CLIPS = resolve(flag('--clips') ?? join(BENCH, 'clips.json'));
const CHECKSUMS = resolve(flag('--checksums') ?? (flag('--clips') ? join(dirname(CLIPS), basename(CLIPS).replace(/^clips/, 'checksums')) : join(BENCH, 'checksums.json')));
if (CHECKSUMS === CLIPS) { console.error('error: pass --checksums <file> (cannot derive it from the --clips file name)'); process.exit(1); }
const args = new Set(argv);
const FORCE = args.has('--force');
const UPDATE = args.has('--update-checksums');

const AMI_AUDIO = (m) => `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${m}/audio/${m}.Mix-Headset.wav`;
const AMI_ANNOTATIONS = 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip';
const LIBRI_PC = 'https://www.openslr.org/resources/145/manifests.tar.gz';
const LIBRI_PC_SHA256 = '96d4eae2222b29b66437a21959252419bcd4762e5042e71e023790171054d1c0';
const HF_ROWS = 'https://datasets-server.huggingface.co';
const LIBRI_MFA = 'https://zenodo.org/records/2619474/files/librispeech_alignments.zip'; // Mila, CC BY 4.0
const E22_COMMIT = 'c05ab6fd8b4b627d123c922a22a39e993dd37635'; // revdotcom/speech-datasets, 2026-05-29
const E22_REF = (id) => `https://raw.githubusercontent.com/revdotcom/speech-datasets/${E22_COMMIT}/earnings22/transcripts/force_aligned_nlp_references/${id}.aligned.nlp`;
const E22_AUDIO = (id) => `https://media.githubusercontent.com/media/revdotcom/speech-datasets/${E22_COMMIT}/earnings22/media/${id}.mp3`;
// NLTK's TIMIT sample (CC BY-NC-SA), pinned to the nltk_data commit that added it; the host serves no ranges.
const TIMIT_ZIP = 'https://raw.githubusercontent.com/nltk/nltk_data/5f09e470fe339e1a119dd174ca284129a3c7a5bb/packages/corpora/timit.zip';
const TIMIT_ZIP_SHA256 = '666c6650fb054001e2e1d9aa9b1889fc46629a0081ced7049686c2a598326668';
const RATE = 16000;

let downloaded = 0;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      downloaded += buf.length;
      return buf;
    } catch (err) {
      if (attempt >= 3) throw new Error(`GET ${url.split('?')[0]} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
const getJson = async (url) => JSON.parse((await get(url)).toString('utf8'));

/** Runs ffmpeg with `input` on stdin; resolves with stdout. */
function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...args]);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim()}`))));
    p.stdin.end(input);
  });
}
const PCM_IN = ['-f', 's16le', '-ac', '1', '-ar', String(RATE), '-i', 'pipe:0'];
const flacFromPcm = (pcm) => ffmpeg([...PCM_IN, '-c:a', 'flac', '-compression_level', '8', '-f', 'flac', 'pipe:1'], pcm);
const pcmFromFlac = (flac) => ffmpeg(['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], flac);

function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const silence = (seconds) => Buffer.alloc(Math.round(seconds * RATE) * 2);

const decodeXml = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------- AMI ----------
let amiIndex;
async function amiEntry(name) {
  amiIndex ??= await listRemoteZip(AMI_ANNOTATIONS);
  const e = amiIndex.find((x) => x.name === name);
  if (!e) throw new Error(`${name} not in AMI annotations`);
  const buf = await readRemoteZipEntry(AMI_ANNOTATIONS, e);
  downloaded += e.compSize;
  return buf.toString('latin1');
}

async function fetchAmi(clip) {
  const { meeting: m, start: t0, end: t1 } = clip;
  // Only the excerpt's byte range, after the WAV header.
  const head = await get(AMI_AUDIO(m), { headers: { Range: 'bytes=0-4095' } });
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${m}: not a WAV file`);
  let p = 12, fmt, dataStart;
  while (p + 8 <= head.length) {
    const id = head.toString('ascii', p, p + 4), len = head.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: head.readUInt16LE(p + 10), rate: head.readUInt32LE(p + 12), bits: head.readUInt16LE(p + 22) };
    if (id === 'data') { dataStart = p + 8; break; }
    p += 8 + len + (len % 2);
  }
  if (!fmt || dataStart === undefined || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${m}: unexpected WAV format ${JSON.stringify(fmt)}`);
  const from = dataStart + Math.round(t0 * RATE) * 2, to = dataStart + Math.round(t1 * RATE) * 2 - 1;
  const pcm = await get(AMI_AUDIO(m), { headers: { Range: `bytes=${from}-${to}` } });

  // words.xml (times, punctuation tokens) and segments.xml (utterances) per speaker channel.
  const words = [], segments = [];
  for (const spk of ['A', 'B', 'C', 'D']) {
    const wx = await amiEntry(`words/${m}.${spk}.words.xml`);
    const elems = [];
    for (const e of wx.matchAll(/<(w|vocalsound|disfmarker|gap|pause|nonvocalsound|comment|sil)\b([^>]*?)(\/>|>([^<]*)<\/\1>)/g)) {
      const attrs = e[2];
      const id = /nite:id="([^"]+)"/.exec(attrs)?.[1];
      const st = /starttime="([\d.]+)"/.exec(attrs), en = /endtime="([\d.]+)"/.exec(attrs);
      elems.push({ tag: e[1], id, text: decodeXml((e[4] ?? '').trim()), start: st ? +st[1] : undefined, end: en ? +en[1] : undefined, punc: /punc="true"/.test(attrs), trunc: /trunc="true"/.test(attrs) });
    }
    const index = new Map(elems.map((e, i) => [e.id, i]));
    const sx = await amiEntry(`segments/${m}.${spk}.segments.xml`);
    for (const s of sx.matchAll(/<segment\b[^>]*>([\s\S]*?)<\/segment>/g)) {
      const ref = /href="[^#]+#id\(([^)]+)\)(?:\.\.id\(([^)]+)\))?"/.exec(s[1]);
      if (!ref) continue;
      const a = index.get(ref[1]), b = index.get(ref[2] ?? ref[1]);
      if (a === undefined || b === undefined) continue;
      const seg = { speaker: spk, words: [] };
      for (let i = a; i <= b; i++) {
        const e = elems[i];
        if (e.tag !== 'w' || !e.text) continue;
        if (e.punc) { // to the previous kept word of this segment
          const prev = seg.words.at(-1);
          if (prev) prev.text += e.text;
          continue;
        }
        if (e.trunc) continue; // cut-off words are not scored
        if (e.start === undefined || e.end === undefined || e.start < t0 || e.end > t1) continue;
        seg.words.push({ text: e.text, start: +(e.start - t0).toFixed(3), end: +(e.end - t0).toFixed(3), speaker: spk });
      }
      if (seg.words.length) segments.push(seg);
    }
  }
  segments.sort((x, y) => x.words[0].start - y.words[0].start);
  segments.forEach((s, i) => { for (const w of s.words) words.push({ ...w, seg: i }); });
  return {
    pcm,
    ref: {
      clip: clip.id, language: clip.language, duration: (t1 - t0), hasWordTimes: true, hasSpeakers: true,
      source: { audio: AMI_AUDIO(m), annotations: AMI_ANNOTATIONS, meeting: m, start: t0, end: t1 },
      segments: segments.map((s, i) => ({ id: i, speaker: s.speaker, start: s.words[0].start, end: s.words.at(-1).end })),
      words,
    },
  };
}

// ---------- Earnings-22 (Rev's GitHub repository, pinned to a commit) ----------
// The call's MP3 (Git LFS) is decoded whole and cut by sample, so the cut does not depend on MP3 seeking.
async function fetchEarnings22(clip) {
  const { file: id, start: t0, end: t1 } = clip;
  const all = parseNlp((await get(E22_REF(id))).toString('utf8'));
  const { words, segments } = windowRef(all, t0, t1);
  const pcm = (await decodeToPcm(await get(E22_AUDIO(id)), RATE)).subarray(Math.round(t0 * RATE) * 2, Math.round(t1 * RATE) * 2);
  if (pcm.length !== Math.round((t1 - t0) * RATE) * 2) throw new Error(`${id}: the call is shorter than ${t1} s`);
  return {
    pcm,
    ref: {
      clip: clip.id, language: clip.language, duration: t1 - t0, hasWordTimes: true, hasSpeakers: true,
      source: { audio: E22_AUDIO(id), reference: E22_REF(id), file: id, start: t0, end: t1 },
      segments, words,
    },
  };
}

// ---------- LibriSpeech-PC (text) + LibriSpeech test (audio, via the Hugging Face datasets server) ----------
async function libriPcManifest(split) {
  const tmp = join(DATA, '_dl');
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, 'librispeech-pc-manifests.tar.gz');
  const buf = await get(LIBRI_PC);
  if (sha256(buf) !== LIBRI_PC_SHA256) throw new Error('LibriSpeech-PC manifests.tar.gz checksum mismatch');
  writeFileSync(tgz, buf);
  const json = await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzOf', tgz, `${split}.json`]);
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error('tar failed'))));
  });
  rmSync(tgz);
  return json.trim().split('\n').map((l) => JSON.parse(l));
}

// Word times ("wordTimes": "mfa"): Montreal Forced Aligner TextGrids, read from a 623 MB zip by range requests.
let mfaIndex;
async function mfaWords(split, id) {
  mfaIndex ??= await listRemoteZip(LIBRI_MFA);
  const [spk, chapter] = id.split('-');
  const name = `${split}/${spk}/${chapter}/${id}.TextGrid`;
  const e = mfaIndex.find((x) => x.name === name);
  if (!e) throw new Error(`${name} not in the LibriSpeech alignments`);
  downloaded += e.compSize;
  return textGridWords((await readRemoteZipEntry(LIBRI_MFA, e)).toString('utf8'));
}

async function fetchLibri(clip) {
  const manifest = await libriPcManifest(clip.split);
  const ids = [];
  for (let u = clip.first; u <= clip.last; u++) ids.push(`${clip.speaker}-${clip.chapter}-${String(u).padStart(4, '0')}`);
  const pcText = new Map(manifest.map((r) => [r.audio_filepath.split('/').pop().replace('.flac', ''), r.text]));
  // Row order is fixed per dataset revision; the ids are checked below, so a changed order fails loudly.
  const config = clip.hfConfig ?? 'clean';
  const url = `${HF_ROWS}/rows?dataset=openslr/librispeech_asr&config=${config}&split=test&offset=${clip.hfRowOffset}&length=${ids.length}`;
  const rows = new Map((await getJson(url)).rows.map((r) => [r.row.id, r.row]));
  const parts = [], segments = [], words = [];
  let t = 0, timedWords = 0;
  for (const [i, id] of ids.entries()) {
    const row = rows.get(id), text = pcText.get(id);
    if (!row) throw new Error(`${id} not found on the datasets server`);
    if (!text) throw new Error(`${id} not in LibriSpeech-PC ${clip.split}`);
    const pcm = await decodeToPcm(await get(row.audio[0].src), RATE);
    if (i > 0) { parts.push(silence(clip.gap)); t += clip.gap; }
    const dur = pcm.length / 2 / RATE;
    segments.push({ id: i, utterance: id, speaker: 'A', start: +t.toFixed(3), end: +(t + dur).toFixed(3) });
    const uttWords = text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, speaker: 'A', seg: i }));
    if (clip.wordTimes === 'mfa') timedWords += attachTimes(uttWords, await mfaWords(clip.split, id), t);
    words.push(...uttWords);
    parts.push(pcm);
    t += dur;
  }
  if (clip.wordTimes === 'mfa') console.log(`${clip.id}: word times for ${timedWords} of ${words.length} reference words`);
  return {
    pcm: Buffer.concat(parts),
    ref: {
      clip: clip.id, language: clip.language, duration: +t.toFixed(3), hasWordTimes: clip.wordTimes === 'mfa', hasSpeakers: false,
      source: { text: LIBRI_PC, textField: 'text', audio: `huggingface.co/datasets/openslr/librispeech_asr (${config}/test)`, utterances: ids, gap: clip.gap, ...(clip.wordTimes === 'mfa' ? { wordTimes: LIBRI_MFA } : {}) },
      segments, words,
    },
  };
}

// ---------- FLEURS (Hugging Face datasets server) ----------
// The server cannot serve the larger configs (de_de, es_419), so `"archive": true` streams the start of
// audio/<split>.tar.gz (member order = row order, checked on nl_nl) plus <split>.tsv. `revision` pins the commit.
const FLEURS_RAW = (rev, path) => `https://huggingface.co/datasets/google/fleurs/resolve/${rev}/data/${path}`;
async function fleursRowsFromArchive(clip) {
  const rev = clip.revision ?? 'main';
  const tsv = (await get(FLEURS_RAW(rev, `${clip.config}/${clip.split}.tsv`))).toString('utf8');
  const meta = new Map(tsv.split('\n').filter(Boolean).map((l) => l.split('\t')).map((c) => [c[1], { id: Number(c[0]), raw_transcription: c[2] }]));
  const need = clip.firstRow + clip.count, members = [];
  const ctrl = new AbortController();
  const res = await fetch(FLEURS_RAW(rev, `${clip.config}/audio/${clip.split}.tar.gz`), { signal: ctrl.signal });
  if (!res.ok) throw new Error(`FLEURS archive: HTTP ${res.status}`);
  const gunzip = createGunzip();
  let compressed = 0;
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0), done = false;
  gunzip.on('data', (chunk) => { if (done) return; buf = Buffer.concat([buf, chunk]); if (parseTar()) done = true; });
  gunzip.on('error', () => {}); // destroyed on purpose
  function parseTar() { // true once `need` wav files are collected
    while (buf.length >= 512) {
      const h = buf.subarray(0, 512);
      if (h.every((b) => b === 0)) return true; // end of archive
      const name = (h.toString('utf8', 345, 500).replace(/\0.*$/s, '') ? h.toString('utf8', 345, 500).replace(/\0.*$/s, '') + '/' : '') + h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
      const total = 512 + Math.ceil(size / 512) * 512;
      if (buf.length < total) return false;
      if (type === '0' && name.endsWith('.wav')) members.push({ file: name.split('/').pop(), data: Buffer.from(buf.subarray(512, 512 + size)) });
      buf = buf.subarray(total);
      if (members.length >= need) return true;
    }
    return false;
  }
  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) { await new Promise((r) => { gunzip.once('end', r); gunzip.end(); }); break; }
    compressed += value.length;
    if (!gunzip.write(value)) await new Promise((r) => gunzip.once('drain', r));
    await new Promise((r) => setImmediate(r)); // let the 'data' handler run
  }
  ctrl.abort(); gunzip.destroy();
  downloaded += compressed;
  if (members.length < need) throw new Error(`FLEURS archive: only ${members.length} audio files, need ${need}`);
  return members.slice(clip.firstRow, need).map(({ file, data }) => {
    const m = meta.get(file);
    if (!m) throw new Error(`FLEURS archive: ${file} not in ${clip.split}.tsv`);
    return { id: m.id, path: file, raw_transcription: m.raw_transcription, wav: data };
  });
}

async function fetchFleurs(clip) {
  const url = `${HF_ROWS}/rows?dataset=google/fleurs&config=${clip.config}&split=${clip.split}&offset=${clip.firstRow}&length=${clip.count}`;
  const rows = clip.archive ? await fleursRowsFromArchive(clip) : (await getJson(url)).rows.map((r) => r.row);
  if (rows.length !== clip.count) throw new Error(`FLEURS: expected ${clip.count} rows, got ${rows.length}`);
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('FLEURS: duplicate sentence ids in the selected rows');
  const parts = [], segments = [], words = [];
  let t = 0;
  for (const [i, row] of rows.entries()) {
    const pcm = await decodeToPcm(row.wav ?? await get(row.audio[0].src), RATE);
    if (i > 0) { parts.push(silence(clip.gap)); t += clip.gap; }
    const dur = pcm.length / 2 / RATE;
    segments.push({ id: i, fleursId: row.id, file: row.path.split('/').pop(), start: +t.toFixed(3), end: +(t + dur).toFixed(3) });
    for (const w of row.raw_transcription.split(/\s+/).filter(Boolean)) words.push({ text: w, seg: i });
    parts.push(pcm);
    t += dur;
  }
  return {
    pcm: Buffer.concat(parts),
    ref: {
      clip: clip.id, language: clip.language, duration: +t.toFixed(3), hasWordTimes: false, hasSpeakers: false,
      source: { dataset: 'huggingface.co/datasets/google/fleurs', config: clip.config, split: clip.split, rows: [clip.firstRow, clip.firstRow + clip.count - 1], textField: 'raw_transcription', gap: clip.gap, ...(clip.archive ? { via: `raw archive data/${clip.config}/audio/${clip.split}.tar.gz + ${clip.split}.tsv`, revision: clip.revision ?? 'main' } : {}) },
      segments, words,
    },
  };
}

// ---------- Non-speech clips (clips.nonspeech.json) ----------
// `synthetic`: an ffmpeg lavfi source, `seconds` long; deterministic (fixed noise seed).
async function fetchSynthetic(clip) {
  const pcm = await ffmpeg(['-f', 'lavfi', '-i', clip.lavfi, '-t', String(clip.seconds), '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], Buffer.alloc(0));
  return { pcm, ref: nonSpeechRef(clip, pcm, { lavfi: clip.lavfi }) };
}

// `commons`: a Wikimedia Commons file (`url`, `sha1` as Commons lists it), decoded whole.
async function fetchCommons(clip) {
  const buf = await get(clip.url, { headers: { 'User-Agent': 'overtone-bench/0.1 (benchmark fetch script)' } });
  const sha1 = createHash('sha1').update(buf).digest('hex');
  if (sha1 !== clip.sha1) throw new Error(`${clip.url.split('/').pop()}: sha1 ${sha1}, expected ${clip.sha1}`);
  const pcm = await decodeToPcm(buf, RATE);
  return { pcm, ref: nonSpeechRef(clip, pcm, { url: clip.url, sha1 }) };
}

function nonSpeechRef(clip, pcm, source) {
  return { clip: clip.id, language: clip.language, duration: +(pcm.length / 2 / RATE).toFixed(3), hasWordTimes: false, hasSpeakers: false, nonSpeech: true, source, segments: [], words: [] };
}

// `concat`: fetched clips joined, `parts` [{ clip, start?, end? }] (seconds); `speechStart` is the first speech part.
function readClipPcm(id) {
  const dir = join(DATA, id);
  if (existsSync(join(dir, 'audio.flac'))) return pcmFromFlac(readFileSync(join(dir, 'audio.flac')));
  if (existsSync(join(dir, 'audio.wav'))) return readFileSync(join(dir, 'audio.wav')).subarray(44);
  throw new Error(`bench/data/${id} is missing; fetch that clip first`);
}
async function fetchConcat(clip) {
  const parts = [], segments = [], words = [];
  let t = 0, speechStart;
  for (const part of clip.parts) {
    const all = await readClipPcm(part.clip);
    const ref = JSON.parse(readFileSync(join(DATA, part.clip, 'ref.json'), 'utf8'));
    const from = part.start ?? 0, to = part.end ?? all.length / 2 / RATE;
    const pcm = all.subarray(Math.round(from * RATE) * 2, Math.round(to * RATE) * 2);
    if (!ref.nonSpeech) {
      if (from !== 0 || part.end !== undefined) throw new Error(`${clip.id}: a speech part must be a whole clip`);
      speechStart ??= +t.toFixed(3);
      const base = segments.length;
      for (const s of ref.segments) segments.push({ ...s, id: base + s.id, start: +(s.start + t).toFixed(3), end: +(s.end + t).toFixed(3) });
      for (const w of ref.words) words.push({ ...w, seg: base + w.seg });
    }
    parts.push(pcm);
    t += pcm.length / 2 / RATE;
  }
  return {
    pcm: Buffer.concat(parts),
    ref: { clip: clip.id, language: clip.language, duration: +t.toFixed(3), hasWordTimes: false, hasSpeakers: false, speechStart, source: { parts: clip.parts }, segments, words },
  };
}

// ---------- TIMIT sample (NLTK) ----------
// `speakers`: TIMIT folders ("dr1-fvmh0"), 10 sentences each, joined with `gap` s of silence. Word times come from the
// .wrd files (samples at 16 kHz, hand-verified by LDC): the one set with human-checked word times.
let timitFiles;

/** Joins the separately timed parts of hyphenated words ("Twenty-two"); unchanged when the part counts don't add up. */
function joinHyphenParts(text, timed) {
  const sizes = text.map((w) => w.split('-').filter((p) => /[\p{L}\p{N}]/u.test(p)).length || 1);
  if (sizes.reduce((a, b) => a + b, 0) !== timed.length) return timed;
  let k = 0;
  return sizes.map((n) => {
    const group = timed.slice(k, (k += n));
    return { text: group.map((g) => g.text).join('-'), start: group[0].start, end: group.at(-1).end };
  });
}

async function fetchTimit(clip) {
  if (!timitFiles) {
    const zip = await get(TIMIT_ZIP);
    if (sha256(zip) !== TIMIT_ZIP_SHA256) throw new Error('NLTK timit.zip checksum mismatch');
    timitFiles = readZip(zip);
  }
  const file = (name) => {
    const f = timitFiles.get(`timit/${name}`);
    if (!f) throw new Error(`timit/${name} is not in the NLTK sample`);
    return f;
  };
  const parts = [], segments = [], words = [];
  let t = 0, timedWords = 0;
  for (const speaker of clip.speakers) {
    const sentences = [...timitFiles.keys()].filter((n) => n.startsWith(`timit/${speaker}/`) && n.endsWith('.wav')).map((n) => n.slice(`timit/${speaker}/`.length, -4)).sort();
    if (sentences.length !== 10) throw new Error(`timit/${speaker}: ${sentences.length} sentences, expected 10`);
    for (const sentence of sentences) {
      const pcm = await decodeToPcm(file(`${speaker}/${sentence}.wav`), RATE);
      if (segments.length > 0) { parts.push(silence(clip.gap)); t += clip.gap; }
      const dur = pcm.length / 2 / RATE;
      const seg = segments.length;
      segments.push({ id: seg, utterance: `${speaker}/${sentence}`, speaker, start: +t.toFixed(3), end: +(t + dur).toFixed(3) });
      // "0 54682 She had your dark suit in greasy wash water all year."
      const text = file(`${speaker}/${sentence}.txt`).toString('utf8').trim().split(/\s+/).slice(2);
      const uttWords = text.map((w) => ({ text: w, speaker, seg }));
      const timed = file(`${speaker}/${sentence}.wrd`).toString('utf8').trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([a, b, w]) => ({ text: w, start: Number(a) / RATE, end: Number(b) / RATE }));
      timedWords += attachTimes(uttWords, joinHyphenParts(text, timed), t);
      words.push(...uttWords);
      parts.push(pcm);
      t += dur;
    }
  }
  console.log(`${clip.id}: word times for ${timedWords} of ${words.length} reference words`);
  return {
    pcm: Buffer.concat(parts),
    ref: {
      clip: clip.id, language: clip.language, duration: +t.toFixed(3), hasWordTimes: true, hasSpeakers: true,
      source: { zip: TIMIT_ZIP, zipSha256: TIMIT_ZIP_SHA256, speakers: clip.speakers, gap: clip.gap, wordTimes: 'TIMIT .wrd (hand-verified)' },
      segments, words,
    },
  };
}

const FETCHERS = { ami: fetchAmi, 'librispeech-pc': fetchLibri, fleurs: fetchFleurs, earnings22: fetchEarnings22, synthetic: fetchSynthetic, commons: fetchCommons, concat: fetchConcat, 'timit-nltk': fetchTimit };

async function main() {
  const { clips, audioFormat = 'wav' } = JSON.parse(readFileSync(CLIPS, 'utf8'));
  if (!['wav', 'flac'].includes(audioFormat)) throw new Error(`audioFormat must be wav or flac, not ${audioFormat}`);
  const sums = existsSync(CHECKSUMS) ? JSON.parse(readFileSync(CHECKSUMS, 'utf8')) : {};
  let failed = false;
  for (const clip of clips) {
    const dir = join(DATA, clip.id);
    const audioPath = join(dir, `audio.${audioFormat}`), refPath = join(dir, 'ref.json');
    const verify = async () => {
      const file = readFileSync(audioPath), ref = readFileSync(refPath);
      const pcm = audioFormat === 'flac' ? await pcmFromFlac(file) : file.subarray(44);
      return { audioPcmSha256: sha256(pcm), refSha256: sha256(ref), seconds: +(pcm.length / 2 / RATE).toFixed(3) };
    };
    if (!FORCE && existsSync(audioPath) && existsSync(refPath)) {
      const got = await verify(), want = sums[clip.id];
      const ok = want && want.audioPcmSha256 === got.audioPcmSha256 && want.refSha256 === got.refSha256;
      if (ok || (!want && !UPDATE)) { console.log(`${clip.id}: present${ok ? ' (checksums ok)' : ''}`); if (!want) sums[clip.id] = got; continue; }
      if (!UPDATE) console.log(`${clip.id}: checksum mismatch, fetching again`);
    }
    console.log(`${clip.id}: fetching (${clip.source})`);
    const { pcm, ref } = await FETCHERS[clip.source](clip);
    mkdirSync(dir, { recursive: true });
    writeFileSync(audioPath, audioFormat === 'flac' ? await flacFromPcm(pcm) : wavFromPcm(pcm));
    writeFileSync(refPath, JSON.stringify(ref, null, 1) + '\n');
    const got = await verify(), want = sums[clip.id];
    if (want && !UPDATE && (want.audioPcmSha256 !== got.audioPcmSha256 || want.refSha256 !== got.refSha256)) {
      console.error(`${clip.id}: CHECKSUM MISMATCH (expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}); the source may have changed. Re-run with --update-checksums to accept.`);
      failed = true;
    } else sums[clip.id] = got;
    console.log(`${clip.id}: ${got.seconds.toFixed(1)} s audio, ${ref.words.length} reference words, ${ref.segments.length} segments`);
  }
  rmSync(join(DATA, '_dl'), { recursive: true, force: true });
  writeFileSync(CHECKSUMS, JSON.stringify(sums, null, 2) + '\n');
  console.log(`downloaded ${(downloaded / 1e6).toFixed(1)} MB this run`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
